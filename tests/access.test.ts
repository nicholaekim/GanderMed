// Phase 4: patient-controlled access. Entering a care code creates a
// REQUEST; only the patient's approval opens the record, revocation and
// expiry close it immediately, rotation kills the old code, and everything
// leaves an audit trail.

import { test } from "node:test";
import assert from "node:assert/strict";
import { GET as getMedications } from "../src/app/api/medications/route";
import { POST as requestAccess, GET as getRoster } from "../src/app/api/care-links/route";
import { GET as patientAccessList } from "../src/app/api/access/route";
import { POST as patientDecide } from "../src/app/api/access/[id]/route";
import { POST as rotateCode } from "../src/app/api/profile/rotate-code/route";
import { createUserSession, jsonRequest, useTestDb } from "./helpers";
import type { DatabaseSync } from "node:sqlite";

function shareCodeOf(db: DatabaseSync, profileId: number): string {
  return (db.prepare("SELECT share_code FROM profiles WHERE id = ?").get(profileId) as { share_code: string })
    .share_code;
}

async function requestAndGetGrantId(
  db: DatabaseSync,
  clinCookie: string,
  code: string
): Promise<number> {
  const res = await requestAccess(
    jsonRequest("/api/care-links", { method: "POST", cookie: clinCookie, body: { code, purpose: "Medication review" } })
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "pending");
  return data.grant_id as number;
}

async function approve(db: DatabaseSync, patientCookie: string, grantId: number, expiresDays: number | null = null) {
  const res = await patientDecide(
    jsonRequest(`/api/access/${grantId}`, {
      method: "POST",
      cookie: patientCookie,
      body: { action: "approve", expires_days: expiresDays },
    }),
    { params: Promise.resolve({ id: String(grantId) }) }
  );
  assert.equal(res.status, 200);
}

function readRecord(clinCookie: string, profileId: number) {
  return getMedications(jsonRequest(`/api/medications?patient=${profileId}`, { cookie: clinCookie }));
}

test("a pending (unapproved) request does NOT open the record", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  await requestAndGetGrantId(db, clin.cookie, shareCodeOf(db, patient.profileId!));

  const res = await readRecord(clin.cookie, patient.profileId!);
  assert.equal(res.status, 403);
});

test("patient approval opens the record; an unrelated clinician stays blocked", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  const stranger = createUserSession(db, "clinician");
  const grantId = await requestAndGetGrantId(db, clin.cookie, shareCodeOf(db, patient.profileId!));
  await approve(db, patient.cookie, grantId);

  assert.equal((await readRecord(clin.cookie, patient.profileId!)).status, 200);
  assert.equal((await readRecord(stranger.cookie, patient.profileId!)).status, 403);
});

test("patient revocation blocks the very next read", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  const grantId = await requestAndGetGrantId(db, clin.cookie, shareCodeOf(db, patient.profileId!));
  await approve(db, patient.cookie, grantId);
  assert.equal((await readRecord(clin.cookie, patient.profileId!)).status, 200);

  const revoke = await patientDecide(
    jsonRequest(`/api/access/${grantId}`, { method: "POST", cookie: patient.cookie, body: { action: "revoke" } }),
    { params: Promise.resolve({ id: String(grantId) }) }
  );
  assert.equal(revoke.status, 200);
  assert.equal((await readRecord(clin.cookie, patient.profileId!)).status, 403);
});

test("expiry blocks access and flips the grant to expired", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  const grantId = await requestAndGetGrantId(db, clin.cookie, shareCodeOf(db, patient.profileId!));
  await approve(db, patient.cookie, grantId, 30);

  db.prepare("UPDATE access_grants SET expires_at = ? WHERE id = ?").run(
    new Date(Date.now() - 1000).toISOString(),
    grantId
  );
  assert.equal((await readRecord(clin.cookie, patient.profileId!)).status, 403);
  const status = (db.prepare("SELECT status FROM access_grants WHERE id = ?").get(grantId) as { status: string }).status;
  assert.equal(status, "expired");
});

test("a denied request never becomes access", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  const grantId = await requestAndGetGrantId(db, clin.cookie, shareCodeOf(db, patient.profileId!));

  const deny = await patientDecide(
    jsonRequest(`/api/access/${grantId}`, { method: "POST", cookie: patient.cookie, body: { action: "deny" } }),
    { params: Promise.resolve({ id: String(grantId) }) }
  );
  assert.equal(deny.status, 200);
  assert.equal((await readRecord(clin.cookie, patient.profileId!)).status, 403);
});

test("patients see their grants and only patients can decide them", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  const grantId = await requestAndGetGrantId(db, clin.cookie, shareCodeOf(db, patient.profileId!));

  const list = await patientAccessList(jsonRequest("/api/access", { cookie: patient.cookie }));
  assert.equal(list.status, 200);
  const grants = (await list.json()).grants;
  assert.equal(grants.length, 1);
  assert.equal(grants[0].status, "pending");

  // The requesting clinician cannot approve their own request.
  const selfApprove = await patientDecide(
    jsonRequest(`/api/access/${grantId}`, { method: "POST", cookie: clin.cookie, body: { action: "approve" } }),
    { params: Promise.resolve({ id: String(grantId) }) }
  );
  assert.equal(selfApprove.status, 403);
});

test("care-code rotation invalidates the old code for new requests", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  const oldCode = shareCodeOf(db, patient.profileId!);

  const rotate = await rotateCode(jsonRequest("/api/profile/rotate-code", { method: "POST", cookie: patient.cookie }));
  assert.equal(rotate.status, 200);
  const newCode = (await rotate.json()).share_code as string;
  assert.notEqual(newCode, oldCode);

  const stale = await requestAccess(
    jsonRequest("/api/care-links", { method: "POST", cookie: clin.cookie, body: { code: oldCode, purpose: "Medication review" } })
  );
  assert.equal(stale.status, 404, "old code must stop creating requests");
});

test("the lifecycle writes audit events (request, approve, open, revoke, rotate)", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  const grantId = await requestAndGetGrantId(db, clin.cookie, shareCodeOf(db, patient.profileId!));
  await approve(db, patient.cookie, grantId);
  await readRecord(clin.cookie, patient.profileId!);
  await patientDecide(
    jsonRequest(`/api/access/${grantId}`, { method: "POST", cookie: patient.cookie, body: { action: "revoke" } }),
    { params: Promise.resolve({ id: String(grantId) }) }
  );
  await rotateCode(jsonRequest("/api/profile/rotate-code", { method: "POST", cookie: patient.cookie }));

  const actions = (
    db.prepare("SELECT action FROM audit_events WHERE profile_id = ? ORDER BY id").all(patient.profileId) as {
      action: string;
    }[]
  ).map((r) => r.action);
  for (const expected of ["access_requested", "access_approved", "record_opened", "access_revoked", "care_code_rotated"]) {
    assert.ok(actions.includes(expected), `audit trail must contain ${expected} (got: ${actions.join(", ")})`);
  }
});

test("migrated legacy care_links become active grants once, idempotently", () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  db.prepare("INSERT INTO care_links (clinician_user_id, profile_id) VALUES (?, ?)").run(clin.userId, patient.profileId);

  // Re-run the migration block the way a server restart would.
  db.exec(
    `INSERT INTO access_grants (profile_id, clinician_user_id, status, purpose, requested_by_user_id, decided_at, starts_at)
     SELECT cl.profile_id, cl.clinician_user_id, 'active', 'Migrated from prototype care-code link', cl.clinician_user_id, cl.created_at, cl.created_at
     FROM care_links cl
     WHERE NOT EXISTS (
       SELECT 1 FROM access_grants g
       WHERE g.profile_id = cl.profile_id AND g.clinician_user_id = cl.clinician_user_id
     )`
  );
  db.exec(
    `INSERT INTO access_grants (profile_id, clinician_user_id, status, purpose, requested_by_user_id, decided_at, starts_at)
     SELECT cl.profile_id, cl.clinician_user_id, 'active', 'Migrated from prototype care-code link', cl.clinician_user_id, cl.created_at, cl.created_at
     FROM care_links cl
     WHERE NOT EXISTS (
       SELECT 1 FROM access_grants g
       WHERE g.profile_id = cl.profile_id AND g.clinician_user_id = cl.clinician_user_id
     )`
  );
  const n = (db.prepare("SELECT COUNT(*) AS n FROM access_grants").get() as { n: number }).n;
  assert.equal(n, 1, "exactly one grant regardless of how many times migration runs");
});

test("roster lists only approved patients; pending shows separately", async () => {
  const db = useTestDb();
  const approved = createUserSession(db, "patient");
  const pendingPatient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");

  const g1 = await requestAndGetGrantId(db, clin.cookie, shareCodeOf(db, approved.profileId!));
  await approve(db, approved.cookie, g1);
  await requestAndGetGrantId(db, clin.cookie, shareCodeOf(db, pendingPatient.profileId!));

  const res = await getRoster(jsonRequest("/api/care-links", { cookie: clin.cookie }));
  const data = await res.json();
  assert.equal(data.roster.length, 1);
  assert.equal(data.pending.length, 1);
});
