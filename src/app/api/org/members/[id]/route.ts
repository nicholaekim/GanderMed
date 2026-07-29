// Member management (owner/admin): deactivate | set_role.
// Owner targets and owner-role changes are owner-only; the LAST active owner
// can never be deactivated or demoted (succession first). Deactivation never
// mutates grants — enforcement is the per-request membership check, so the
// ex-member's next read fails closed.

import { NextResponse } from "next/server";
import { logAudit } from "@/lib/access";
import { countActiveOwners, ORG_ROLES, type OrgRole } from "@/lib/org";
import { requireOrgManagement } from "../../helpers";

type Ctx = { params: Promise<{ id: string }> };

interface MemberRow {
  id: number;
  organization_id: number;
  user_id: number;
  org_role: OrgRole;
  status: "active" | "deactivated";
}

export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const memberId = Number(id);
  if (!Number.isInteger(memberId)) return NextResponse.json({ error: "Bad id." }, { status: 400 });

  const auth = requireOrgManagement(request);
  if ("fail" in auth) return auth.fail;
  const { db, user, membership, org } = auth;

  const target = db
    .prepare("SELECT id, organization_id, user_id, org_role, status FROM organization_members WHERE id = ?")
    .get(memberId) as MemberRow | undefined;
  if (!target || target.organization_id !== org.id || target.status !== "active") {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  let body: { action?: string; org_role?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (body.action === "deactivate") {
    if (target.org_role === "owner" && membership.org_role !== "owner") {
      return NextResponse.json({ error: "Only an owner can deactivate an owner." }, { status: 403 });
    }
    if (target.org_role === "owner" && countActiveOwners(db, org.id) <= 1) {
      return NextResponse.json({ error: "Promote another owner first — an organization needs at least one." }, { status: 409 });
    }
    db.prepare(
      "UPDATE organization_members SET status = 'deactivated', deactivated_at = datetime('now'), deactivated_by_user_id = ? WHERE id = ? AND status = 'active'"
    ).run(user.id, memberId);
    logAudit(db, {
      actor: user.id,
      action: "org_member_deactivated",
      targetId: memberId,
      meta: { org: org.id, member_user: target.user_id },
    });
    // Invites minted by OTHERS stay live; surface the count so management
    // reviews them (the deactivated member's own invites die lazily).
    const openInvites = (
      db
        .prepare("SELECT COUNT(*) AS n FROM staff_invitations WHERE organization_id = ? AND status = 'created'")
        .get(org.id) as { n: number }
    ).n;
    return NextResponse.json({ ok: true, open_invite_count: openInvites });
  }

  if (body.action === "set_role") {
    const newRole = body.org_role as OrgRole;
    if (!ORG_ROLES.includes(newRole)) {
      return NextResponse.json({ error: `org_role must be one of: ${ORG_ROLES.join(", ")}.` }, { status: 400 });
    }
    if ((newRole === "owner" || target.org_role === "owner") && membership.org_role !== "owner") {
      return NextResponse.json({ error: "Only an owner can change owner roles." }, { status: 403 });
    }
    if (target.org_role === "owner" && newRole !== "owner" && countActiveOwners(db, org.id) <= 1) {
      return NextResponse.json({ error: "Promote another owner first — an organization needs at least one." }, { status: 409 });
    }
    db.prepare("UPDATE organization_members SET org_role = ? WHERE id = ?").run(newRole, memberId);
    logAudit(db, {
      actor: user.id,
      action: "org_member_role_changed",
      targetId: memberId,
      meta: { org: org.id, member_user: target.user_id, role: newRole },
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "action must be 'deactivate' or 'set_role'." }, { status: 400 });
}
