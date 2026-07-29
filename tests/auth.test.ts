// Phase 3: authentication and account-linking safety. The headline case is
// the pre-account-takeover: Google must NEVER silently link to an existing
// unverified password account.

import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createSession, getUserFromRequest, hashPassword } from "../src/lib/auth";
import { __setGoogleExchangeForTests, encodeStateCookie } from "../src/lib/google";
import { __resetRateLimitsForTests } from "../src/lib/ratelimit";
import { GET as googleCallback } from "../src/app/api/auth/google/callback/route";
import { POST as login } from "../src/app/api/auth/login/route";
import { createUserSession, jsonRequest, useTestDb } from "./helpers";
import type { DatabaseSync } from "node:sqlite";

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "test-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  __resetRateLimitsForTests();
});

afterEach(() => {
  __setGoogleExchangeForTests(null);
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.SECURE_COOKIES;
});

function passwordUser(db: DatabaseSync, email: string, password: string, verified: boolean): number {
  const { hash, salt } = hashPassword(password);
  return Number(
    db
      .prepare(
        `INSERT INTO users (email, password_hash, password_salt, display_name, role, email_verified_at)
         VALUES (?, ?, ?, 'Someone', 'patient', ?)`
      )
      .run(email, hash, salt, verified ? new Date().toISOString() : null).lastInsertRowid
  );
}

function googleRequest(identityEmail: string, opts: { sub?: string; sessionCookie?: string } = {}): Request {
  const nonce = randomBytes(16).toString("hex");
  __setGoogleExchangeForTests(async () => ({
    sub: opts.sub ?? "google-sub-1",
    email: identityEmail,
    emailVerified: true,
    name: "Google Person",
  }));
  const stateCookie = encodeStateCookie({ nonce, role: "patient", clinic_name: null }).split(";")[0];
  const cookieHeader = opts.sessionCookie ? `${stateCookie}; ${opts.sessionCookie}` : stateCookie;
  return new Request(`http://localhost:3000/api/auth/google/callback?code=abc&state=${nonce}`, {
    headers: { cookie: cookieHeader },
  });
}

test("TAKEOVER BLOCKED: Google must not link to an unverified password account", async () => {
  const db = useTestDb();
  // Attacker registers with the victim's email (no verification exists).
  passwordUser(db, "victim@example.com", "attacker-password", false);

  // Victim signs in with Google using their real email.
  const res = await googleCallback(googleRequest("victim@example.com"));
  assert.equal(res.status, 307);
  assert.match(res.headers.get("location") ?? "", /error=google_link_blocked/);

  const linked = db.prepare("SELECT COUNT(*) AS n FROM users WHERE google_sub IS NOT NULL").get() as { n: number };
  assert.equal(linked.n, 0, "no google_sub may be written to the attacker's account");
});

test("a VERIFIED password account links to Google and other sessions are revoked", async () => {
  const db = useTestDb();
  const userId = passwordUser(db, "owner@example.com", "their-password", true);
  createSession(db, userId); // an old session that must be invalidated on link

  const res = await googleCallback(googleRequest("owner@example.com"));
  assert.equal(res.status, 307);
  assert.match(res.headers.get("location") ?? "", /\/$/, "lands on the dashboard");

  const row = db.prepare("SELECT google_sub FROM users WHERE id = ?").get(userId) as { google_sub: string };
  assert.equal(row.google_sub, "google-sub-1");
  const sessions = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(userId) as { n: number };
  assert.equal(sessions.n, 1, "pre-existing sessions revoked; only the fresh login remains");
});

test("an authenticated session for the same email may link even when unverified", async () => {
  const db = useTestDb();
  const userId = passwordUser(db, "self@example.com", "my-password", false);
  const { cookie: sessionCookie } = createSession(db, userId);

  const res = await googleCallback(googleRequest("self@example.com", { sessionCookie: sessionCookie.split(";")[0] }));
  assert.equal(res.status, 307);
  const row = db.prepare("SELECT google_sub, email_verified_at FROM users WHERE id = ?").get(userId) as {
    google_sub: string;
    email_verified_at: string | null;
  };
  assert.equal(row.google_sub, "google-sub-1", "session ownership authorizes the link");
  assert.ok(row.email_verified_at, "linking marks the email verified");
});

test("google_sub stays unique — a second identity with the same sub signs into the first account", async () => {
  const db = useTestDb();
  await googleCallback(googleRequest("first@example.com", { sub: "shared-sub" }));
  await googleCallback(googleRequest("second@example.com", { sub: "shared-sub" }));

  const users = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  assert.equal(users.n, 1, "the sub resolves to the existing account; no duplicate user");
});

test("an invalid or missing OAuth state is rejected", async () => {
  useTestDb();
  __setGoogleExchangeForTests(async () => {
    throw new Error("exchange must never run on bad state");
  });
  const stateCookie = encodeStateCookie({ nonce: "real-nonce", role: "patient", clinic_name: null }).split(";")[0];
  const res = await googleCallback(
    new Request("http://localhost:3000/api/auth/google/callback?code=abc&state=WRONG", {
      headers: { cookie: stateCookie },
    })
  );
  assert.match(res.headers.get("location") ?? "", /error=google_state/);
});

test("expired sessions are not honoured", () => {
  const db = useTestDb();
  const { userId, token } = createUserSession(db, "patient");
  db.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = ?").run(
    new Date(Date.now() - 1000).toISOString(),
    userId
  );
  const user = getUserFromRequest(db, new Request("http://x/", { headers: { cookie: `dcai_session=${token}` } }));
  assert.equal(user, null);
});

test("wrong password and google-only accounts get the same generic 401", async () => {
  const db = useTestDb();
  passwordUser(db, "pw@example.com", "correct-password", true);
  db.prepare(
    `INSERT INTO users (email, password_hash, password_salt, display_name, role, google_sub)
     VALUES ('gonly@example.com', '', '', 'G Only', 'patient', 'sub-x')`
  ).run();

  const wrong = await login(jsonRequest("/api/auth/login", { method: "POST", body: { email: "pw@example.com", password: "nope" } }));
  const gOnly = await login(jsonRequest("/api/auth/login", { method: "POST", body: { email: "gonly@example.com", password: "nope" } }));
  const unknown = await login(jsonRequest("/api/auth/login", { method: "POST", body: { email: "ghost@example.com", password: "nope" } }));

  assert.equal(wrong.status, 401);
  assert.equal(gOnly.status, 401);
  assert.equal(unknown.status, 401);
  const msgs = [(await wrong.json()).error, (await gOnly.json()).error, (await unknown.json()).error];
  assert.equal(new Set(msgs).size, 1, "identical message for all failure kinds");
});

test("login attempts are rate limited", async () => {
  const db = useTestDb();
  passwordUser(db, "rl@example.com", "correct-password", true);
  let lastStatus = 0;
  for (let i = 0; i < 12; i++) {
    const res = await login(
      jsonRequest("/api/auth/login", { method: "POST", body: { email: "rl@example.com", password: "wrong" } })
    );
    lastStatus = res.status;
  }
  assert.equal(lastStatus, 429);
});

test("cookies carry the Secure flag in production mode", () => {
  const db = useTestDb();
  process.env.SECURE_COOKIES = "1";
  const { userId } = createUserSession(db, "patient");
  const { cookie } = createSession(db, userId);
  assert.match(cookie, /; Secure/);
});
