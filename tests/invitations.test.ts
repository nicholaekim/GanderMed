// Phase 6: pharmacy-initiated invitations + guided intake. The safety
// properties under test: the raw token is never stored, links expire and die
// on cancellation, first-claim-wins, consent is explicit (deny shares
// nothing), and an approved consent yields a real, enforced access grant.

import { test } from "node:test";
import assert from "node:assert/strict";
import { GET as listInvitationsRoute, POST as createInvitationRoute } from "../src/app/api/invitations/route";
import { POST as invitationActionRoute } from "../src/app/api/invitations/[id]/route";
import { GET as intakeMetaRoute } from "../src/app/api/intake/[token]/route";
import { POST as intakeStartRoute } from "../src/app/api/intake/[token]/start/route";
import { POST as intakeSubmitRoute } from "../src/app/api/intake/[token]/submit/route";
import { POST as intakeConsentRoute } from "../src/app/api/intake/[token]/consent/route";
import { GET as getMedications } from "../src/app/api/medications/route";
import { PATCH as patchMedication } from "../src/app/api/medications/[id]/route";
import { createUserSession, jsonRequest, useTestDb } from "./helpers";
import type { DatabaseSync } from "node:sqlite";

const ctx = (v: string) => ({ params: Promise.resolve(v.startsWith("/") ? { id: v.slice(1) } : { token: v }) });

async function mintInvitation(
  clinicianCookie: string,
  body: Record<string, unknown> = {}
): Promise<{ token: string; id: number }> {
  const res = await createInvitationRoute(
    jsonRequest("/api/invitations", {
      method: "POST",
      cookie: clinicianCookie,
      body: { patient_label: "J.S.", purpose: "Medication review", expires_days: 7, ...body },
    })
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  const token = (data.intake_path as string).replace("/intake/", "");
  return { token, id: data.invitation.id };
}

function invitationStatus(db: DatabaseSync, id: number): string {
  return (db.prepare("SELECT status FROM patient_invitations WHERE id = ?").get(id) as { status: string }).status;
}

/** Walk an invitation to intake_submitted as the given patient. */
async function walkToSubmitted(token: string, patientCookie: string): Promise<void> {
  await intakeMetaRoute(jsonRequest(`/api/intake/${token}`), ctx(token));
  const start = await intakeStartRoute(
    jsonRequest(`/api/intake/${token}/start`, { method: "POST", cookie: patientCookie }),
    ctx(token)
  );
  assert.equal(start.status, 200);
  const submit = await intakeSubmitRoute(
    jsonRequest(`/api/intake/${token}/submit`, {
      method: "POST",
      cookie: patientCookie,
      body: { patient_note: "I split the evening tablet" },
    }),
    ctx(token)
  );
  assert.equal(submit.status, 200);
}

test("SECRECY: only a hash of the intake token is stored", async () => {
  const db = useTestDb();
  const { cookie } = createUserSession(db, "clinician");
  const { token, id } = await mintInvitation(cookie);

  const row = db.prepare("SELECT token_hash FROM patient_invitations WHERE id = ?").get(id) as { token_hash: string };
  assert.equal(row.token_hash.length, 64, "sha256 hex");
  assert.notEqual(row.token_hash, token);
  assert.ok(!row.token_hash.includes(token), "raw token must not appear in storage");
});

test("patients cannot mint invitations", async () => {
  const db = useTestDb();
  const { cookie } = createUserSession(db, "patient");
  const res = await createInvitationRoute(
    jsonRequest("/api/invitations", { method: "POST", cookie, body: { purpose: "Medication review" } })
  );
  assert.equal(res.status, 403);
});

test("viewing the link reveals only who/why and flips created → opened", async () => {
  const db = useTestDb();
  const { cookie } = createUserSession(db, "clinician");
  const { token, id } = await mintInvitation(cookie);

  const res = await intakeMetaRoute(jsonRequest(`/api/intake/${token}`), ctx(token));
  assert.equal(res.status, 200);
  const meta = await res.json();
  assert.equal(meta.status, "opened");
  assert.equal(meta.purpose, "Medication review");
  assert.ok(meta.clinician_name);
  assert.equal(meta.viewer, "anonymous");
  assert.equal(invitationStatus(db, id), "opened");
  assert.equal(Object.keys(meta).includes("patient_label"), false, "label stays clinician-side");
});

test("a tampered token 404s without leaking anything", async () => {
  const db = useTestDb();
  const { cookie } = createUserSession(db, "clinician");
  const { token } = await mintInvitation(cookie);
  const wrong = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
  const res = await intakeMetaRoute(jsonRequest(`/api/intake/${wrong}`), ctx(wrong));
  assert.equal(res.status, 404);
});

test("EXPIRY: past-expiry links die lazily and cannot be started", async () => {
  const db = useTestDb();
  const { cookie } = createUserSession(db, "clinician");
  const patient = createUserSession(db, "patient");
  const { token, id } = await mintInvitation(cookie);
  db.prepare("UPDATE patient_invitations SET expires_at = ? WHERE id = ?").run(
    new Date(Date.now() - 1000).toISOString(),
    id
  );

  const meta = await intakeMetaRoute(jsonRequest(`/api/intake/${token}`), ctx(token));
  assert.equal((await meta.json()).status, "expired");
  assert.equal(invitationStatus(db, id), "expired");

  const start = await intakeStartRoute(
    jsonRequest(`/api/intake/${token}/start`, { method: "POST", cookie: patient.cookie }),
    ctx(token)
  );
  assert.equal(start.status, 410);
});

test("CANCELLATION: the clinician can kill an open link; replay is refused", async () => {
  const db = useTestDb();
  const { cookie } = createUserSession(db, "clinician");
  const patient = createUserSession(db, "patient");
  const { token, id } = await mintInvitation(cookie);

  const cancel = await invitationActionRoute(
    jsonRequest(`/api/invitations/${id}`, { method: "POST", cookie, body: { action: "cancel" } }),
    ctx(`/${id}`)
  );
  assert.equal(cancel.status, 200);
  assert.equal(invitationStatus(db, id), "cancelled");

  const start = await intakeStartRoute(
    jsonRequest(`/api/intake/${token}/start`, { method: "POST", cookie: patient.cookie }),
    ctx(token)
  );
  assert.equal(start.status, 410);
});

test("only the owning clinician can act on an invitation", async () => {
  const db = useTestDb();
  const owner = createUserSession(db, "clinician");
  const other = createUserSession(db, "clinician");
  const { id } = await mintInvitation(owner.cookie);

  const res = await invitationActionRoute(
    jsonRequest(`/api/invitations/${id}`, { method: "POST", cookie: other.cookie, body: { action: "cancel" } }),
    ctx(`/${id}`)
  );
  assert.equal(res.status, 404, "other clinicians can't even see it");
});

test("CLAIM: first patient wins; a second account is turned away", async () => {
  const db = useTestDb();
  const { cookie } = createUserSession(db, "clinician");
  const first = createUserSession(db, "patient");
  const second = createUserSession(db, "patient");
  const { token, id } = await mintInvitation(cookie);

  const start1 = await intakeStartRoute(
    jsonRequest(`/api/intake/${token}/start`, { method: "POST", cookie: first.cookie }),
    ctx(token)
  );
  assert.equal(start1.status, 200);
  assert.equal(invitationStatus(db, id), "intake_started");

  const start2 = await intakeStartRoute(
    jsonRequest(`/api/intake/${token}/start`, { method: "POST", cookie: second.cookie }),
    ctx(token)
  );
  assert.equal(start2.status, 409);

  const submit2 = await intakeSubmitRoute(
    jsonRequest(`/api/intake/${token}/submit`, { method: "POST", cookie: second.cookie, body: {} }),
    ctx(token)
  );
  assert.equal(submit2.status, 409, "the other account can't submit either");
});

test("intake steps require a signed-in patient (clinicians and anonymous are refused)", async () => {
  const db = useTestDb();
  const clin = createUserSession(db, "clinician");
  const { token } = await mintInvitation(clin.cookie);

  const anon = await intakeStartRoute(jsonRequest(`/api/intake/${token}/start`, { method: "POST" }), ctx(token));
  assert.equal(anon.status, 401);
  const asClin = await intakeStartRoute(
    jsonRequest(`/api/intake/${token}/start`, { method: "POST", cookie: clin.cookie }),
    ctx(token)
  );
  assert.equal(asClin.status, 403);
});

test("CONSENT DENIED: nothing is shared and the link is finished", async () => {
  const db = useTestDb();
  const clin = createUserSession(db, "clinician");
  const patient = createUserSession(db, "patient");
  const { token, id } = await mintInvitation(clin.cookie);
  await walkToSubmitted(token, patient.cookie);

  const consent = await intakeConsentRoute(
    jsonRequest(`/api/intake/${token}/consent`, { method: "POST", cookie: patient.cookie, body: { approve: false } }),
    ctx(token)
  );
  assert.equal(consent.status, 200);
  assert.equal(invitationStatus(db, id), "denied");

  const grants = db.prepare("SELECT COUNT(*) AS n FROM access_grants WHERE status = 'active'").get() as { n: number };
  assert.equal(grants.n, 0, "no grant of any kind");

  const read = await getMedications(
    jsonRequest(`/api/medications?patient=${patient.profileId}`, { cookie: clin.cookie })
  );
  assert.equal(read.status, 403, "clinician still cannot read the record");

  const replay = await intakeConsentRoute(
    jsonRequest(`/api/intake/${token}/consent`, { method: "POST", cookie: patient.cookie, body: { approve: true } }),
    ctx(token)
  );
  assert.equal(replay.status, 410, "a decided invitation cannot be re-decided");
});

test("CONSENT APPROVED: an active, expiring grant opens the record for the inviter only", async () => {
  const db = useTestDb();
  const clin = createUserSession(db, "clinician");
  const stranger = createUserSession(db, "clinician");
  const patient = createUserSession(db, "patient");
  const { token, id } = await mintInvitation(clin.cookie);
  await walkToSubmitted(token, patient.cookie);

  const consent = await intakeConsentRoute(
    jsonRequest(`/api/intake/${token}/consent`, {
      method: "POST",
      cookie: patient.cookie,
      body: { approve: true, expires_days: 90 },
    }),
    ctx(token)
  );
  assert.equal(consent.status, 200);
  const decided = await consent.json();
  assert.equal(decided.status, "consented");
  assert.ok(decided.grant_id, "consent yields a real grant id");

  const grant = db.prepare("SELECT * FROM access_grants WHERE id = ?").get(decided.grant_id) as {
    status: string;
    purpose: string;
    expires_at: string | null;
    clinician_user_id: number;
  };
  assert.equal(grant.status, "active");
  assert.equal(grant.purpose, "Medication review", "purpose carries over from the invitation");
  assert.ok(grant.expires_at, "90-day expiry recorded");
  assert.equal(grant.clinician_user_id, clin.userId);

  const read = await getMedications(
    jsonRequest(`/api/medications?patient=${patient.profileId}`, { cookie: clin.cookie })
  );
  assert.equal(read.status, 200, "the inviting clinician can now read");
  const strangerRead = await getMedications(
    jsonRequest(`/api/medications?patient=${patient.profileId}`, { cookie: stranger.cookie })
  );
  assert.equal(strangerRead.status, 403, "consent is scoped to the inviter");

  assert.equal(invitationStatus(db, id), "consented");
  const note = db.prepare("SELECT patient_note FROM patient_invitations WHERE id = ?").get(id) as {
    patient_note: string;
  };
  assert.equal(note.patient_note, "I split the evening tablet");

  // Found by live smoke testing: approval must ALSO close the token for
  // writes — an approved link cannot be replayed into a different decision.
  const replay = await intakeConsentRoute(
    jsonRequest(`/api/intake/${token}/consent`, { method: "POST", cookie: patient.cookie, body: { approve: false } }),
    ctx(token)
  );
  assert.equal(replay.status, 410);
});

test("approving via intake reuses a pre-existing open grant instead of violating uniqueness", async () => {
  const db = useTestDb();
  const clin = createUserSession(db, "clinician");
  const patient = createUserSession(db, "patient");
  // A pending care-code request already exists for the same pair.
  db.prepare(
    `INSERT INTO access_grants (profile_id, clinician_user_id, status, purpose, requested_by_user_id)
     VALUES (?, ?, 'pending', 'Other', ?)`
  ).run(patient.profileId, clin.userId, clin.userId);

  const { token } = await mintInvitation(clin.cookie);
  await walkToSubmitted(token, patient.cookie);
  const consent = await intakeConsentRoute(
    jsonRequest(`/api/intake/${token}/consent`, { method: "POST", cookie: patient.cookie, body: { approve: true } }),
    ctx(token)
  );
  assert.equal(consent.status, 200);

  const open = db
    .prepare("SELECT COUNT(*) AS n FROM access_grants WHERE profile_id = ? AND clinician_user_id = ?")
    .get(patient.profileId, clin.userId) as { n: number };
  assert.equal(open.n, 1, "the pending grant was activated in place — no duplicate row");
});

test("mark_reviewed closes the loop, but only from consented", async () => {
  const db = useTestDb();
  const clin = createUserSession(db, "clinician");
  const patient = createUserSession(db, "patient");
  const { token, id } = await mintInvitation(clin.cookie);

  const early = await invitationActionRoute(
    jsonRequest(`/api/invitations/${id}`, { method: "POST", cookie: clin.cookie, body: { action: "mark_reviewed" } }),
    ctx(`/${id}`)
  );
  assert.equal(early.status, 409, "cannot review before consent");

  await walkToSubmitted(token, patient.cookie);
  await intakeConsentRoute(
    jsonRequest(`/api/intake/${token}/consent`, { method: "POST", cookie: patient.cookie, body: { approve: true } }),
    ctx(token)
  );
  const done = await invitationActionRoute(
    jsonRequest(`/api/invitations/${id}`, { method: "POST", cookie: clin.cookie, body: { action: "mark_reviewed" } }),
    ctx(`/${id}`)
  );
  assert.equal(done.status, 200);
  assert.equal(invitationStatus(db, id), "reviewed");
});

test("the clinician list shows lifecycle timestamps and hides profile ids until consent", async () => {
  const db = useTestDb();
  const clin = createUserSession(db, "clinician");
  const patient = createUserSession(db, "patient");
  const { token } = await mintInvitation(clin.cookie);
  await walkToSubmitted(token, patient.cookie);

  const res = await listInvitationsRoute(jsonRequest("/api/invitations", { cookie: clin.cookie }));
  const inv = (await res.json()).invitations[0];
  assert.equal(inv.status, "intake_submitted");
  assert.ok(inv.opened_at);
  assert.ok(inv.submitted_at);
  assert.equal(inv.profile_id, null, "no profile linkage exposed before the patient consents");
});

test("ACTUAL USE: patients can record how they really take a med; clinicians cannot write it", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  db.prepare(
    `INSERT INTO medications (profile_id, brand_name, verified, dose_value, dose_unit, is_prn, schedule_times, status)
     VALUES (?, 'TYLENOL', 1, 1, 'tablet(s)', 1, '[]', 'active')`
  ).run(patient.profileId);
  const medId = Number((db.prepare("SELECT id FROM medications LIMIT 1").get() as { id: number }).id);

  const patch = await patchMedication(
    jsonRequest(`/api/medications/${medId}`, {
      method: "PATCH",
      cookie: patient.cookie,
      body: { actual_use: "taking_differently", patient_notes: "only half a tablet" },
    }),
    ctx(`/${medId}`)
  );
  assert.equal(patch.status, 200);
  const row = db.prepare("SELECT actual_use, patient_notes, status FROM medications WHERE id = ?").get(medId) as {
    actual_use: string;
    patient_notes: string;
    status: string;
  };
  assert.equal(row.actual_use, "taking_differently");
  assert.equal(row.patient_notes, "only half a tablet");
  assert.equal(row.status, "active", "actual_use is provenance — it never changes the med's status");

  const bad = await patchMedication(
    jsonRequest(`/api/medications/${medId}`, { method: "PATCH", cookie: patient.cookie, body: { actual_use: "nope" } }),
    ctx(`/${medId}`)
  );
  assert.equal(bad.status, 400);

  const clinPatch = await patchMedication(
    jsonRequest(`/api/medications/${medId}?patient=${patient.profileId}`, {
      method: "PATCH",
      cookie: clin.cookie,
      body: { actual_use: "not_taking" },
    }),
    ctx(`/${medId}`)
  );
  assert.equal(clinPatch.status, 403, "clinician writes stay forbidden");
});

test("AUDIT: the invitation lifecycle lands in audit_events", async () => {
  const db = useTestDb();
  const clin = createUserSession(db, "clinician");
  const patient = createUserSession(db, "patient");
  const { token } = await mintInvitation(clin.cookie);
  await walkToSubmitted(token, patient.cookie);
  await intakeConsentRoute(
    jsonRequest(`/api/intake/${token}/consent`, { method: "POST", cookie: patient.cookie, body: { approve: true } }),
    ctx(token)
  );

  const actions = (db.prepare("SELECT action FROM audit_events ORDER BY id").all() as { action: string }[]).map(
    (r) => r.action
  );
  for (const expected of [
    "invitation_created",
    "invitation_opened",
    "invitation_intake_started",
    "invitation_intake_submitted",
    "invitation_consented",
    "access_approved",
  ]) {
    assert.ok(actions.includes(expected), `missing audit action ${expected}`);
  }
});
