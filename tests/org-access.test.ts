// Phase 5 (part 2): the consent boundary under org scoping. The headline
// cases: existing individual grants NEVER become org-visible (never-widen),
// deactivated members fail closed while the grant row stays active, expired
// grants on one door never block the other, and org invitation consents can
// never touch an individual grant row (or vice versa).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { __resetRateLimitsForTests } from "../src/lib/ratelimit";
import { recomputeAlerts } from "../src/lib/conflicts";
import { GET as getMedications } from "../src/app/api/medications/route";
import { GET as rosterGet, POST as careLinksPost } from "../src/app/api/care-links/route";
import { DELETE as careLinkDelete } from "../src/app/api/care-links/[id]/route";
import { POST as accessDecide } from "../src/app/api/access/[id]/route";
import { POST as reviewPost } from "../src/app/api/alert-reviews/route";
import { POST as invitationsPost } from "../src/app/api/invitations/route";
import { GET as intakeMeta } from "../src/app/api/intake/[token]/route";
import { POST as intakeStart } from "../src/app/api/intake/[token]/start/route";
import { POST as intakeSubmit } from "../src/app/api/intake/[token]/submit/route";
import { POST as intakeConsent } from "../src/app/api/intake/[token]/consent/route";
import { POST as memberAction } from "../src/app/api/org/members/[id]/route";
import { POST as inviteMint } from "../src/app/api/org/invites/route";
import { POST as joinRedeem } from "../src/app/api/org/join/[token]/route";
import { addMed, createUserSession, jsonRequest, useTestDb } from "./helpers";
import { makeOrg, joinOrg } from "./org.test";
import type { DatabaseSync } from "node:sqlite";

beforeEach(() => __resetRateLimitsForTests());

const idCtx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });
const tokenCtx = (token: string) => ({ params: Promise.resolve({ token }) });

function shareCode(db: DatabaseSync, profileId: number): string {
  return (db.prepare("SELECT share_code FROM profiles WHERE id = ?").get(profileId) as { share_code: string }).share_code;
}

async function requestAsOrg(
  db: DatabaseSync,
  memberCookie: string,
  patientProfileId: number,
  locationId: number
): Promise<number> {
  const res = await careLinksPost(
    jsonRequest("/api/care-links", {
      method: "POST",
      cookie: memberCookie,
      body: { code: shareCode(db, patientProfileId), as_org: true, location_id: locationId, purpose: "Medication review" },
    })
  );
  assert.equal(res.status, 200);
  return (await res.json()).grant_id as number;
}

async function approve(db: DatabaseSync, patientCookie: string, grantId: number, expiresDays: number | null = null) {
  const res = await accessDecide(
    jsonRequest(`/api/access/${grantId}`, {
      method: "POST",
      cookie: patientCookie,
      body: { action: "approve", expires_days: expiresDays },
    }),
    idCtx(grantId)
  );
  assert.equal(res.status, 200);
}

async function readMeds(cookie: string, profileId: number) {
  return getMedications(jsonRequest(`/api/medications?patient=${profileId}`, { cookie }));
}

test("ORG REQUEST: grant carries org+location+requester; non-members and bad locations refused", async () => {
  const db = useTestDb();
  const { owner, orgId, locationId } = await makeOrg(db);
  const other = await makeOrg(db, "Other Org");
  const patient = createUserSession(db, "patient");

  const outsider = createUserSession(db, "clinician");
  const noMember = await careLinksPost(
    jsonRequest("/api/care-links", {
      method: "POST",
      cookie: outsider.cookie,
      body: { code: shareCode(db, patient.profileId!), as_org: true, location_id: locationId },
    })
  );
  assert.equal(noMember.status, 403);

  const wrongLocation = await careLinksPost(
    jsonRequest("/api/care-links", {
      method: "POST",
      cookie: owner.cookie,
      body: { code: shareCode(db, patient.profileId!), as_org: true, location_id: other.locationId },
    })
  );
  assert.equal(wrongLocation.status, 400, "location must belong to the caller's org");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM access_grants").get() as { n: number }).n,
    0,
    "failed requests create nothing"
  );

  const grantId = await requestAsOrg(db, owner.cookie, patient.profileId!, locationId);
  const grant = db.prepare("SELECT * FROM access_grants WHERE id = ?").get(grantId) as {
    organization_id: number;
    location_id: number;
    requested_by_user_id: number;
  };
  assert.equal(grant.organization_id, orgId);
  assert.equal(grant.location_id, locationId);
  assert.equal(grant.requested_by_user_id, owner.userId);
});

test("DUPLICATE SCOPING: one open org request per (patient, org) across requesters; individual + org coexist", async () => {
  const db = useTestDb();
  const { owner, locationId } = await makeOrg(db);
  const { session: pharmacist } = await joinOrg(db, owner.cookie, "pharmacist");
  const patient = createUserSession(db, "patient");

  await requestAsOrg(db, owner.cookie, patient.profileId!, locationId);
  const second = await careLinksPost(
    jsonRequest("/api/care-links", {
      method: "POST",
      cookie: pharmacist.cookie,
      body: { code: shareCode(db, patient.profileId!), as_org: true, location_id: locationId },
    })
  );
  assert.equal(second.status, 409, "the org already has an open request");

  // The SAME clinician can still hold an individual request simultaneously.
  const individual = await careLinksPost(
    jsonRequest("/api/care-links", {
      method: "POST",
      cookie: owner.cookie,
      body: { code: shareCode(db, patient.profileId!) },
    })
  );
  assert.equal(individual.status, 200, "split unique indexes allow both doors");
});

test("ORG APPROVAL: every active member reads; strangers and other orgs never do", async () => {
  const db = useTestDb();
  const { owner, orgId, locationId } = await makeOrg(db);
  const { session: staff } = await joinOrg(db, owner.cookie, "staff");
  const otherOrg = await makeOrg(db, "Other Org");
  const loner = createUserSession(db, "clinician");
  const patient = createUserSession(db, "patient");
  addMed(db, patient.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });

  const grantId = await requestAsOrg(db, owner.cookie, patient.profileId!, locationId);
  await approve(db, patient.cookie, grantId, 90);

  assert.equal((await readMeds(owner.cookie, patient.profileId!)).status, 200, "requester reads");
  assert.equal((await readMeds(staff.cookie, patient.profileId!)).status, 200, "co-member reads");
  assert.equal((await readMeds(loner.cookie, patient.profileId!)).status, 403, "memberless stranger blocked");
  assert.equal((await readMeds(otherOrg.owner.cookie, patient.profileId!)).status, 403, "other org blocked");

  const opened = db
    .prepare("SELECT meta FROM audit_events WHERE action = 'record_opened' ORDER BY id DESC LIMIT 1")
    .get() as { meta: string };
  const meta = JSON.parse(opened.meta);
  assert.equal(meta.via, "org");
  assert.equal(meta.org, orgId);
});

test("NEVER-WIDEN CORE: joining an org does not expose pre-existing individual patients to co-members", async () => {
  const db = useTestDb();
  const clinician = createUserSession(db, "clinician");
  const patient = createUserSession(db, "patient");
  addMed(db, patient.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });

  // Individual consent first (pre-org world).
  const req = await careLinksPost(
    jsonRequest("/api/care-links", { method: "POST", cookie: clinician.cookie, body: { code: shareCode(db, patient.profileId!) } })
  );
  await approve(db, patient.cookie, (await req.json()).grant_id);

  // The clinician then joins an org that also has an unrelated co-member.
  const { owner } = await makeOrg(db, "Late Org");
  const { session: coMember } = await joinOrg(db, owner.cookie, "pharmacist");
  const mint = await inviteMint(
    jsonRequest("/api/org/invites", { method: "POST", cookie: owner.cookie, body: { org_role: "pharmacist" } })
  );
  const token = ((await mint.json()).join_path as string).replace("/join-org/", "");
  const joinRes = await joinRedeem(
    jsonRequest(`/api/org/join/${token}`, { method: "POST", cookie: clinician.cookie }),
    tokenCtx(token)
  );
  assert.equal(joinRes.status, 200);

  assert.equal((await readMeds(coMember.cookie, patient.profileId!)).status, 403, "co-member never inherits");
  const mine = await readMeds(clinician.cookie, patient.profileId!);
  assert.equal(mine.status, 200, "the individual grant still works for its holder");
  const grant = db.prepare("SELECT organization_id FROM access_grants WHERE clinician_user_id = ?").get(clinician.userId) as {
    organization_id: number | null;
  };
  assert.equal(grant.organization_id, null, "the grant row was never rewritten");

  const roster = await (await rosterGet(jsonRequest("/api/care-links", { cookie: coMember.cookie }))).json();
  assert.equal(roster.roster.length, 0, "co-member roster excludes individual-only patients");
});

test("DEACTIVATED MEMBER FAILS CLOSED while the grant stays active; their individual grants survive", async () => {
  const db = useTestDb();
  const { owner, locationId } = await makeOrg(db);
  const { session: pharmacist, memberRowId } = await joinOrg(db, owner.cookie, "pharmacist");
  const orgPatient = createUserSession(db, "patient");
  const personalPatient = createUserSession(db, "patient");
  addMed(db, orgPatient.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });

  const orgGrant = await requestAsOrg(db, pharmacist.cookie, orgPatient.profileId!, locationId);
  await approve(db, orgPatient.cookie, orgGrant);
  const indReq = await careLinksPost(
    jsonRequest("/api/care-links", { method: "POST", cookie: pharmacist.cookie, body: { code: shareCode(db, personalPatient.profileId!) } })
  );
  await approve(db, personalPatient.cookie, (await indReq.json()).grant_id);

  assert.equal((await readMeds(pharmacist.cookie, orgPatient.profileId!)).status, 200);

  await memberAction(
    jsonRequest(`/api/org/members/${memberRowId}`, { method: "POST", cookie: owner.cookie, body: { action: "deactivate" } }),
    idCtx(memberRowId)
  );

  assert.equal((await readMeds(pharmacist.cookie, orgPatient.profileId!)).status, 403, "next read fails closed");
  assert.equal((await readMeds(owner.cookie, orgPatient.profileId!)).status, 200, "other members unaffected");
  const grant = db.prepare("SELECT status FROM access_grants WHERE id = ?").get(orgGrant) as { status: string };
  assert.equal(grant.status, "active", "the grant row itself was never mutated");
  assert.equal(
    (await readMeds(pharmacist.cookie, personalPatient.profileId!)).status,
    200,
    "personal consents are outside the org's authority"
  );
});

test("EXPIRY ORDERING: an expired door never blocks the live one (both directions)", async () => {
  const db = useTestDb();
  const { owner, locationId } = await makeOrg(db);
  const patient = createUserSession(db, "patient");
  addMed(db, patient.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });

  // Individual EXPIRED + org LIVE.
  const indReq = await careLinksPost(
    jsonRequest("/api/care-links", { method: "POST", cookie: owner.cookie, body: { code: shareCode(db, patient.profileId!) } })
  );
  const indId = (await indReq.json()).grant_id as number;
  await approve(db, patient.cookie, indId);
  db.prepare("UPDATE access_grants SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), indId);
  const orgGrant = await requestAsOrg(db, owner.cookie, patient.profileId!, locationId);
  await approve(db, patient.cookie, orgGrant);

  const read = await readMeds(owner.cookie, patient.profileId!);
  assert.equal(read.status, 200, "live org grant wins; expired individual is swept, not blocking");
  const swept = db.prepare("SELECT status FROM access_grants WHERE id = ?").get(indId) as { status: string };
  assert.equal(swept.status, "expired", "lazy expiry still recorded");

  // Reverse: org EXPIRED + individual LIVE.
  const db2 = useTestDb();
  __resetRateLimitsForTests();
  const org2 = await makeOrg(db2);
  const patient2 = createUserSession(db2, "patient");
  addMed(db2, patient2.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });
  const orgG = await requestAsOrg(db2, org2.owner.cookie, patient2.profileId!, org2.locationId);
  await approve(db2, patient2.cookie, orgG);
  db2.prepare("UPDATE access_grants SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), orgG);
  const ind2 = await careLinksPost(
    jsonRequest("/api/care-links", { method: "POST", cookie: org2.owner.cookie, body: { code: shareCode(db2, patient2.profileId!) } })
  );
  await approve(db2, patient2.cookie, (await ind2.json()).grant_id);
  assert.equal((await readMeds(org2.owner.cookie, patient2.profileId!)).status, 200, "live individual wins");
});

test("REVOCATION: one patient click cuts off the whole org; separate individual door survives", async () => {
  const db = useTestDb();
  const { owner, locationId } = await makeOrg(db);
  const { session: staff } = await joinOrg(db, owner.cookie, "staff");
  const patient = createUserSession(db, "patient");
  addMed(db, patient.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });

  const orgGrant = await requestAsOrg(db, owner.cookie, patient.profileId!, locationId);
  await approve(db, patient.cookie, orgGrant);
  const ind = await careLinksPost(
    jsonRequest("/api/care-links", { method: "POST", cookie: owner.cookie, body: { code: shareCode(db, patient.profileId!) } })
  );
  const indId = (await ind.json()).grant_id as number;
  await approve(db, patient.cookie, indId);

  const revoke = await accessDecide(
    jsonRequest(`/api/access/${orgGrant}`, { method: "POST", cookie: patient.cookie, body: { action: "revoke" } }),
    idCtx(orgGrant)
  );
  assert.equal(revoke.status, 200);

  assert.equal((await readMeds(staff.cookie, patient.profileId!)).status, 403, "every member loses org access");
  assert.equal((await readMeds(owner.cookie, patient.profileId!)).status, 200, "the separate individual grant survives");

  await accessDecide(
    jsonRequest(`/api/access/${indId}`, { method: "POST", cookie: patient.cookie, body: { action: "revoke" } }),
    idCtx(indId)
  );
  assert.equal((await readMeds(owner.cookie, patient.profileId!)).status, 403, "now fully closed");
});

test("ROSTER: dedupe with both scopes; staff see org patients but never individual-only ones; pending visibility tiers", async () => {
  const db = useTestDb();
  const { owner, locationId } = await makeOrg(db);
  const { session: staff } = await joinOrg(db, owner.cookie, "staff");
  const { session: pharmacist } = await joinOrg(db, owner.cookie, "pharmacist");
  const patient = createUserSession(db, "patient");
  addMed(db, patient.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });

  const orgGrant = await requestAsOrg(db, owner.cookie, patient.profileId!, locationId);
  await approve(db, patient.cookie, orgGrant);
  const ind = await careLinksPost(
    jsonRequest("/api/care-links", { method: "POST", cookie: owner.cookie, body: { code: shareCode(db, patient.profileId!) } })
  );
  await approve(db, patient.cookie, (await ind.json()).grant_id);

  const ownerRoster = await (await rosterGet(jsonRequest("/api/care-links", { cookie: owner.cookie }))).json();
  assert.equal(ownerRoster.roster.length, 1, "one deduped row per patient");
  assert.equal(ownerRoster.roster[0].access.length, 2, "both doors listed");

  const staffRoster = await (await rosterGet(jsonRequest("/api/care-links", { cookie: staff.cookie }))).json();
  assert.equal(staffRoster.roster.length, 1, "staff see org-granted patients");
  assert.equal(staffRoster.roster[0].access.length, 1, "but not the owner's individual door");

  // Pending org request from the pharmacist: visible to requester + management, not to staff.
  const other = createUserSession(db, "patient");
  await requestAsOrg(db, pharmacist.cookie, other.profileId!, locationId);
  const pharmPending = await (await rosterGet(jsonRequest("/api/care-links", { cookie: pharmacist.cookie }))).json();
  assert.equal(pharmPending.pending.length, 1, "requester sees their pending");
  const ownerPending = await (await rosterGet(jsonRequest("/api/care-links", { cookie: owner.cookie }))).json();
  assert.equal(ownerPending.pending.length, 1, "management sees org pendings");
  const staffPending = await (await rosterGet(jsonRequest("/api/care-links", { cookie: staff.cookie }))).json();
  assert.equal(staffPending.pending.length, 0, "staff never see unapproved patient names");
});

test("CLINICIAN-SIDE REMOVAL: org-active is management-only; org-pending withdrawable by requester", async () => {
  const db = useTestDb();
  const { owner, locationId } = await makeOrg(db);
  const { session: pharmacist } = await joinOrg(db, owner.cookie, "pharmacist");
  const patient = createUserSession(db, "patient");
  addMed(db, patient.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });

  const orgGrant = await requestAsOrg(db, pharmacist.cookie, patient.profileId!, locationId);
  await approve(db, patient.cookie, orgGrant);

  const byPharmacist = await careLinkDelete(
    jsonRequest(`/api/care-links/${orgGrant}`, { method: "DELETE", cookie: pharmacist.cookie }),
    idCtx(orgGrant)
  );
  assert.equal(byPharmacist.status, 403, "active org access is destroyed only by management");

  const byOwner = await careLinkDelete(
    jsonRequest(`/api/care-links/${orgGrant}`, { method: "DELETE", cookie: owner.cookie }),
    idCtx(orgGrant)
  );
  assert.equal(byOwner.status, 200);
  assert.equal((await readMeds(pharmacist.cookie, patient.profileId!)).status, 403);

  // Pending withdrawal by its requester works.
  const other = createUserSession(db, "patient");
  const pendingId = await requestAsOrg(db, pharmacist.cookie, other.profileId!, locationId);
  const withdraw = await careLinkDelete(
    jsonRequest(`/api/care-links/${pendingId}`, { method: "DELETE", cookie: pharmacist.cookie }),
    idCtx(pendingId)
  );
  assert.equal(withdraw.status, 200);
});

test("UPGRADE PATH: needs an active individual grant; creates a PENDING org card only", async () => {
  const db = useTestDb();
  const { owner, orgId, locationId } = await makeOrg(db);
  const { session: staff } = await joinOrg(db, owner.cookie, "staff");
  const patient = createUserSession(db, "patient");
  addMed(db, patient.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });

  const noGrant = await careLinksPost(
    jsonRequest("/api/care-links", {
      method: "POST",
      cookie: owner.cookie,
      body: { upgrade_profile_id: patient.profileId, location_id: locationId },
    })
  );
  assert.equal(noGrant.status, 404, "no individual grant → nothing to upgrade");

  const ind = await careLinksPost(
    jsonRequest("/api/care-links", { method: "POST", cookie: owner.cookie, body: { code: shareCode(db, patient.profileId!) } })
  );
  await approve(db, patient.cookie, (await ind.json()).grant_id);

  const upgrade = await careLinksPost(
    jsonRequest("/api/care-links", {
      method: "POST",
      cookie: owner.cookie,
      body: { upgrade_profile_id: patient.profileId, location_id: locationId },
    })
  );
  assert.equal(upgrade.status, 200);
  const orgGrantId = (await upgrade.json()).grant_id as number;
  const row = db.prepare("SELECT status, organization_id FROM access_grants WHERE id = ?").get(orgGrantId) as {
    status: string;
    organization_id: number;
  };
  assert.equal(row.status, "pending", "the patient still explicitly approves the org card");
  assert.equal(row.organization_id, orgId);
  assert.equal((await readMeds(staff.cookie, patient.profileId!)).status, 403, "nothing widened before approval");
});

test("REVIEWS under org access: pharmacist/owner may review (org-named), admin/staff and deactivated requesters 403", async () => {
  const db = useTestDb();
  const { owner, locationId } = await makeOrg(db);
  const { session: pharmacist } = await joinOrg(db, owner.cookie, "pharmacist");
  const { session: admin } = await joinOrg(db, owner.cookie, "admin");
  const { session: staff } = await joinOrg(db, owner.cookie, "staff");
  const patient = createUserSession(db, "patient");
  addMed(db, patient.profileId!, { name: "APO-WARFARIN", ingredients: [{ name: "WARFARIN SODIUM", strength: "1" }] });
  addMed(db, patient.profileId!, { name: "ADVIL", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });

  const orgGrant = await requestAsOrg(db, staff.cookie, patient.profileId!, locationId);
  await approve(db, patient.cookie, orgGrant);
  const { all } = recomputeAlerts(db, patient.profileId!);
  const alertId = all[0].id;

  const reviewBody = { alert_id: alertId, note: "Intentional and monitored.", expires_days: 90 };
  for (const blocked of [admin, staff]) {
    const res = await reviewPost(jsonRequest("/api/alert-reviews", { method: "POST", cookie: blocked.cookie, body: reviewBody }));
    assert.equal(res.status, 403, "the management tier is not the clinical tier");
  }

  const ok = await reviewPost(jsonRequest("/api/alert-reviews", { method: "POST", cookie: pharmacist.cookie, body: reviewBody }));
  assert.equal(ok.status, 200);
  const review = (await ok.json()).review as { reviewer_clinic: string };
  assert.equal(review.reviewer_clinic, "Wortley Pharmacy", "org-authored reviews carry the org name");

  // The judged fail-open: the ORIGINAL REQUESTER, deactivated, must be 403.
  const staffRow = Number(
    (db.prepare("SELECT id FROM organization_members WHERE user_id = ?").get(staff.userId) as { id: number }).id
  );
  await memberAction(
    jsonRequest(`/api/org/members/${staffRow}`, { method: "POST", cookie: owner.cookie, body: { action: "deactivate" } }),
    idCtx(staffRow)
  );
  const afterDeactivation = await reviewPost(
    jsonRequest("/api/alert-reviews", { method: "POST", cookie: staff.cookie, body: reviewBody })
  );
  assert.equal(afterDeactivation.status, 403, "deactivated requester cannot ride the org grant");
});

test("ORG INVITATION full path + staleness: consent yields an org grant; minter deactivation kills the link", async () => {
  const db = useTestDb();
  const { owner, orgId, locationId } = await makeOrg(db);
  const { session: pharmacist, memberRowId } = await joinOrg(db, owner.cookie, "pharmacist");
  const patient = createUserSession(db, "patient");

  const mint = await invitationsPost(
    jsonRequest("/api/invitations", {
      method: "POST",
      cookie: pharmacist.cookie,
      body: { purpose: "Medication review", expires_days: 7, as_org: true, location_id: locationId },
    })
  );
  assert.equal(mint.status, 200);
  const token = ((await mint.json()).intake_path as string).replace("/intake/", "");

  const meta = await (await intakeMeta(jsonRequest(`/api/intake/${token}`), tokenCtx(token))).json();
  assert.equal(meta.organization_name, "Wortley Pharmacy", "the patient sees the ORG before intake");
  assert.equal(meta.org_verification_status, "unverified");

  await intakeStart(jsonRequest(`/api/intake/${token}/start`, { method: "POST", cookie: patient.cookie }), tokenCtx(token));
  await intakeSubmit(jsonRequest(`/api/intake/${token}/submit`, { method: "POST", cookie: patient.cookie, body: {} }), tokenCtx(token));
  const consent = await intakeConsent(
    jsonRequest(`/api/intake/${token}/consent`, { method: "POST", cookie: patient.cookie, body: { approve: true } }),
    tokenCtx(token)
  );
  assert.equal(consent.status, 200);
  const grant = db
    .prepare("SELECT organization_id, location_id FROM access_grants WHERE profile_id = ? AND status = 'active'")
    .get(patient.profileId) as { organization_id: number; location_id: number };
  assert.equal(grant.organization_id, orgId);
  assert.equal(grant.location_id, locationId);
  assert.equal((await readMeds(owner.cookie, patient.profileId!)).status, 200, "co-members read after consent");

  // Staleness: a second org invitation dies when its minter is deactivated.
  const mint2 = await invitationsPost(
    jsonRequest("/api/invitations", {
      method: "POST",
      cookie: pharmacist.cookie,
      body: { purpose: "Medication review", expires_days: 7, as_org: true, location_id: locationId },
    })
  );
  const token2 = ((await mint2.json()).intake_path as string).replace("/intake/", "");
  const patient2 = createUserSession(db, "patient");
  await intakeStart(jsonRequest(`/api/intake/${token2}/start`, { method: "POST", cookie: patient2.cookie }), tokenCtx(token2));
  await intakeSubmit(jsonRequest(`/api/intake/${token2}/submit`, { method: "POST", cookie: patient2.cookie, body: {} }), tokenCtx(token2));
  await memberAction(
    jsonRequest(`/api/org/members/${memberRowId}`, { method: "POST", cookie: owner.cookie, body: { action: "deactivate" } }),
    idCtx(memberRowId)
  );
  const staleConsent = await intakeConsent(
    jsonRequest(`/api/intake/${token2}/consent`, { method: "POST", cookie: patient2.cookie, body: { approve: true } }),
    tokenCtx(token2)
  );
  assert.equal(staleConsent.status, 410, "a deactivated employee's link can never mint org access");
  const inv = db.prepare("SELECT status FROM patient_invitations ORDER BY id DESC LIMIT 1").get() as { status: string };
  assert.equal(inv.status, "cancelled");
  const grants2 = db
    .prepare("SELECT COUNT(*) AS n FROM access_grants WHERE profile_id = ?")
    .get(patient2.profileId) as { n: number };
  assert.equal(grants2.n, 0, "zero grants created");
});

test("REUSE-SCOPE REGRESSION: org consents activate org rows; individual consents never touch org rows", async () => {
  const db = useTestDb();
  const { owner, orgId, locationId } = await makeOrg(db);
  const patient = createUserSession(db, "patient");

  // (a) A pending org care-code request is activated IN PLACE by an org invitation consent.
  await requestAsOrg(db, owner.cookie, patient.profileId!, locationId);
  const mint = await invitationsPost(
    jsonRequest("/api/invitations", {
      method: "POST",
      cookie: owner.cookie,
      body: { purpose: "Medication review", expires_days: 7, as_org: true, location_id: locationId },
    })
  );
  const token = ((await mint.json()).intake_path as string).replace("/intake/", "");
  await intakeStart(jsonRequest(`/api/intake/${token}/start`, { method: "POST", cookie: patient.cookie }), tokenCtx(token));
  await intakeSubmit(jsonRequest(`/api/intake/${token}/submit`, { method: "POST", cookie: patient.cookie, body: {} }), tokenCtx(token));
  await intakeConsent(
    jsonRequest(`/api/intake/${token}/consent`, { method: "POST", cookie: patient.cookie, body: { approve: true } }),
    tokenCtx(token)
  );
  const orgRows = db
    .prepare("SELECT id, status FROM access_grants WHERE profile_id = ? AND organization_id = ?")
    .all(patient.profileId, orgId) as { id: number; status: string }[];
  assert.equal(orgRows.length, 1, "exactly one (patient, org) row — activated in place");
  assert.equal(orgRows[0].status, "active");

  // (b) An INDIVIDUAL invitation from the same clinician must create a
  // separate NULL-org grant and leave the org row untouched.
  const mint2 = await invitationsPost(
    jsonRequest("/api/invitations", { method: "POST", cookie: owner.cookie, body: { purpose: "Medication review", expires_days: 7 } })
  );
  const token2 = ((await mint2.json()).intake_path as string).replace("/intake/", "");
  await intakeStart(jsonRequest(`/api/intake/${token2}/start`, { method: "POST", cookie: patient.cookie }), tokenCtx(token2));
  await intakeSubmit(jsonRequest(`/api/intake/${token2}/submit`, { method: "POST", cookie: patient.cookie, body: {} }), tokenCtx(token2));
  await intakeConsent(
    jsonRequest(`/api/intake/${token2}/consent`, { method: "POST", cookie: patient.cookie, body: { approve: true } }),
    tokenCtx(token2)
  );

  const all = db
    .prepare("SELECT organization_id, status FROM access_grants WHERE profile_id = ? ORDER BY id")
    .all(patient.profileId) as { organization_id: number | null; status: string }[];
  assert.equal(all.length, 2, "two doors, two rows");
  assert.ok(all.some((g) => g.organization_id === orgId && g.status === "active"), "org row untouched");
  assert.ok(all.some((g) => g.organization_id === null && g.status === "active"), "individual row created separately");
});
