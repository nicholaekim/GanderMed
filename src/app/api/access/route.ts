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
      `SELECT g.*, u.display_name AS clinician_name, u.clinic_name,
              o.name AS organization_name, o.verification_status AS org_verification_status,
              ol.label AS location_label, ol.status AS location_status,
              ru.display_name AS requested_by_name,
              (SELECT COUNT(*) FROM organization_members m
                WHERE m.user_id = g.requested_by_user_id AND m.organization_id = g.organization_id AND m.status = 'active') AS requester_active,
              (CASE WHEN g.organization_id IS NOT NULL THEN
                EXISTS (SELECT 1 FROM access_grants ig
                        JOIN organization_members im ON im.user_id = ig.clinician_user_id
                          AND im.organization_id = g.organization_id AND im.status = 'active'
                        WHERE ig.profile_id = g.profile_id AND ig.organization_id IS NULL AND ig.status = 'active')
              ELSE
                EXISTS (SELECT 1 FROM access_grants og
                        JOIN organization_members om ON om.organization_id = og.organization_id
                          AND om.user_id = g.clinician_user_id AND om.status = 'active'
                        WHERE og.profile_id = g.profile_id AND og.organization_id IS NOT NULL AND og.status = 'active')
              END) AS overlap
       FROM access_grants g
       JOIN users u ON u.id = g.clinician_user_id
       LEFT JOIN organizations o ON o.id = g.organization_id
       LEFT JOIN organization_locations ol ON ol.id = g.location_id
       LEFT JOIN users ru ON ru.id = g.requested_by_user_id
       WHERE g.profile_id = ?
       ORDER BY g.requested_at DESC`
    )
    .all(user.profile_id) as unknown as (GrantRow & { clinician_name: string; clinic_name: string | null })[];
  for (const g of grants) {
    const swept = sweepExpiry(db, g);
    g.status = swept;
  }

  // The activity feed resolves org ids in meta so record-open rows can say
  // "via <Org> (unverified)" — ids only in storage, names only at render.
  const audit = db
    .prepare(
      `SELECT a.at, a.action, a.meta, u.display_name AS actor_name, u.clinic_name AS actor_clinic
       FROM audit_events a
       LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE a.profile_id = ?
       ORDER BY a.at DESC, a.id DESC
       LIMIT 25`
    )
    .all(user.profile_id) as unknown as { at: string; action: string; meta: string | null; actor_name: string | null; actor_clinic: string | null }[];
  const orgName = db.prepare("SELECT name, verification_status FROM organizations WHERE id = ?");
  const auditView = audit.map((a) => {
    let via_org: string | null = null;
    if (a.meta) {
      try {
        const meta = JSON.parse(a.meta) as { org?: number };
        if (meta.org) {
          const o = orgName.get(meta.org) as { name: string; verification_status: string } | undefined;
          if (o) via_org = o.verification_status === "verified" ? o.name : `${o.name} (unverified)`;
        }
      } catch {
        // meta unparseable — render without org context
      }
    }
    return { at: a.at, action: a.action, actor_name: a.actor_name, actor_clinic: a.actor_clinic, via_org };
  });

  return NextResponse.json({ grants, audit: auditView });
}
