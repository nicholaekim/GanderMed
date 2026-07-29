import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest } from "@/lib/auth";
import { logAudit } from "@/lib/access";
import { activeMembership, canReview, getOrg } from "@/lib/org";
import type { Alert } from "@/lib/types";

const VALID_DAYS = new Set([30, 90, 180]);

// Clinicians only: record that this exact combination was professionally
// reviewed. This is the one deliberate write a care-team account has — it
// annotates, it does not modify the patient's record.
export async function POST(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (user.role !== "clinician") {
    return NextResponse.json({ error: "Only care-team accounts can review alerts." }, { status: 403 });
  }

  let body: { alert_id?: number; note?: string; expires_days?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const alertId = Number(body.alert_id);
  const note = body.note?.trim() ?? "";
  const days = Number(body.expires_days);
  if (!Number.isInteger(alertId)) return NextResponse.json({ error: "alert_id required." }, { status: 400 });
  if (note.length < 5) return NextResponse.json({ error: "Write a short review note (what was decided and why)." }, { status: 400 });
  if (!VALID_DAYS.has(days)) return NextResponse.json({ error: "expires_days must be 30, 90, or 180." }, { status: 400 });

  const alert = db.prepare("SELECT * FROM alerts WHERE id = ?").get(alertId) as unknown as Alert | undefined;
  if (!alert) return NextResponse.json({ error: "Alert not found." }, { status: 404 });

  // The ONE org authorization decision outside resolveProfileAccess (this
  // route takes alert_id, not ?patient=). Membership is checked per request:
  // a deactivated member cannot ride the org grant, even if they were the
  // original requester. Individual candidates first for attribution.
  // expires_at values are JS ISO strings — compare against an ISO now, not
  // datetime('now') (different format).
  const membership = activeMembership(db, user.id);
  const grant = db
    .prepare(
      `SELECT id, organization_id FROM access_grants
       WHERE profile_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)
         AND ((organization_id IS NULL AND clinician_user_id = ?)
           OR (organization_id IS NOT NULL AND organization_id = ?))
       ORDER BY organization_id IS NULL DESC LIMIT 1`
    )
    .get(alert.profile_id, new Date().toISOString(), user.id, membership?.organization_id ?? -1) as
    | { id: number; organization_id: number | null }
    | undefined;
  if (!grant) return NextResponse.json({ error: "No active patient-approved access for this record." }, { status: 403 });

  // Reviews are clinical judgments: under org access, only pharmacists and
  // owners may write them — the management tier is not the clinical tier.
  const orgAuthored = grant.organization_id != null;
  if (orgAuthored && (!membership || !canReview(membership.org_role))) {
    return NextResponse.json(
      { error: "Alert reviews require a pharmacist or owner account in your organization." },
      { status: 403 }
    );
  }
  const reviewerClinic = orgAuthored ? (getOrg(db, grant.organization_id!)?.name ?? user.clinic_name) : user.clinic_name;

  db.exec("BEGIN");
  try {
    // Replace semantics: a newer review supersedes any active one for the
    // same combination (the old row stays, soft-revoked, as history).
    db.prepare(
      `UPDATE alert_reviews SET revoked_at = ?
       WHERE profile_id = ? AND kind = ? AND med_a_id = ? AND med_b_id = ?
         AND ingredient_a = ? AND ingredient_b = ? AND revoked_at IS NULL`
    ).run(
      new Date().toISOString(),
      alert.profile_id, alert.kind, alert.med_a_id, alert.med_b_id,
      alert.ingredient_a, alert.ingredient_b
    );
    const expires = new Date(Date.now() + days * 86_400_000).toISOString();
    const info = db
      .prepare(
        `INSERT INTO alert_reviews
         (profile_id, kind, ingredient_a, ingredient_b, med_a_id, med_b_id,
          reviewer_user_id, reviewer_name, reviewer_clinic, note, source_version, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        alert.profile_id, alert.kind, alert.ingredient_a, alert.ingredient_b,
        alert.med_a_id, alert.med_b_id,
        user.id, user.display_name, reviewerClinic, note, alert.source_version, expires
      );
    db.exec("COMMIT");
    const reviewId = Number(info.lastInsertRowid);
    logAudit(db, {
      actor: user.id,
      action: "review_created",
      profileId: alert.profile_id,
      targetId: reviewId,
      meta: orgAuthored ? { via: "org", org: grant.organization_id! } : undefined,
    });
    const review = db.prepare("SELECT * FROM alert_reviews WHERE id = ?").get(reviewId);
    return NextResponse.json({ review });
  } catch (e) {
    db.exec("ROLLBACK");
    console.error("Review insert failed:", e);
    return NextResponse.json({ error: "Could not save the review." }, { status: 500 });
  }
}
