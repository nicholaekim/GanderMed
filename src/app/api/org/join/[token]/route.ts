// Staff join link. GET is public metadata (org name + unverified badge, the
// offered role, who invited — never a member list or patient data). POST
// redeems per the decision table; patient/wrong-org attempts never consume
// the invite.

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest } from "@/lib/auth";
import { logAudit } from "@/lib/access";
import { activeMembership, findStaffInviteByToken, getOrg, redeemStaffInvite } from "@/lib/org";
import { allowRequest, clientIp } from "@/lib/ratelimit";

type Ctx = { params: Promise<{ token: string }> };

export async function GET(request: Request, ctx: Ctx) {
  const { token } = await ctx.params;
  const db = getDb();
  const invite = findStaffInviteByToken(db, token);
  if (!invite) return NextResponse.json({ error: "This join link isn't valid." }, { status: 404 });

  const org = getOrg(db, invite.organization_id)!;
  const inviter = db
    .prepare("SELECT display_name FROM users WHERE id = ?")
    .get(invite.invited_by_user_id) as { display_name: string };

  const user = getUserFromRequest(db, request);
  let viewer: "anonymous" | "patient" | "clinician" | "member" = "anonymous";
  if (user?.role === "patient") viewer = "patient";
  else if (user?.role === "clinician") {
    viewer = activeMembership(db, user.id)?.organization_id === invite.organization_id ? "member" : "clinician";
  }

  return NextResponse.json({
    org_name: org.name,
    verification_status: org.verification_status,
    org_role: invite.org_role,
    invited_by_name: inviter.display_name,
    status: invite.status,
    viewer,
  });
}

export async function POST(request: Request, ctx: Ctx) {
  const { token } = await ctx.params;
  const db = getDb();
  if (!allowRequest(`org-join:${clientIp(request)}`, 10, 900_000)) {
    return NextResponse.json({ error: "Too many attempts — try again later." }, { status: 429 });
  }

  const invite = findStaffInviteByToken(db, token);
  if (!invite) return NextResponse.json({ error: "This join link isn't valid." }, { status: 404 });
  if (invite.status !== "created") {
    return NextResponse.json({ error: "This join link is no longer active." }, { status: 410 });
  }

  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Sign in to continue.", needs_login: true }, { status: 401 });

  const result = redeemStaffInvite(db, invite, user);
  if (result === "patient") {
    return NextResponse.json({ error: "Patient accounts cannot join a care organization." }, { status: 403 });
  }
  if (result === "already_member") {
    return NextResponse.json({ error: "You are already a member of this organization." }, { status: 409 });
  }
  if (result === "other_org") {
    const mine = activeMembership(db, user.id);
    const other = mine ? getOrg(db, mine.organization_id)?.name : null;
    return NextResponse.json(
      { error: `This account already belongs to ${other ?? "another organization"}. One organization per account in this version.` },
      { status: 409 }
    );
  }
  if (result === "gone") return NextResponse.json({ error: "This join link is no longer active." }, { status: 410 });

  logAudit(db, {
    actor: user.id,
    action: "org_member_joined",
    targetId: invite.organization_id,
    meta: { org: invite.organization_id, role: invite.org_role, invite: invite.id },
  });
  return NextResponse.json({ ok: true, organization_id: invite.organization_id, org_role: invite.org_role });
}
