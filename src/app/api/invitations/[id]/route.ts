// Invitation actions for the owning clinician: cancel an open invitation, or
// mark a consented one reviewed (closing the intake loop).

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest } from "@/lib/auth";
import { getInvitation, transitionInvitation } from "@/lib/invitations";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const invitationId = Number(id);
  if (!Number.isInteger(invitationId)) return NextResponse.json({ error: "Bad id." }, { status: 400 });

  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (user.role !== "clinician") {
    return NextResponse.json({ error: "Care-team accounts only." }, { status: 403 });
  }

  let body: { action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (body.action !== "cancel" && body.action !== "mark_reviewed") {
    return NextResponse.json({ error: "action must be 'cancel' or 'mark_reviewed'." }, { status: 400 });
  }

  const invitation = getInvitation(db, invitationId);
  if (!invitation || invitation.clinician_user_id !== user.id) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const updated = transitionInvitation(db, invitation, body.action === "cancel" ? "cancelled" : "reviewed", user.id);
  if (!updated) {
    return NextResponse.json(
      { error: `Cannot ${body.action === "cancel" ? "cancel" : "mark reviewed"} an invitation in state '${invitation.status}'.` },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true, status: updated.status });
}
