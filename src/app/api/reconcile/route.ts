// Reconciliation workspace endpoints.
// GET  — the workspace: every active medication with its live discrepancy
//        flags, the caller's open session (with saved dispositions), and the
//        last completed reconciliation. Patients may read their own.
// POST — start (or resume) a session. Clinician + active grant only:
//        dispositions are professional judgments.

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest, resolveProfileAccess } from "@/lib/auth";
import {
  computeFlags,
  getLastCompleted,
  getOpenSession,
  sessionItems,
  startSession,
} from "@/lib/reconcile";

export async function GET(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const access = resolveProfileAccess(db, user, request, { write: false });
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.status });
  const profileId = access.profileId;

  const flags = computeFlags(db, profileId);
  const session = user.role === "clinician" ? getOpenSession(db, profileId, user.id) : null;
  const items = session ? sessionItems(db, session.id) : new Map();

  const meds = db
    .prepare("SELECT id FROM medications WHERE profile_id = ? AND status = 'active' ORDER BY brand_name")
    .all(profileId) as { id: number }[];

  return NextResponse.json({
    session,
    last_completed: getLastCompleted(db, profileId),
    items: meds.map((m) => {
      const saved = items.get(m.id);
      return {
        medication_id: m.id,
        flags: flags.get(m.id) ?? [],
        disposition: saved?.disposition ?? null,
        note: saved?.note ?? null,
        disposed_by_name: saved?.disposed_by_name ?? null,
        disposed_at: saved?.disposed_at ?? null,
      };
    }),
  });
}

export async function POST(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (user.role !== "clinician") {
    return NextResponse.json({ error: "Reconciliation sessions are started by care-team accounts." }, { status: 403 });
  }
  const access = resolveProfileAccess(db, user, request, { write: false });
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.status });

  const session = startSession(db, access.profileId, {
    id: user.id,
    display_name: user.display_name,
    clinic_name: user.clinic_name,
  });
  return NextResponse.json({ ok: true, session });
}
