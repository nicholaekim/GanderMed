// Care-team access endpoints (path kept from the care-link era; semantics
// are now request/consent based). POST creates a PENDING access request from
// a patient's care code — the patient must approve it before any record
// becomes readable. GET returns the clinician's roster: active grants with
// safety stats, plus their pending/awaiting-approval requests.

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest } from "@/lib/auth";
import { normalizeShareCode } from "@/lib/auth";
import { recomputeAlerts } from "@/lib/conflicts";
import { attachReviews } from "@/lib/reviews";
import { ACCESS_PURPOSES, requestAccessByCode, sweepExpiry } from "@/lib/access";
import type { GrantRow } from "@/lib/access";

export async function GET(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (user.role !== "clinician") {
    return NextResponse.json({ error: "Care-team accounts only." }, { status: 403 });
  }

  const grants = db
    .prepare(
      `SELECT g.*, p.name AS patient_name, u.email AS patient_email
       FROM access_grants g
       JOIN profiles p ON p.id = g.profile_id
       LEFT JOIN users u ON u.id = p.user_id
       WHERE g.clinician_user_id = ? AND g.status IN ('pending','active')
       ORDER BY p.name`
    )
    .all(user.id) as unknown as (GrantRow & { patient_name: string; patient_email: string | null })[];

  const pending = [];
  const roster = [];
  for (const g of grants) {
    if (sweepExpiry(db, g) !== "active") {
      if (g.status === "pending") {
        pending.push({
          grant_id: g.id,
          patient_name: g.patient_name,
          purpose: g.purpose,
          requested_at: g.requested_at,
        });
      }
      continue;
    }
    const { all } = recomputeAlerts(db, g.profile_id);
    attachReviews(db, g.profile_id, all);
    const open = all.filter((a) => !a.acknowledged_at && !a.review);
    const activeMeds = db
      .prepare("SELECT COUNT(*) AS n FROM medications WHERE profile_id = ? AND status = 'active'")
      .get(g.profile_id) as { n: number };
    const lastEvent = db
      .prepare(
        `SELECT MAX(de.logged_at) AS last FROM dose_events de
         JOIN medications m ON m.id = de.medication_id WHERE m.profile_id = ?`
      )
      .get(g.profile_id) as { last: string | null };
    roster.push({
      grant_id: g.id,
      profile_id: g.profile_id,
      patient_name: g.patient_name,
      patient_email: g.patient_email,
      purpose: g.purpose,
      expires_at: g.expires_at,
      active_medications: activeMeds.n,
      alerts_major: open.filter((a) => a.severity === "major").length,
      alerts_moderate: open.filter((a) => a.severity === "moderate").length,
      alerts_minor: open.filter((a) => a.severity === "minor").length,
      alerts_reviewed: all.filter((a) => a.review && !a.acknowledged_at).length,
      alerts_acknowledged: all.filter((a) => a.acknowledged_at).length,
      last_dose_at: lastEvent.last,
    });
  }

  return NextResponse.json({ roster, pending });
}

export async function POST(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (user.role !== "clinician") {
    return NextResponse.json({ error: "Care-team accounts only." }, { status: 403 });
  }

  let body: { code?: string; purpose?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const code = normalizeShareCode(body.code ?? "");
  if (!code) return NextResponse.json({ error: "Care codes look like ABCD-1234." }, { status: 400 });
  const purpose = (ACCESS_PURPOSES as readonly string[]).includes(body.purpose ?? "")
    ? body.purpose!
    : "Medication review";

  const result = requestAccessByCode(db, user.id, code, purpose);
  if ("error" in result) {
    if (result.error === "already_open") {
      return NextResponse.json({ error: "You already have a pending or active request for this patient." }, { status: 409 });
    }
    return NextResponse.json({ error: "No patient found with that care code." }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    status: "pending",
    patient_name: result.patient_name,
    grant_id: result.grant.id,
  });
}
