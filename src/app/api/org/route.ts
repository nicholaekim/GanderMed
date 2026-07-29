// Organization bootstrap + context.
// POST — a clinician with NO membership creates an org (born with one
//        location, creator becomes 'owner') in one transaction.
// GET  — the caller's org context; open staff invites only for owner/admin.

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest } from "@/lib/auth";
import { logAudit } from "@/lib/access";
import { activeMembership, isManagement } from "@/lib/org";
import { allowRequest, clientIp } from "@/lib/ratelimit";

export async function GET(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (user.role !== "clinician") return NextResponse.json({ error: "Care-team accounts only." }, { status: 403 });

  const membership = activeMembership(db, user.id);
  if (!membership) return NextResponse.json({ organization: null });

  const org = db
    .prepare("SELECT id, name, verification_status, created_at FROM organizations WHERE id = ?")
    .get(membership.organization_id) as { id: number; name: string; verification_status: string; created_at: string };
  const locations = db
    .prepare("SELECT id, label, address, status FROM organization_locations WHERE organization_id = ? ORDER BY id")
    .all(membership.organization_id);
  const members = db
    .prepare(
      `SELECT m.id, m.org_role, m.status, m.created_at, u.display_name
       FROM organization_members m JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = ? ORDER BY m.status = 'active' DESC, m.org_role, u.display_name`
    )
    .all(membership.organization_id);

  const invites = isManagement(membership.org_role)
    ? db
        .prepare(
          `SELECT si.id, si.org_role, si.invitee_label, si.status, si.expires_at, si.created_at, u.display_name AS invited_by_name
           FROM staff_invitations si JOIN users u ON u.id = si.invited_by_user_id
           WHERE si.organization_id = ? AND si.status = 'created' ORDER BY si.created_at DESC`
        )
        .all(membership.organization_id)
    : undefined;

  return NextResponse.json({
    organization: org,
    my_role: membership.org_role,
    locations,
    members,
    ...(invites !== undefined ? { open_invites: invites } : {}),
  });
}

export async function POST(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (user.role !== "clinician") {
    return NextResponse.json({ error: "Patient accounts cannot create a care organization." }, { status: 403 });
  }
  if (!allowRequest(`org-create:${clientIp(request)}`, 5, 3_600_000)) {
    return NextResponse.json({ error: "Too many attempts — try again later." }, { status: 429 });
  }
  if (activeMembership(db, user.id)) {
    return NextResponse.json({ error: "This account already belongs to an organization." }, { status: 409 });
  }

  let body: { name?: string; location_label?: string; location_address?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const name = (body.name ?? "").trim().slice(0, 120);
  const locationLabel = (body.location_label ?? "").trim().slice(0, 120);
  if (name.length < 2) return NextResponse.json({ error: "Give the organization a name." }, { status: 400 });
  if (locationLabel.length < 2) {
    return NextResponse.json({ error: "Add the first location (e.g. the pharmacy's neighbourhood or street)." }, { status: 400 });
  }

  db.exec("BEGIN");
  let orgId: number;
  try {
    orgId = Number(
      db
        .prepare("INSERT INTO organizations (name, created_by_user_id) VALUES (?, ?)")
        .run(name, user.id).lastInsertRowid
    );
    db.prepare("INSERT INTO organization_locations (organization_id, label, address) VALUES (?, ?, ?)").run(
      orgId,
      locationLabel,
      (body.location_address ?? "").trim().slice(0, 200) || null
    );
    db.prepare(
      "INSERT INTO organization_members (organization_id, user_id, org_role, status) VALUES (?, ?, 'owner', 'active')"
    ).run(orgId, user.id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    console.error("Org create failed:", e);
    return NextResponse.json({ error: "Could not create the organization." }, { status: 500 });
  }

  logAudit(db, { actor: user.id, action: "org_created", targetId: orgId });
  logAudit(db, { actor: user.id, action: "org_member_joined", targetId: orgId, meta: { via: "created", role: "owner" } });
  return NextResponse.json({ ok: true, organization_id: orgId });
}
