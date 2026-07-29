// Clinician invitation management. POST mints an invitation and returns the
// raw intake URL exactly once (only its hash is stored); GET lists the
// clinician's invitations with lazily-applied expiry. No email/SMS is sent —
// the clinician delivers the link themselves.

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest } from "@/lib/auth";
import { ACCESS_PURPOSES } from "@/lib/access";
import { createInvitation, listInvitations } from "@/lib/invitations";

function requireClinician(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return { fail: NextResponse.json({ error: "Not signed in." }, { status: 401 }) };
  if (user.role !== "clinician") {
    return { fail: NextResponse.json({ error: "Care-team accounts only." }, { status: 403 }) };
  }
  return { db, user };
}

export async function GET(request: Request) {
  const auth = requireClinician(request);
  if ("fail" in auth) return auth.fail;
  const { db, user } = auth;

  const invitations = listInvitations(db, user.id).map((inv) => ({
    id: inv.id,
    patient_label: inv.patient_label,
    purpose: inv.purpose,
    status: inv.status,
    created_at: inv.created_at,
    expires_at: inv.expires_at,
    opened_at: inv.opened_at,
    submitted_at: inv.submitted_at,
    consented_at: inv.consented_at,
    patient_note: inv.patient_note,
    grant_id: inv.grant_id,
    profile_id: inv.status === "consented" || inv.status === "reviewed" ? inv.profile_id : null,
  }));
  return NextResponse.json({ invitations });
}

export async function POST(request: Request) {
  const auth = requireClinician(request);
  if ("fail" in auth) return auth.fail;
  const { db, user } = auth;

  let body: { patient_label?: string; purpose?: string; expires_days?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const label = (body.patient_label ?? "").trim().slice(0, 80) || null;
  const purpose = (ACCESS_PURPOSES as readonly string[]).includes(body.purpose ?? "")
    ? body.purpose!
    : "Medication review";
  const expiresDays = Number.isInteger(body.expires_days) && body.expires_days! >= 1 && body.expires_days! <= 30
    ? body.expires_days!
    : 7;

  const { invitation, token } = createInvitation(db, user.id, {
    patientLabel: label,
    purpose,
    expiresDays,
  });

  // The raw token appears here and nowhere else; the intake URL is built
  // client-side against window.location.origin.
  return NextResponse.json({
    ok: true,
    invitation: { id: invitation.id, status: invitation.status, expires_at: invitation.expires_at },
    intake_path: `/intake/${token}`,
  });
}
