// Phase 10: reconciliation workspace. Safety properties: flags are
// deterministic and never auto-resolve anything, dispositions are
// clinician-only professional judgments (who + when), 'confirmed' is the
// only path to pharmacy-confirmed provenance, and that confirmation
// honestly evaporates when the patient later changes the dose.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFlags } from "../src/lib/reconcile";
import { recomputeAlerts } from "../src/lib/conflicts";
import { GET as getWorkspace, POST as startReconcile } from "../src/app/api/reconcile/route";
import { POST as sessionAction } from "../src/app/api/reconcile/[id]/route";
import { PATCH as patchMedication } from "../src/app/api/medications/[id]/route";
import { addMed, createUserSession, freshDb, jsonRequest, useTestDb } from "./helpers";
import type { DatabaseSync } from "node:sqlite";

const idCtx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

function grantAccess(db: DatabaseSync, profileId: number, clinicianUserId: number): void {
  db.prepare(
    `INSERT INTO access_grants (profile_id, clinician_user_id, status, purpose, requested_by_user_id, starts_at)
     VALUES (?, ?, 'active', 'Medication review', ?, datetime('now'))`
  ).run(profileId, clinicianUserId, clinicianUserId);
}

function flagCodes(db: DatabaseSync, profileId: number, medId: number): string[] {
  return (computeFlags(db, profileId).get(medId) ?? []).map((f) => f.code);
}

test("FLAGS: actual-use, verification, and missing-data discrepancies are deterministic", () => {
  const db = freshDb();
  const p = 1;
  db.prepare("INSERT INTO profiles (name, share_code) VALUES ('P', 'XXXX-0001')").run();

  const manual = Number(
    db
      .prepare(
        `INSERT INTO medications (profile_id, brand_name, verified, is_prn, schedule_times, status, actual_use, patient_notes)
         VALUES (?, 'mystery supplement', 0, 0, '[]', 'active', 'taking_differently', 'only half')`
      )
      .run(p).lastInsertRowid
  );
  const codes = flagCodes(db, p, manual);
  assert.ok(codes.includes("unverified"));
  assert.ok(codes.includes("taking_differently"));
  assert.ok(codes.includes("missing_dose"), "no dose recorded");
  assert.ok(codes.includes("missing_schedule"), "scheduled med with no times");
});

test("FLAGS: open interaction flags both meds; a review or acknowledgment clears the flag (never the alert)", () => {
  const db = freshDb();
  const p = 1;
  db.prepare("INSERT INTO profiles (name, share_code) VALUES ('P', 'XXXX-0002')").run();
  const warfarin = addMed(db, p, { name: "APO-WARFARIN", ingredients: [{ name: "WARFARIN SODIUM", strength: "1" }] });
  const advil = addMed(db, p, { name: "ADVIL", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });

  assert.ok(flagCodes(db, p, warfarin).includes("interaction_unreviewed"));
  assert.ok(flagCodes(db, p, advil).includes("interaction_unreviewed"));

  // Acknowledge the alert → flag clears, alert itself remains.
  const { all } = recomputeAlerts(db, p);
  db.prepare("UPDATE alerts SET acknowledged_at = datetime('now') WHERE id = ?").run(all[0].id);
  assert.ok(!flagCodes(db, p, warfarin).includes("interaction_unreviewed"));
  const alertCount = (db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE profile_id = ?").get(p) as { n: number }).n;
  assert.ok(alertCount > 0, "the alert row is untouched — flags inform, they never suppress");
});

test("FLAGS: duplicate ingredients flag both products", () => {
  const db = freshDb();
  const p = 1;
  db.prepare("INSERT INTO profiles (name, share_code) VALUES ('P', 'XXXX-0003')").run();
  const tylenol = addMed(db, p, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });
  const nyquil = addMed(db, p, { name: "NYQUIL", ingredients: [{ name: "ACETAMINOPHEN", strength: "650" }] });

  assert.ok(flagCodes(db, p, tylenol).includes("duplicate_ingredient"));
  assert.ok(flagCodes(db, p, nyquil).includes("duplicate_ingredient"));
});

test("SESSION: clinician with a grant starts (and resumes) a session; patients cannot start one", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);

  const start = await startReconcile(
    jsonRequest(`/api/reconcile?patient=${patient.profileId}`, { method: "POST", cookie: clin.cookie })
  );
  assert.equal(start.status, 200);
  const sessionId = (await start.json()).session.id;

  const again = await startReconcile(
    jsonRequest(`/api/reconcile?patient=${patient.profileId}`, { method: "POST", cookie: clin.cookie })
  );
  assert.equal((await again.json()).session.id, sessionId, "starting again resumes the open session");

  const asPatient = await startReconcile(jsonRequest("/api/reconcile", { method: "POST", cookie: patient.cookie }));
  assert.equal(asPatient.status, 403, "dispositions are professional judgments");
});

test("SESSION: no grant → no workspace, no session", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");

  const read = await getWorkspace(jsonRequest(`/api/reconcile?patient=${patient.profileId}`, { cookie: clin.cookie }));
  assert.equal(read.status, 403);
  const start = await startReconcile(
    jsonRequest(`/api/reconcile?patient=${patient.profileId}`, { method: "POST", cookie: clin.cookie })
  );
  assert.equal(start.status, 403);
});

test("DISPOSE: records who+when with a flags snapshot; re-disposing replaces within the session", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  const medId = addMed(db, patient.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });

  const start = await startReconcile(
    jsonRequest(`/api/reconcile?patient=${patient.profileId}`, { method: "POST", cookie: clin.cookie })
  );
  const sessionId = (await start.json()).session.id;

  const d1 = await sessionAction(
    jsonRequest(`/api/reconcile/${sessionId}`, {
      method: "POST",
      cookie: clin.cookie,
      body: { action: "dispose", medication_id: medId, disposition: "follow_up", note: "check strength" },
    }),
    idCtx(sessionId)
  );
  assert.equal(d1.status, 200);

  const d2 = await sessionAction(
    jsonRequest(`/api/reconcile/${sessionId}`, {
      method: "POST",
      cookie: clin.cookie,
      body: { action: "dispose", medication_id: medId, disposition: "resolved" },
    }),
    idCtx(sessionId)
  );
  assert.equal(d2.status, 200);

  const rows = db
    .prepare("SELECT disposition, disposed_by_name, disposed_at, flags FROM reconciliation_items WHERE session_id = ?")
    .all(sessionId) as { disposition: string; disposed_by_name: string; disposed_at: string; flags: string }[];
  assert.equal(rows.length, 1, "one row per med per session — re-dispose replaces");
  assert.equal(rows[0].disposition, "resolved");
  assert.ok(rows[0].disposed_by_name.length > 0);
  assert.ok(Array.isArray(JSON.parse(rows[0].flags)), "flags snapshotted at disposition time");
});

test("PROVENANCE: only 'confirmed' flips to pharmacy-confirmed; other dispositions never do", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  const medA = addMed(db, patient.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });
  const medB = addMed(db, patient.profileId!, { name: "APO-WARFARIN", ingredients: [{ name: "WARFARIN SODIUM", strength: "1" }] });

  const sessionId = (
    await (
      await startReconcile(jsonRequest(`/api/reconcile?patient=${patient.profileId}`, { method: "POST", cookie: clin.cookie }))
    ).json()
  ).session.id;

  await sessionAction(
    jsonRequest(`/api/reconcile/${sessionId}`, {
      method: "POST",
      cookie: clin.cookie,
      body: { action: "dispose", medication_id: medA, disposition: "confirmed" },
    }),
    idCtx(sessionId)
  );
  await sessionAction(
    jsonRequest(`/api/reconcile/${sessionId}`, {
      method: "POST",
      cookie: clin.cookie,
      body: { action: "dispose", medication_id: medB, disposition: "referred" },
    }),
    idCtx(sessionId)
  );

  const provs = db.prepare("SELECT id, provenance FROM medications WHERE profile_id = ?").all(patient.profileId) as {
    id: number;
    provenance: string;
  }[];
  assert.equal(provs.find((m) => m.id === medA)!.provenance, "pharmacy-confirmed");
  assert.equal(provs.find((m) => m.id === medB)!.provenance, "patient-reported");
});

test("PROVENANCE REVERT: a material dose edit after confirmation goes back to patient-reported", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  const medId = addMed(db, patient.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });

  const sessionId = (
    await (
      await startReconcile(jsonRequest(`/api/reconcile?patient=${patient.profileId}`, { method: "POST", cookie: clin.cookie }))
    ).json()
  ).session.id;
  await sessionAction(
    jsonRequest(`/api/reconcile/${sessionId}`, {
      method: "POST",
      cookie: clin.cookie,
      body: { action: "dispose", medication_id: medId, disposition: "confirmed" },
    }),
    idCtx(sessionId)
  );

  // A non-material edit keeps the confirmation…
  await patchMedication(
    jsonRequest(`/api/medications/${medId}`, { method: "PATCH", cookie: patient.cookie, body: { instructions: "with food" } }),
    idCtx(medId)
  );
  let prov = (db.prepare("SELECT provenance FROM medications WHERE id = ?").get(medId) as { provenance: string }).provenance;
  assert.equal(prov, "pharmacy-confirmed", "instructions don't invalidate the confirmation");

  // …a dose change does not.
  await patchMedication(
    jsonRequest(`/api/medications/${medId}`, { method: "PATCH", cookie: patient.cookie, body: { dose_value: 2 } }),
    idCtx(medId)
  );
  prov = (db.prepare("SELECT provenance FROM medications WHERE id = ?").get(medId) as { provenance: string }).provenance;
  assert.equal(prov, "patient-reported", "the confirmed state no longer exists");
});

test("COMPLETE: freezes the session with coverage; further dispositions are refused; workspace reports it", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  const medId = addMed(db, patient.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });
  addMed(db, patient.profileId!, { name: "ADVIL", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });

  const sessionId = (
    await (
      await startReconcile(jsonRequest(`/api/reconcile?patient=${patient.profileId}`, { method: "POST", cookie: clin.cookie }))
    ).json()
  ).session.id;
  await sessionAction(
    jsonRequest(`/api/reconcile/${sessionId}`, {
      method: "POST",
      cookie: clin.cookie,
      body: { action: "dispose", medication_id: medId, disposition: "confirmed" },
    }),
    idCtx(sessionId)
  );

  const done = await sessionAction(
    jsonRequest(`/api/reconcile/${sessionId}`, {
      method: "POST",
      cookie: clin.cookie,
      body: { action: "complete", summary_note: "one confirmed, one outstanding" },
    }),
    idCtx(sessionId)
  );
  assert.equal(done.status, 200);
  const completed = (await done.json()).session;
  assert.equal(completed.status, "completed");
  assert.equal(completed.meds_total, 2, "coverage snapshot: 1 of 2 reviewed");

  const late = await sessionAction(
    jsonRequest(`/api/reconcile/${sessionId}`, {
      method: "POST",
      cookie: clin.cookie,
      body: { action: "dispose", medication_id: medId, disposition: "resolved" },
    }),
    idCtx(sessionId)
  );
  assert.equal(late.status, 409, "completed sessions are frozen history");

  const ws = await (
    await getWorkspace(jsonRequest(`/api/reconcile?patient=${patient.profileId}`, { cookie: clin.cookie }))
  ).json();
  assert.equal(ws.session, null, "no open session anymore");
  assert.equal(ws.last_completed.disposed, 1);
  assert.equal(ws.last_completed.meds_total, 2);
});

test("OWNERSHIP: another clinician cannot act on someone else's session", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const owner = createUserSession(db, "clinician");
  const other = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, owner.userId);
  grantAccess(db, patient.profileId!, other.userId);
  const medId = addMed(db, patient.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });

  const sessionId = (
    await (
      await startReconcile(jsonRequest(`/api/reconcile?patient=${patient.profileId}`, { method: "POST", cookie: owner.cookie }))
    ).json()
  ).session.id;

  const res = await sessionAction(
    jsonRequest(`/api/reconcile/${sessionId}`, {
      method: "POST",
      cookie: other.cookie,
      body: { action: "dispose", medication_id: medId, disposition: "confirmed" },
    }),
    idCtx(sessionId)
  );
  assert.equal(res.status, 404, "sessions are per-clinician");
});

test("REVOCATION: a revoked grant blocks further dispositions mid-session", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  const medId = addMed(db, patient.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });

  const sessionId = (
    await (
      await startReconcile(jsonRequest(`/api/reconcile?patient=${patient.profileId}`, { method: "POST", cookie: clin.cookie }))
    ).json()
  ).session.id;
  db.prepare("UPDATE access_grants SET status = 'revoked' WHERE profile_id = ?").run(patient.profileId);

  const res = await sessionAction(
    jsonRequest(`/api/reconcile/${sessionId}`, {
      method: "POST",
      cookie: clin.cookie,
      body: { action: "dispose", medication_id: medId, disposition: "confirmed" },
    }),
    idCtx(sessionId)
  );
  assert.equal(res.status, 403, "consent revocation bites immediately, even mid-session");
});

test("PATIENT VIEW: patients can read their own flags but the workspace carries no session for them", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  addMed(db, patient.profileId!, {
    name: "TYLENOL",
    ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }],
  });
  db.prepare("UPDATE medications SET actual_use = 'unsure' WHERE profile_id = ?").run(patient.profileId);

  const res = await getWorkspace(jsonRequest("/api/reconcile", { cookie: patient.cookie }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.session, null);
  assert.ok(data.items[0].flags.some((f: { code: string }) => f.code === "patient_unsure"));
});

test("AUDIT: the reconciliation lifecycle lands in audit_events", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  const medId = addMed(db, patient.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });

  const sessionId = (
    await (
      await startReconcile(jsonRequest(`/api/reconcile?patient=${patient.profileId}`, { method: "POST", cookie: clin.cookie }))
    ).json()
  ).session.id;
  await sessionAction(
    jsonRequest(`/api/reconcile/${sessionId}`, {
      method: "POST",
      cookie: clin.cookie,
      body: { action: "dispose", medication_id: medId, disposition: "confirmed" },
    }),
    idCtx(sessionId)
  );
  await sessionAction(
    jsonRequest(`/api/reconcile/${sessionId}`, { method: "POST", cookie: clin.cookie, body: { action: "complete" } }),
    idCtx(sessionId)
  );

  const actions = (db.prepare("SELECT action FROM audit_events").all() as { action: string }[]).map((r) => r.action);
  for (const expected of ["reconciliation_started", "reconciliation_item_disposed", "reconciliation_completed"]) {
    assert.ok(actions.includes(expected), `missing audit action ${expected}`);
  }
});
