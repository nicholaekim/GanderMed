// The patient confirms their medication list is complete. Stores an optional
// note for the clinician and moves intake_started → intake_submitted.

import { NextResponse } from "next/server";
import { transitionInvitation } from "@/lib/invitations";
import { resolveIntakeActor } from "../helpers";

type Ctx = { params: Promise<{ token: string }> };

export async function POST(request: Request, ctx: Ctx) {
  const { token } = await ctx.params;
  const actor = resolveIntakeActor(request, token);
  if ("fail" in actor) return actor.fail;
  const { db, invitation, user } = actor;

  let body: { patient_note?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const note = (body.patient_note ?? "").trim().slice(0, 500) || null;

  if (invitation.status === "intake_submitted") {
    return NextResponse.json({ ok: true, status: invitation.status });
  }
  const updated = transitionInvitation(db, invitation, "intake_submitted", user.id);
  if (!updated) {
    return NextResponse.json({ error: `Cannot submit from state '${invitation.status}'.` }, { status: 409 });
  }
  if (note) {
    db.prepare("UPDATE patient_invitations SET patient_note = ? WHERE id = ?").run(note, invitation.id);
  }
  return NextResponse.json({ ok: true, status: updated.status });
}
