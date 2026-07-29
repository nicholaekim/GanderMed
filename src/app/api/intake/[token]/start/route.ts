// Starting intake binds the invitation to the signed-in patient (first claim
// wins) and moves it to intake_started. Idempotent for the owning patient.

import { NextResponse } from "next/server";
import { claimInvitation, transitionInvitation } from "@/lib/invitations";
import { resolveIntakeActor } from "../helpers";

type Ctx = { params: Promise<{ token: string }> };

export async function POST(request: Request, ctx: Ctx) {
  const { token } = await ctx.params;
  const actor = resolveIntakeActor(request, token);
  if ("fail" in actor) return actor.fail;
  const { db, invitation, user, profileId } = actor;

  if (claimInvitation(db, invitation, profileId) !== "ok") {
    return NextResponse.json({ error: "This invitation was already started by a different account." }, { status: 409 });
  }

  if (invitation.status === "intake_started" || invitation.status === "intake_submitted") {
    return NextResponse.json({ ok: true, status: invitation.status });
  }
  const updated = transitionInvitation(db, { ...invitation, profile_id: profileId }, "intake_started", user.id);
  if (!updated) {
    return NextResponse.json({ error: `Cannot start intake from state '${invitation.status}'.` }, { status: 409 });
  }
  return NextResponse.json({ ok: true, status: updated.status });
}
