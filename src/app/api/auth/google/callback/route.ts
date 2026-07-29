import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  createSession,
  ensurePatientProfile,
  getSessionToken,
  getUserFromRequest,
  invalidateOtherSessions,
} from "@/lib/auth";
import { clearStateCookie, googleConfigured, performExchange, readStateCookie } from "@/lib/google";
import type { Role } from "@/lib/auth";

interface UserRow {
  id: number;
  role: Role;
  google_sub: string | null;
  email_verified_at: string | null;
}

function fail(origin: string, code: string) {
  const res = NextResponse.redirect(new URL(`/login?error=${code}`, origin));
  res.headers.append("Set-Cookie", clearStateCookie());
  return res;
}

// Account-linking policy (prevents pre-account-takeover):
//   1. Known google_sub               -> sign in to that account.
//   2. Signed-in session whose email matches the Google email
//                                     -> link to the SESSION account
//                                        (an authenticated session is proof
//                                        of account ownership).
//   3. Existing account by email, email VERIFIED
//                                     -> link (both sides proved ownership).
//   4. Existing account by email, email NOT verified
//                                     -> refuse to link silently. The account
//                                        may have been created by someone
//                                        else; direct the user to password
//                                        sign-in first (case 2 then links).
//   5. No account                     -> create one (Google-verified email).
export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = url.origin;
  if (!googleConfigured()) return fail(origin, "google_not_configured");

  if (url.searchParams.get("error")) return fail(origin, "google_denied");

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookie = readStateCookie(request);
  if (!code || !state || !cookie || cookie.nonce !== state) {
    return fail(origin, "google_state");
  }

  let identity;
  try {
    identity = await performExchange(origin, code);
  } catch (e) {
    console.error("Google exchange failed:", e);
    return fail(origin, "google_failed");
  }
  if (!identity.emailVerified) return fail(origin, "google_unverified");

  const db = getDb();
  const bySub = db
    .prepare("SELECT id, role, google_sub, email_verified_at FROM users WHERE google_sub = ?")
    .get(identity.sub) as UserRow | undefined;

  let user = bySub;
  if (user && !user.email_verified_at) {
    db.prepare("UPDATE users SET email_verified_at = ? WHERE id = ?").run(new Date().toISOString(), user.id);
  }

  if (!user) {
    const sessionUser = getUserFromRequest(db, request);
    const byEmail = db
      .prepare("SELECT id, role, google_sub, email_verified_at FROM users WHERE email = ?")
      .get(identity.email) as UserRow | undefined;

    if (sessionUser && sessionUser.email === identity.email) {
      // Case 2: authenticated owner explicitly linking Google to their account.
      db.prepare("UPDATE users SET google_sub = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?").run(
        identity.sub,
        new Date().toISOString(),
        sessionUser.id
      );
      invalidateOtherSessions(db, sessionUser.id, getSessionToken(request));
      user = { id: sessionUser.id, role: sessionUser.role, google_sub: identity.sub, email_verified_at: "linked" };
    } else if (byEmail && byEmail.email_verified_at) {
      // Case 3: verified email on file — safe to link.
      db.prepare("UPDATE users SET google_sub = ? WHERE id = ?").run(identity.sub, byEmail.id);
      invalidateOtherSessions(db, byEmail.id, null);
      user = byEmail;
    } else if (byEmail) {
      // Case 4: unverified password account with this email — NEVER silently
      // link. The rightful owner signs in with the password first, then
      // retries Google while signed in (case 2).
      return fail(origin, "google_link_blocked");
    }
  }

  if (!user) {
    // Case 5: brand-new account, role chosen on the login page.
    const role = cookie.role;
    if (role === "clinician" && !cookie.clinic_name) {
      return fail(origin, "google_clinic_required");
    }
    db.exec("BEGIN");
    try {
      const info = db
        .prepare(
          `INSERT INTO users (email, password_hash, password_salt, display_name, role, clinic_name, google_sub, email_verified_at)
           VALUES (?, '', '', ?, ?, ?, ?, ?)`
        )
        .run(
          identity.email,
          identity.name,
          role,
          role === "clinician" ? cookie.clinic_name : null,
          identity.sub,
          new Date().toISOString()
        );
      const userId = Number(info.lastInsertRowid);
      if (role === "patient") ensurePatientProfile(db, userId, identity.name);
      db.exec("COMMIT");
      user = { id: userId, role, google_sub: identity.sub, email_verified_at: "new" };
    } catch (e) {
      db.exec("ROLLBACK");
      console.error("Google account creation failed:", e);
      return fail(origin, "google_failed");
    }
  }

  const { cookie: sessionCookie } = createSession(db, user.id);
  const dest = cookie.next ?? (user.role === "clinician" ? "/clinic" : "/");
  const res = NextResponse.redirect(new URL(dest, origin));
  res.headers.append("Set-Cookie", sessionCookie);
  res.headers.append("Set-Cookie", clearStateCookie());
  return res;
}
