// Mint a staff join link (owner/admin only). The raw token is returned
// exactly once; only its sha256 hash is stored. 'owner' is never mintable —
// ownership arises from org creation or set_role promotion.

import { NextResponse } from "next/server";
import { logAudit } from "@/lib/access";
import { INVITABLE_ROLES, mintStaffInvite, type OrgRole } from "@/lib/org";
import { allowRequest, clientIp } from "@/lib/ratelimit";
import { requireOrgManagement } from "../helpers";

export async function POST(request: Request) {
  const auth = requireOrgManagement(request);
  if ("fail" in auth) return auth.fail;
  const { db, user, org } = auth;

  if (!allowRequest(`staff-invite:${clientIp(request)}`, 20, 3_600_000)) {
    return NextResponse.json({ error: "Too many invites — try again later." }, { status: 429 });
  }

  let body: { org_role?: string; invitee_label?: string; expires_days?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!INVITABLE_ROLES.includes(body.org_role as OrgRole)) {
    return NextResponse.json({ error: `org_role must be one of: ${INVITABLE_ROLES.join(", ")}.` }, { status: 400 });
  }
  const expiresDays =
    Number.isInteger(body.expires_days) && body.expires_days! >= 1 && body.expires_days! <= 14 ? body.expires_days! : 7;

  const { invite, token } = mintStaffInvite(
    db,
    org.id,
    user.id,
    body.org_role as OrgRole,
    (body.invitee_label ?? "").trim().slice(0, 80) || null,
    expiresDays
  );
  logAudit(db, {
    actor: user.id,
    action: "org_staff_invite_created",
    targetId: invite.id,
    meta: { org: org.id, role: invite.org_role, expires_days: expiresDays },
  });
  return NextResponse.json({
    ok: true,
    invite: { id: invite.id, org_role: invite.org_role, expires_at: invite.expires_at },
    join_path: `/join-org/${token}`,
  });
}
