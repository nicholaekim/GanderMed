import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest } from "@/lib/auth";
import { revokeGrant, type GrantRow } from "@/lib/access";
import { activeMembership, isManagement } from "@/lib/org";

type Ctx = { params: Promise<{ id: string }> };

// Clinician-side removal. Individual grants: self only (unchanged). Org
// PENDING requests: the requester or any owner/admin may withdraw. Org
// ACTIVE grants: management tier only — it destroys access for the whole
// org, so a requester without management standing gets a 403.
export async function DELETE(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const grantId = Number(id);
  if (!Number.isInteger(grantId)) return NextResponse.json({ error: "Bad id." }, { status: 400 });

  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (user.role !== "clinician") {
    return NextResponse.json({ error: "Care-team accounts only." }, { status: 403 });
  }

  const grant = db.prepare("SELECT * FROM access_grants WHERE id = ?").get(grantId) as
    | (GrantRow & { requested_by_user_id: number })
    | undefined;
  if (!grant || !["pending", "active"].includes(grant.status)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  if (grant.organization_id == null) {
    const ok = revokeGrant(db, user.id, grantId, { clinicianUserId: user.id });
    if (!ok) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  const membership = activeMembership(db, user.id);
  if (!membership || membership.organization_id !== grant.organization_id) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const management = isManagement(membership.org_role);
  if (grant.status === "pending") {
    if (grant.requested_by_user_id !== user.id && !management) {
      return NextResponse.json({ error: "Only the requester or an owner/admin can withdraw this request." }, { status: 403 });
    }
  } else if (!management) {
    return NextResponse.json(
      { error: "Only an owner or admin can give up the organization's access to a patient." },
      { status: 403 }
    );
  }
  const ok = revokeGrant(db, user.id, grantId, { organizationId: membership.organization_id });
  if (!ok) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
