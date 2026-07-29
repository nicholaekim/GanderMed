// Prototype authentication: salted scrypt password hashes + opaque session
// tokens in an httpOnly cookie, stored in SQLite. Good enough to demo a
// two-role product honestly; NOT production clinic auth (no MFA, no rate
// limiting, no HTTPS enforcement, no audit log — see README security notes).

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const SESSION_COOKIE = "dcai_session";
const SESSION_TTL_MS = 30 * 24 * 3_600_000;

export type Role = "patient" | "clinician";

export interface SessionUser {
  id: number;
  email: string;
  display_name: string;
  role: Role;
  clinic_name: string | null;
  /** Patients only: their medication profile */
  profile_id: number | null;
  share_code: string | null;
}

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createSession(db: DatabaseSync, userId: number): { token: string; cookie: string } {
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(token, userId, expires);
  return { token, cookie: buildCookie(token, SESSION_TTL_MS / 1000) };
}

export function clearSessionCookie(): string {
  return buildCookie("", 0);
}

/** Secure flag is on in production (or when SECURE_COOKIES=1 for staging). */
export function cookieSecureSuffix(): string {
  return process.env.NODE_ENV === "production" || process.env.SECURE_COOKIES === "1" ? "; Secure" : "";
}

function buildCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeSeconds)}${cookieSecureSuffix()}`;
}

/**
 * Invalidates every session for a user except (optionally) the current one.
 * Called on account-security changes such as linking a Google identity.
 */
export function invalidateOtherSessions(db: DatabaseSync, userId: number, keepToken?: string | null): void {
  if (keepToken) {
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").run(userId, keepToken);
  } else {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }
}

function readSessionToken(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([a-f0-9]{64})`));
  return match ? match[1] : null;
}

export function getSessionToken(request: Request): string | null {
  return readSessionToken(request);
}

export function getUserFromRequest(db: DatabaseSync, request: Request): SessionUser | null {
  const token = readSessionToken(request);
  if (!token) return null;
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.role, u.clinic_name, p.id AS profile_id, p.share_code
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE s.token = ?`
    )
    .get(token) as unknown as SessionUser | undefined;
  return row ?? null;
}

export function deleteSession(db: DatabaseSync, request: Request): void {
  const token = readSessionToken(request);
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateShareCode(db: DatabaseSync): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const bytes = randomBytes(8);
    let raw = "";
    for (let i = 0; i < 8; i++) raw += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    const exists = db.prepare("SELECT 1 FROM profiles WHERE share_code = ?").get(code);
    if (!exists) return code;
  }
  throw new Error("Could not generate a unique share code");
}

export function normalizeShareCode(input: string): string | null {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (raw.length !== 8) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/**
 * Resolves which medication profile a request may act on.
 * Patients always act on their own profile. Clinicians may READ profiles
 * only under an ACTIVE, unexpired, patient-approved access grant — either
 * their own individual grant (organization_id NULL) or a grant naming an
 * organization they are an ACTIVE member of at this moment (membership is
 * looked up per request, never cached, so deactivation bites on the very
 * next read). They may never write. Expiry is enforced lazily per
 * candidate; an expired individual grant must not block a live org grant,
 * and vice versa.
 */
export function resolveProfileAccess(
  db: DatabaseSync,
  user: SessionUser,
  request: Request,
  opts: { write: boolean }
):
  | { profileId: number; via: "self" | "individual" | "org"; grantId: number | null; organizationId: number | null }
  | { error: string; status: number } {
  if (user.role === "patient") {
    if (user.profile_id == null) return { error: "No medication profile for this account.", status: 500 };
    return { profileId: user.profile_id, via: "self", grantId: null, organizationId: null };
  }
  if (opts.write) {
    return { error: "Care-team accounts have view-only access to patient records.", status: 403 };
  }
  const param = new URL(request.url).searchParams.get("patient");
  const profileId = Number(param);
  if (!Number.isInteger(profileId)) {
    return { error: "Missing ?patient=<id> for care-team access.", status: 400 };
  }

  // Inline membership lookup (org.ts is a leaf; auth.ts must not import
  // modules that import auth.ts — but org.ts doesn't, so this could import
  // activeMembership; kept inline to keep auth.ts dependency-free anyway).
  const membership = db
    .prepare("SELECT organization_id FROM organization_members WHERE user_id = ? AND status = 'active'")
    .get(user.id) as { organization_id: number } | undefined;

  // Individual candidates first, for audit attribution. The -1 sentinel
  // means "no membership" matches no org grant — a deactivated or
  // never-member clinician can never ride an org grant.
  const candidates = db
    .prepare(
      `SELECT id, expires_at, organization_id FROM access_grants
       WHERE profile_id = ? AND status = 'active'
         AND ((organization_id IS NULL AND clinician_user_id = ?)
           OR (organization_id IS NOT NULL AND organization_id = ?))
       ORDER BY organization_id IS NULL DESC, id`
    )
    .all(profileId, user.id, membership?.organization_id ?? -1) as unknown as {
    id: number;
    expires_at: string | null;
    organization_id: number | null;
  }[];

  const nowIso = new Date().toISOString();
  for (const grant of candidates) {
    if (grant.expires_at && grant.expires_at <= nowIso) {
      db.prepare("UPDATE access_grants SET status = 'expired' WHERE id = ? AND status = 'active'").run(grant.id);
      db.prepare(
        "INSERT INTO audit_events (actor_user_id, action, profile_id, target_id) VALUES (NULL, 'access_expired', ?, ?)"
      ).run(profileId, grant.id);
      continue; // an expired door must not block the other one
    }
    return {
      profileId,
      via: grant.organization_id == null ? "individual" : "org",
      grantId: grant.id,
      organizationId: grant.organization_id,
    };
  }
  return { error: "No active patient-approved access for this record.", status: 403 };
}

export function unauthorized() {
  return { error: "Not signed in.", status: 401 as const };
}

/**
 * Gives a newly registered patient their medication profile. Adopts the
 * oldest unclaimed profile if one exists (keeps data recorded before
 * accounts existed in this prototype); otherwise starts a fresh one.
 */
export function ensurePatientProfile(db: DatabaseSync, userId: number, displayName: string): void {
  const unclaimed = db
    .prepare("SELECT id FROM profiles WHERE user_id IS NULL ORDER BY id LIMIT 1")
    .get() as { id: number } | undefined;
  if (unclaimed) {
    db.prepare("UPDATE profiles SET user_id = ?, name = ? WHERE id = ?").run(userId, displayName, unclaimed.id);
  } else {
    db.prepare("INSERT INTO profiles (name, user_id, share_code) VALUES (?, ?, ?)").run(
      displayName,
      userId,
      generateShareCode(db)
    );
  }
}
