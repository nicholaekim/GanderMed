// Shared resolution for the token-addressed intake endpoints. The token in
// the URL is the only credential for VIEWING invitation metadata; every
// mutating step additionally requires a signed-in patient session.

import { NextResponse } from "next/server";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "@/lib/db";
import { getUserFromRequest, type SessionUser } from "@/lib/auth";
import { findInvitationByToken, TERMINAL_STATUSES, type InvitationRow } from "@/lib/invitations";

export function resolveInvitation(token: string): { db: DatabaseSync; invitation: InvitationRow } | { fail: NextResponse } {
  const db = getDb();
  const invitation = findInvitationByToken(db, token);
  if (!invitation) {
    return { fail: NextResponse.json({ error: "This intake link isn't valid." }, { status: 404 }) };
  }
  return { db, invitation };
}

/** Mutating intake steps: valid token + open invitation + signed-in patient who owns (or can claim) it. */
export function resolveIntakeActor(
  request: Request,
  token: string
): { db: DatabaseSync; invitation: InvitationRow; user: SessionUser; profileId: number } | { fail: NextResponse } {
  const resolved = resolveInvitation(token);
  if ("fail" in resolved) return resolved;
  const { db, invitation } = resolved;

  // 'consented' isn't terminal for the invitation (the clinician still marks
  // it reviewed), but the PATIENT's part is done — the token stops accepting
  // writes the moment a consent decision exists, whichever way it went.
  if (TERMINAL_STATUSES.includes(invitation.status) || invitation.status === "consented") {
    return { fail: NextResponse.json({ error: "This intake link is no longer active.", status: invitation.status }, { status: 410 }) };
  }

  const user = getUserFromRequest(db, request);
  if (!user) return { fail: NextResponse.json({ error: "Sign in to continue.", needs_login: true }, { status: 401 }) };
  if (user.role !== "patient" || user.profile_id == null) {
    return { fail: NextResponse.json({ error: "Intake is completed from a patient account." }, { status: 403 }) };
  }
  if (invitation.profile_id !== null && invitation.profile_id !== user.profile_id) {
    return { fail: NextResponse.json({ error: "This invitation was already started by a different account." }, { status: 409 }) };
  }
  return { db, invitation, user, profileId: user.profile_id };
}
