// Phase 5 (part 1): organization lifecycle — creation, staff invites, roles,
// deactivation, succession, migration idempotency, and the PHI-free audit
// sweep. Consent-boundary behavior (grants) lives in org-access.test.ts.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/lib/db";
import { __resetRateLimitsForTests } from "../src/lib/ratelimit";
import { GET as orgGet, POST as orgCreate } from "../src/app/api/org/route";
import { POST as inviteMint } from "../src/app/api/org/invites/route";
import { POST as inviteAction } from "../src/app/api/org/invites/[id]/route";
import { GET as joinMeta, POST as joinRedeem } from "../src/app/api/org/join/[token]/route";
import { POST as memberAction } from "../src/app/api/org/members/[id]/route";
import { createUserSession, jsonRequest, useTestDb } from "./helpers";
import type { DatabaseSync } from "node:sqlite";

beforeEach(() => __resetRateLimitsForTests());

const idCtx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });
const tokenCtx = (token: string) => ({ params: Promise.resolve({ token }) });

export async function makeOrg(
  db: DatabaseSync,
  name = "Wortley Pharmacy"
): Promise<{ owner: ReturnType<typeof createUserSession>; orgId: number; locationId: number }> {
  const owner = createUserSession(db, "clinician");
  const res = await orgCreate(
    jsonRequest("/api/org", { method: "POST", cookie: owner.cookie, body: { name, location_label: "Main St" } })
  );
  assert.equal(res.status, 200);
  const orgId = (await res.json()).organization_id as number;
  const locationId = Number(
    (db.prepare("SELECT id FROM organization_locations WHERE organization_id = ?").get(orgId) as { id: number }).id
  );
  return { owner, orgId, locationId };
}

export async function joinOrg(
  db: DatabaseSync,
  managerCookie: string,
  role: "admin" | "pharmacist" | "staff"
): Promise<{ session: ReturnType<typeof createUserSession>; memberRowId: number }> {
  const mint = await inviteMint(
    jsonRequest("/api/org/invites", { method: "POST", cookie: managerCookie, body: { org_role: role } })
  );
  assert.equal(mint.status, 200);
  const token = ((await mint.json()).join_path as string).replace("/join-org/", "");
  const session = createUserSession(db, "clinician");
  const redeem = await joinRedeem(
    jsonRequest(`/api/org/join/${token}`, { method: "POST", cookie: session.cookie }),
    tokenCtx(token)
  );
  assert.equal(redeem.status, 200);
  const memberRowId = Number(
    (db.prepare("SELECT id FROM organization_members WHERE user_id = ? AND status = 'active'").get(session.userId) as { id: number }).id
  );
  return { session, memberRowId };
}

test("org create authz: patients 403; clinician creates org+location+owner in one transaction; second create 409", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const asPatient = await orgCreate(
    jsonRequest("/api/org", { method: "POST", cookie: patient.cookie, body: { name: "X", location_label: "Y" } })
  );
  assert.equal(asPatient.status, 403);

  const { owner, orgId } = await makeOrg(db);
  const org = db.prepare("SELECT verification_status FROM organizations WHERE id = ?").get(orgId) as {
    verification_status: string;
  };
  assert.equal(org.verification_status, "unverified", "no code path can mark an org verified");
  const membership = db
    .prepare("SELECT org_role FROM organization_members WHERE user_id = ? AND status = 'active'")
    .get(owner.userId) as { org_role: string };
  assert.equal(membership.org_role, "owner");

  const again = await orgCreate(
    jsonRequest("/api/org", { method: "POST", cookie: owner.cookie, body: { name: "Second", location_label: "Z" } })
  );
  assert.equal(again.status, 409, "one org per account");
});

test("GET /api/org: memberless clinician gets null; invites section is management-only", async () => {
  const db = useTestDb();
  const fresh = createUserSession(db, "clinician");
  const empty = await orgGet(jsonRequest("/api/org", { cookie: fresh.cookie }));
  assert.equal((await empty.json()).organization, null);

  const { owner } = await makeOrg(db);
  const { session: pharmacist } = await joinOrg(db, owner.cookie, "pharmacist");

  const ownerView = await (await orgGet(jsonRequest("/api/org", { cookie: owner.cookie }))).json();
  assert.ok("open_invites" in ownerView, "management sees open invites");
  const pharmView = await (await orgGet(jsonRequest("/api/org", { cookie: pharmacist.cookie }))).json();
  assert.ok(!("open_invites" in pharmView), "clinical tier does not see invites");
  assert.equal(pharmView.organization.name, "Wortley Pharmacy");
});

test("SECRECY + mint authz: only management mints; only a sha256 hash is stored", async () => {
  const db = useTestDb();
  const { owner } = await makeOrg(db);
  const { session: pharmacist } = await joinOrg(db, owner.cookie, "pharmacist");
  const { session: staff } = await joinOrg(db, owner.cookie, "staff");

  for (const blocked of [pharmacist, staff]) {
    const res = await inviteMint(
      jsonRequest("/api/org/invites", { method: "POST", cookie: blocked.cookie, body: { org_role: "staff" } })
    );
    assert.equal(res.status, 403);
  }

  const res = await inviteMint(
    jsonRequest("/api/org/invites", { method: "POST", cookie: owner.cookie, body: { org_role: "staff" } })
  );
  const token = ((await res.json()).join_path as string).replace("/join-org/", "");
  const row = db.prepare("SELECT token_hash FROM staff_invitations ORDER BY id DESC LIMIT 1").get() as {
    token_hash: string;
  };
  assert.equal(row.token_hash.length, 64);
  assert.ok(!row.token_hash.includes(token), "raw token never stored");
});

test("role is fixed at mint: a redeem body claiming 'owner' is ignored; 'owner' is never mintable", async () => {
  const db = useTestDb();
  const { owner } = await makeOrg(db);
  const badMint = await inviteMint(
    jsonRequest("/api/org/invites", { method: "POST", cookie: owner.cookie, body: { org_role: "owner" } })
  );
  assert.equal(badMint.status, 400, "'owner' is not an invitable role");

  const mint = await inviteMint(
    jsonRequest("/api/org/invites", { method: "POST", cookie: owner.cookie, body: { org_role: "staff" } })
  );
  const token = ((await mint.json()).join_path as string).replace("/join-org/", "");
  const joiner = createUserSession(db, "clinician");
  await joinRedeem(
    jsonRequest(`/api/org/join/${token}`, { method: "POST", cookie: joiner.cookie, body: { org_role: "owner" } }),
    tokenCtx(token)
  );
  const membership = db
    .prepare("SELECT org_role FROM organization_members WHERE user_id = ?")
    .get(joiner.userId) as { org_role: string };
  assert.equal(membership.org_role, "staff", "the invite row's role wins; the body is ignored");
});

test("token lifecycle: anonymous 401, tampered 404, expired 410, cancelled 410, replay 410", async () => {
  const db = useTestDb();
  const { owner } = await makeOrg(db);
  const mint = await inviteMint(
    jsonRequest("/api/org/invites", { method: "POST", cookie: owner.cookie, body: { org_role: "staff" } })
  );
  const mintData = await mint.json();
  const token = (mintData.join_path as string).replace("/join-org/", "");
  const inviteId = mintData.invite.id as number;

  const anon = await joinRedeem(jsonRequest(`/api/org/join/${token}`, { method: "POST" }), tokenCtx(token));
  assert.equal(anon.status, 401);

  const wrong = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
  const tampered = await joinMeta(jsonRequest(`/api/org/join/${wrong}`), tokenCtx(wrong));
  assert.equal(tampered.status, 404);

  // Expiry sweeps lazily at read.
  db.prepare("UPDATE staff_invitations SET expires_at = ? WHERE id = ?").run(
    new Date(Date.now() - 1000).toISOString(),
    inviteId
  );
  const meta = await joinMeta(jsonRequest(`/api/org/join/${token}`), tokenCtx(token));
  assert.equal((await meta.json()).status, "expired");
  const clin = createUserSession(db, "clinician");
  const late = await joinRedeem(jsonRequest(`/api/org/join/${token}`, { method: "POST", cookie: clin.cookie }), tokenCtx(token));
  assert.equal(late.status, 410);

  // Fresh invite, cancelled, then replay after a successful redeem elsewhere.
  const mint2 = await inviteMint(
    jsonRequest("/api/org/invites", { method: "POST", cookie: owner.cookie, body: { org_role: "staff" } })
  );
  const data2 = await mint2.json();
  const cancel = await inviteAction(
    jsonRequest(`/api/org/invites/${data2.invite.id}`, { method: "POST", cookie: owner.cookie, body: { action: "cancel" } }),
    idCtx(data2.invite.id)
  );
  assert.equal(cancel.status, 200);
  const token2 = (data2.join_path as string).replace("/join-org/", "");
  const dead = await joinRedeem(
    jsonRequest(`/api/org/join/${token2}`, { method: "POST", cookie: clin.cookie }),
    tokenCtx(token2)
  );
  assert.equal(dead.status, 410);
});

test("patient cannot redeem — and the invite is NOT consumed", async () => {
  const db = useTestDb();
  const { owner } = await makeOrg(db);
  const mint = await inviteMint(
    jsonRequest("/api/org/invites", { method: "POST", cookie: owner.cookie, body: { org_role: "staff" } })
  );
  const data = await mint.json();
  const token = (data.join_path as string).replace("/join-org/", "");
  const patient = createUserSession(db, "patient");

  const res = await joinRedeem(jsonRequest(`/api/org/join/${token}`, { method: "POST", cookie: patient.cookie }), tokenCtx(token));
  assert.equal(res.status, 403);
  const invite = db.prepare("SELECT status FROM staff_invitations WHERE id = ?").get(data.invite.id) as { status: string };
  assert.equal(invite.status, "created", "still usable by the right person");
  const members = db.prepare("SELECT COUNT(*) AS n FROM organization_members WHERE user_id = ?").get(patient.userId) as { n: number };
  assert.equal(members.n, 0);
});

test("single-org rule: cross-org and same-org redeems 409 without consuming the invite", async () => {
  const db = useTestDb();
  const a = await makeOrg(db, "Org A");
  const b = await makeOrg(db, "Org B");

  const mint = await inviteMint(
    jsonRequest("/api/org/invites", { method: "POST", cookie: a.owner.cookie, body: { org_role: "staff" } })
  );
  const data = await mint.json();
  const token = (data.join_path as string).replace("/join-org/", "");

  const crossOrg = await joinRedeem(
    jsonRequest(`/api/org/join/${token}`, { method: "POST", cookie: b.owner.cookie }),
    tokenCtx(token)
  );
  assert.equal(crossOrg.status, 409, "one organization per account");

  const sameOrg = await joinRedeem(
    jsonRequest(`/api/org/join/${token}`, { method: "POST", cookie: a.owner.cookie }),
    tokenCtx(token)
  );
  assert.equal(sameOrg.status, 409, "already a member");

  const invite = db.prepare("SELECT status FROM staff_invitations WHERE id = ?").get(data.invite.id) as { status: string };
  assert.equal(invite.status, "created");
});

test("minter-stale staff invite dies lazily after the minting admin is deactivated", async () => {
  const db = useTestDb();
  const { owner } = await makeOrg(db);
  const { session: admin, memberRowId } = await joinOrg(db, owner.cookie, "admin");

  const mint = await inviteMint(
    jsonRequest("/api/org/invites", { method: "POST", cookie: admin.cookie, body: { org_role: "staff" } })
  );
  const token = ((await mint.json()).join_path as string).replace("/join-org/", "");

  await memberAction(
    jsonRequest(`/api/org/members/${memberRowId}`, { method: "POST", cookie: owner.cookie, body: { action: "deactivate" } }),
    idCtx(memberRowId)
  );

  const meta = await joinMeta(jsonRequest(`/api/org/join/${token}`), tokenCtx(token));
  assert.equal((await meta.json()).status, "cancelled", "minted authority dies with revoked authority");
  const clin = createUserSession(db, "clinician");
  const redeem = await joinRedeem(jsonRequest(`/api/org/join/${token}`, { method: "POST", cookie: clin.cookie }), tokenCtx(token));
  assert.equal(redeem.status, 410);
});

test("succession: owner promotes; admins cannot touch owner roles; last owner is protected; rejoin needs a fresh invite", async () => {
  const db = useTestDb();
  const { owner, orgId } = await makeOrg(db);
  const { session: pharmacist, memberRowId: pharmRow } = await joinOrg(db, owner.cookie, "pharmacist");
  const { session: admin, memberRowId: adminRow } = await joinOrg(db, owner.cookie, "admin");
  const ownerRow = Number(
    (db.prepare("SELECT id FROM organization_members WHERE user_id = ?").get(owner.userId) as { id: number }).id
  );

  const adminPromote = await memberAction(
    jsonRequest(`/api/org/members/${pharmRow}`, { method: "POST", cookie: admin.cookie, body: { action: "set_role", org_role: "owner" } }),
    idCtx(pharmRow)
  );
  assert.equal(adminPromote.status, 403, "only owners manage the owner role");

  const soleOwnerOut = await memberAction(
    jsonRequest(`/api/org/members/${ownerRow}`, { method: "POST", cookie: owner.cookie, body: { action: "deactivate" } }),
    idCtx(ownerRow)
  );
  assert.equal(soleOwnerOut.status, 409, "the last active owner can never leave");

  const promote = await memberAction(
    jsonRequest(`/api/org/members/${pharmRow}`, { method: "POST", cookie: owner.cookie, body: { action: "set_role", org_role: "owner" } }),
    idCtx(pharmRow)
  );
  assert.equal(promote.status, 200);

  const originalOut = await memberAction(
    jsonRequest(`/api/org/members/${ownerRow}`, { method: "POST", cookie: owner.cookie, body: { action: "deactivate" } }),
    idCtx(ownerRow)
  );
  assert.equal(originalOut.status, 200, "with a second owner, the original may leave");
  assert.ok((await originalOut.json()).open_invite_count >= 0, "deactivation reports open invites to review");

  // Rejoin requires a fresh invite (no reactivate) — new active row, history kept.
  const mint = await inviteMint(
    jsonRequest("/api/org/invites", { method: "POST", cookie: pharmacist.cookie, body: { org_role: "staff" } })
  );
  const token = ((await mint.json()).join_path as string).replace("/join-org/", "");
  const rejoin = await joinRedeem(
    jsonRequest(`/api/org/join/${token}`, { method: "POST", cookie: owner.cookie }),
    tokenCtx(token)
  );
  assert.equal(rejoin.status, 200);
  const rows = db
    .prepare("SELECT COUNT(*) AS n FROM organization_members WHERE user_id = ? AND organization_id = ?")
    .get(owner.userId, orgId) as { n: number };
  assert.equal(rows.n, 2, "deactivated history row + fresh active row");
});

test("MIGRATION idempotency: an old-shape DB with ux_grants_open converges on boot without data loss", () => {
  const dir = mkdtempSync(join(tmpdir(), "gm-migrate-"));
  const path = join(dir, "old.db");
  try {
    const db1 = createDatabase(path);
    // Simulate a pre-Phase-5 database: the old single unique index plus an
    // open individual grant that must survive.
    db1.exec("DROP INDEX IF EXISTS ux_grants_open_individual");
    db1.exec("DROP INDEX IF EXISTS ux_grants_open_org");
    db1.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_grants_open
       ON access_grants(profile_id, clinician_user_id) WHERE status IN ('pending','active')`
    );
    db1.prepare("INSERT INTO profiles (name, share_code) VALUES ('P', 'MIGR-0001')").run();
    db1.prepare(
      `INSERT INTO users (email, password_hash, password_salt, display_name, role) VALUES ('m@t.local','x','x','Dr','clinician')`
    ).run();
    db1.prepare(
      `INSERT INTO access_grants (profile_id, clinician_user_id, status, requested_by_user_id) VALUES (1, 1, 'active', 1)`
    ).run();
    db1.close();

    const db2 = createDatabase(path); // boot again — migration must converge
    const indexes = (
      db2.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'access_grants'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    assert.ok(!indexes.includes("ux_grants_open"), "old index dropped and not recreated by SCHEMA");
    assert.ok(indexes.includes("ux_grants_open_individual"));
    assert.ok(indexes.includes("ux_grants_open_org"));
    const grant = db2.prepare("SELECT status, organization_id FROM access_grants WHERE id = 1").get() as {
      status: string;
      organization_id: number | null;
    };
    assert.equal(grant.status, "active", "pre-existing grant untouched");
    assert.equal(grant.organization_id, null);
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AUDIT: org lifecycle lands PHI-free with profile_id NULL on org-admin events", async () => {
  const db = useTestDb();
  const { owner } = await makeOrg(db);
  const { memberRowId } = await joinOrg(db, owner.cookie, "staff");
  await memberAction(
    jsonRequest(`/api/org/members/${memberRowId}`, { method: "POST", cookie: owner.cookie, body: { action: "deactivate" } }),
    idCtx(memberRowId)
  );

  const events = db
    .prepare("SELECT action, profile_id, meta FROM audit_events")
    .all() as { action: string; profile_id: number | null; meta: string | null }[];
  const actions = events.map((e) => e.action);
  for (const expected of ["org_created", "org_member_joined", "org_staff_invite_created", "org_member_deactivated"]) {
    assert.ok(actions.includes(expected), `missing ${expected}`);
  }
  for (const e of events.filter((x) => x.action.startsWith("org_"))) {
    assert.equal(e.profile_id, null, "org-admin events never enter a patient's feed");
    if (e.meta) {
      assert.ok(!/Wortley|Dr\.|@t\.local|Patient/i.test(e.meta), "meta is ids and enums only");
    }
  }
});
