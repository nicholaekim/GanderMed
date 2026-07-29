// Phase 11: PHI-free pilot metrics. The two properties that matter most:
// aggregates are scoped to the requesting clinician (their invitations,
// their grants — other clinicians' and non-granted patients' data never
// leak in), and the response contains no patient-identifying strings.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { computePilotMetrics } from "../src/lib/metrics";
import { GET as getMetrics } from "../src/app/api/metrics/route";
import { POST as invitationActionRoute } from "../src/app/api/invitations/[id]/route";
import { addMed, createUserSession, jsonRequest, useTestDb } from "./helpers";
import type { DatabaseSync } from "node:sqlite";

const idCtx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

function insertInvitation(
  db: DatabaseSync,
  clinicianUserId: number,
  status: string,
  opts: { createdHoursAgo?: number; consentHoursAfter?: number; reviewHoursAfterConsent?: number; label?: string } = {}
): number {
  const created = new Date(Date.now() - (opts.createdHoursAgo ?? 48) * 3_600_000);
  const consented =
    opts.consentHoursAfter !== undefined ? new Date(created.getTime() + opts.consentHoursAfter * 3_600_000) : null;
  const reviewed =
    consented && opts.reviewHoursAfterConsent !== undefined
      ? new Date(consented.getTime() + opts.reviewHoursAfterConsent * 3_600_000)
      : null;
  const fmt = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
  return Number(
    db
      .prepare(
        `INSERT INTO patient_invitations
         (token_hash, clinician_user_id, patient_label, purpose, status, expires_at, created_at, consented_at, reviewed_at)
         VALUES (?, ?, ?, 'Medication review', ?, ?, ?, ?, ?)`
      )
      .run(
        randomBytes(16).toString("hex"),
        clinicianUserId,
        opts.label ?? null,
        status,
        new Date(Date.now() + 86_400_000).toISOString(),
        fmt(created),
        consented ? fmt(consented) : null,
        reviewed ? fmt(reviewed) : null
      ).lastInsertRowid
  );
}

function grantAccess(db: DatabaseSync, profileId: number, clinicianUserId: number, status = "active"): void {
  db.prepare(
    `INSERT INTO access_grants (profile_id, clinician_user_id, status, purpose, requested_by_user_id, starts_at)
     VALUES (?, ?, ?, 'Medication review', ?, datetime('now'))`
  ).run(profileId, clinicianUserId, status, clinicianUserId);
}

test("mark_reviewed stamps reviewed_at (feeds the consent→review median)", async () => {
  const db = useTestDb();
  const clin = createUserSession(db, "clinician");
  const invId = insertInvitation(db, clin.userId, "consented", { consentHoursAfter: 1 });

  const res = await invitationActionRoute(
    jsonRequest(`/api/invitations/${invId}`, { method: "POST", cookie: clin.cookie, body: { action: "mark_reviewed" } }),
    idCtx(invId)
  );
  assert.equal(res.status, 200);
  const row = db.prepare("SELECT reviewed_at FROM patient_invitations WHERE id = ?").get(invId) as {
    reviewed_at: string | null;
  };
  assert.ok(row.reviewed_at, "reviewed transition now carries a timestamp");
});

test("metrics endpoint is clinician-only", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const anon = await getMetrics(jsonRequest("/api/metrics"));
  assert.equal(anon.status, 401);
  const asPatient = await getMetrics(jsonRequest("/api/metrics", { cookie: patient.cookie }));
  assert.equal(asPatient.status, 403);
});

test("FUNNEL: status counts, completion rate, and medians — scoped to MY invitations only", async () => {
  const db = useTestDb();
  const me = createUserSession(db, "clinician");
  const other = createUserSession(db, "clinician");

  insertInvitation(db, me.userId, "consented", { createdHoursAgo: 50, consentHoursAfter: 10 });
  insertInvitation(db, me.userId, "reviewed", { createdHoursAgo: 60, consentHoursAfter: 20, reviewHoursAfterConsent: 5 });
  insertInvitation(db, me.userId, "opened");
  insertInvitation(db, me.userId, "cancelled");
  insertInvitation(db, other.userId, "consented", { consentHoursAfter: 99 }); // must not leak in

  const m = computePilotMetrics(db, me.userId);
  assert.equal(m.invitations.total, 4, "only my invitations");
  assert.equal(m.invitations.by_status.consented, 1);
  assert.equal(m.invitations.by_status.reviewed, 1);
  assert.equal(m.invitations.completion_rate_pct, 67, "2 of 3 non-cancelled");
  assert.equal(m.invitations.median_hours_invite_to_consent, 15, "median of 10h and 20h");
  assert.equal(m.invitations.median_hours_consent_to_review, 5);
});

test("RECONCILIATION: session throughput and discrepancy density from snapshots", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  const medA = addMed(db, patient.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });
  const medB = addMed(db, patient.profileId!, { name: "ADVIL", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });

  const sessionId = Number(
    db
      .prepare(
        `INSERT INTO reconciliation_sessions (profile_id, clinician_user_id, clinician_name, status, started_at, completed_at, meds_total)
         VALUES (?, ?, 'Dr', 'completed', datetime('now','-30 minutes'), datetime('now'), 2)`
      )
      .run(patient.profileId, clin.userId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO reconciliation_items (session_id, medication_id, flags, disposition, disposed_by_user_id, disposed_by_name)
     VALUES (?, ?, '["unverified","missed_doses"]', 'follow_up', ?, 'Dr'), (?, ?, '[]', 'confirmed', ?, 'Dr')`
  ).run(sessionId, medA, clin.userId, sessionId, medB, clin.userId);

  const m = computePilotMetrics(db, clin.userId);
  assert.equal(m.reconciliation.sessions_completed, 1);
  assert.equal(m.reconciliation.median_minutes_to_complete, 30);
  assert.equal(m.reconciliation.avg_flags_per_reviewed_med, 1, "(2+0)/2 flags");
  assert.equal(m.reconciliation.dispositions.follow_up, 1);
  assert.equal(m.reconciliation.dispositions.confirmed, 1);
});

test("SCOPING: safety counts cover granted patients only; revoked grants counted separately", async () => {
  const db = useTestDb();
  const granted = createUserSession(db, "patient");
  const stranger = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, granted.profileId!, clin.userId);
  grantAccess(db, stranger.profileId!, clin.userId, "revoked");

  addMed(db, granted.profileId!, { name: "granted mystery", verified: false, ingredients: [] });
  addMed(db, stranger.profileId!, { name: "stranger mystery", verified: false, ingredients: [] });
  addMed(db, stranger.profileId!, { name: "stranger mystery 2", verified: false, ingredients: [] });

  const m = computePilotMetrics(db, clin.userId);
  assert.equal(m.safety.unverified_medications, 1, "only the granted patient's unverified med counts");
  assert.equal(m.patients.active_grants, 1);
  assert.equal(m.patients.revoked_grants, 1);
});

test("PHI-FREE: planted names, labels, and notes never appear in the metrics payload", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  db.prepare("UPDATE profiles SET name = 'ZEBRAXX SECRETNAME' WHERE id = ?").run(patient.profileId);
  grantAccess(db, patient.profileId!, clin.userId);
  insertInvitation(db, clin.userId, "consented", { consentHoursAfter: 2, label: "SECRETLABEL-77" });
  const medId = addMed(db, patient.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });
  db.prepare("UPDATE medications SET patient_notes = 'SECRETNOTE-88' WHERE id = ?").run(medId);

  const res = await getMetrics(jsonRequest("/api/metrics", { cookie: clin.cookie }));
  assert.equal(res.status, 200);
  const raw = JSON.stringify(await res.json());
  for (const secret of ["ZEBRAXX", "SECRETLABEL-77", "SECRETNOTE-88", "TYLENOL"]) {
    assert.ok(!raw.includes(secret), `metrics payload must not contain ${secret}`);
  }
  assert.ok(raw.includes("not_instrumented"), "unmeasured metrics are declared, not omitted");
});

test("empty practice: rates and medians are null (no data), never fake zeros", async () => {
  const db = useTestDb();
  const clin = createUserSession(db, "clinician");
  const m = computePilotMetrics(db, clin.userId);
  assert.equal(m.invitations.completion_rate_pct, null);
  assert.equal(m.invitations.median_hours_invite_to_consent, null);
  assert.equal(m.reconciliation.median_minutes_to_complete, null);
  assert.equal(m.reconciliation.avg_flags_per_reviewed_med, null);
});
