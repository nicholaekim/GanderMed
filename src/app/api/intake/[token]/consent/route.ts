// The consent decision that ends intake. Approve → an ACTIVE access grant
// (same table and enforcement as care-code consent, optional expiry);
// deny → the invitation closes and nothing is shared.

import { NextResponse } from "next/server";
import { concludeIntake } from "@/lib/invitations";
import { resolveIntakeActor } from "../helpers";

type Ctx = { params: Promise<{ token: string }> };

const EXPIRY_CHOICES = [30, 90, 180];

export async function POST(request: Request, ctx: Ctx) {
  const { token } = await ctx.params;
  const actor = resolveIntakeActor(request, token);
  if ("fail" in actor) return actor.fail;
  const { db, invitation, user, profileId } = actor;

  let body: { approve?: boolean; expires_days?: number | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof body.approve !== "boolean") {
    return NextResponse.json({ error: "approve must be true or false." }, { status: 400 });
  }
  const expiresDays = EXPIRY_CHOICES.includes(body.expires_days ?? -1) ? body.expires_days! : null;

  const updated = concludeIntake(db, invitation, user.id, profileId, { approve: body.approve, expiresDays });
  if (!updated) {
    return NextResponse.json({ error: `Cannot record a consent decision from state '${invitation.status}'.` }, { status: 409 });
  }
  return NextResponse.json({ ok: true, status: updated.status, grant_id: updated.grant_id });
}
