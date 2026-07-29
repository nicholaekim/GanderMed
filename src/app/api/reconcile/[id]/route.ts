// Actions on one reconciliation session (owner clinician only, while open):
//   { action: "dispose", medication_id, disposition, note? }
//   { action: "complete", summary_note? }

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest } from "@/lib/auth";
import { completeSession, disposeItem, DISPOSITIONS, type Disposition, type SessionRow } from "@/lib/reconcile";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const sessionId = Number(id);
  if (!Number.isInteger(sessionId)) return NextResponse.json({ error: "Bad id." }, { status: 400 });

  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (user.role !== "clinician") {
    return NextResponse.json({ error: "Care-team accounts only." }, { status: 403 });
  }

  const session = db
    .prepare("SELECT * FROM reconciliation_sessions WHERE id = ?")
    .get(sessionId) as SessionRow | undefined;
  if (!session || session.clinician_user_id !== user.id) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (session.status !== "open") {
    return NextResponse.json({ error: "This reconciliation session is already completed." }, { status: 409 });
  }

  // The grant may have been revoked or expired since the session started —
  // every write re-checks it.
  const grant = db
    .prepare(
      `SELECT 1 FROM access_grants
       WHERE clinician_user_id = ? AND profile_id = ? AND status = 'active'
         AND (expires_at IS NULL OR expires_at > datetime('now'))`
    )
    .get(user.id, session.profile_id);
  if (!grant) {
    return NextResponse.json({ error: "No active patient-approved access for this record." }, { status: 403 });
  }

  let body: { action?: string; medication_id?: number; disposition?: string; note?: string; summary_note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (body.action === "dispose") {
    const medId = Number(body.medication_id);
    if (!Number.isInteger(medId)) return NextResponse.json({ error: "medication_id required." }, { status: 400 });
    if (!body.disposition || !(body.disposition in DISPOSITIONS)) {
      return NextResponse.json(
        { error: `disposition must be one of: ${Object.keys(DISPOSITIONS).join(", ")}.` },
        { status: 400 }
      );
    }
    const note = (body.note ?? "").trim().slice(0, 500) || null;
    const result = disposeItem(db, session, medId, body.disposition as Disposition, note, {
      id: user.id,
      display_name: user.display_name,
    });
    if (result.error) return NextResponse.json({ error: "Medication not found on this record." }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "complete") {
    const summary = (body.summary_note ?? "").trim().slice(0, 1000) || null;
    const completed = completeSession(db, session, summary, user.id);
    return NextResponse.json({ ok: true, session: completed });
  }

  return NextResponse.json({ error: "action must be 'dispose' or 'complete'." }, { status: 400 });
}
