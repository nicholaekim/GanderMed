import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest } from "@/lib/auth";
import { sweepExpiry } from "@/lib/access";
import type { GrantRow } from "@/lib/access";

// The patient's view of who can see their record: every grant in every
// state, plus the recent audit trail of access-related events.
export async function GET(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (user.role !== "patient" || user.profile_id == null) {
    return NextResponse.json({ error: "Patient accounts only." }, { status: 403 });
  }

  const grants = db
    .prepare(
      `SELECT g.*, u.display_name AS clinician_name, u.clinic_name
       FROM access_grants g
       JOIN users u ON u.id = g.clinician_user_id
       WHERE g.profile_id = ?
       ORDER BY g.requested_at DESC`
    )
    .all(user.profile_id) as unknown as (GrantRow & { clinician_name: string; clinic_name: string | null })[];
  for (const g of grants) {
    const swept = sweepExpiry(db, g);
    g.status = swept;
  }

  const audit = db
    .prepare(
      `SELECT a.at, a.action, u.display_name AS actor_name, u.clinic_name AS actor_clinic
       FROM audit_events a
       LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE a.profile_id = ?
       ORDER BY a.at DESC, a.id DESC
       LIMIT 25`
    )
    .all(user.profile_id);

  return NextResponse.json({ grants, audit });
}
