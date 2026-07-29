// Public invitation metadata for the intake page. Reveals only who is asking
// and why — never any patient record. First view moves created → opened.

import { NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { transitionInvitation } from "@/lib/invitations";
import { resolveInvitation } from "./helpers";

type Ctx = { params: Promise<{ token: string }> };

export async function GET(request: Request, ctx: Ctx) {
  const { token } = await ctx.params;
  const resolved = resolveInvitation(token);
  if ("fail" in resolved) return resolved.fail;
  const { db } = resolved;
  let invitation = resolved.invitation;

  if (invitation.status === "created") {
    invitation = transitionInvitation(db, invitation, "opened", null) ?? invitation;
  }

  const clinician = db
    .prepare("SELECT display_name, clinic_name FROM users WHERE id = ?")
    .get(invitation.clinician_user_id) as { display_name: string; clinic_name: string | null };

  const user = getUserFromRequest(db, request);
  const viewer = user ? user.role : "anonymous";
  const claimedByYou = user?.role === "patient" && invitation.profile_id != null && invitation.profile_id === user.profile_id;

  return NextResponse.json({
    status: invitation.status,
    purpose: invitation.purpose,
    expires_at: invitation.expires_at,
    clinician_name: clinician.display_name,
    clinic_name: clinician.clinic_name,
    viewer,
    claimed: invitation.profile_id != null,
    claimed_by_you: claimedByYou,
  });
}
