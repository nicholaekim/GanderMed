import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createSession, ensurePatientProfile } from "@/lib/auth";
import { clearStateCookie, exchangeCode, googleConfigured, readStateCookie } from "@/lib/google";
import type { Role } from "@/lib/auth";

interface UserRow {
  id: number;
  role: Role;
  google_sub: string | null;
}

function fail(origin: string, code: string) {
  const res = NextResponse.redirect(new URL(`/login?error=${code}`, origin));
  res.headers.append("Set-Cookie", clearStateCookie());
  return res;
}

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
    identity = await exchangeCode(origin, code);
  } catch (e) {
    console.error("Google exchange failed:", e);
    return fail(origin, "google_failed");
  }
  if (!identity.emailVerified) return fail(origin, "google_unverified");

  const db = getDb();
  let user = db
    .prepare("SELECT id, role, google_sub FROM users WHERE google_sub = ?")
    .get(identity.sub) as UserRow | undefined;

  if (!user) {
    // Same email already registered with a password? Link Google to it.
    const byEmail = db
      .prepare("SELECT id, role, google_sub FROM users WHERE email = ?")
      .get(identity.email) as UserRow | undefined;
    if (byEmail) {
      db.prepare("UPDATE users SET google_sub = ? WHERE id = ?").run(identity.sub, byEmail.id);
      user = byEmail;
    }
  }

  if (!user) {
    // Brand-new account, using the role chosen on the login page.
    const role = cookie.role;
    if (role === "clinician" && !cookie.clinic_name) {
      return fail(origin, "google_clinic_required");
    }
    db.exec("BEGIN");
    try {
      // Google-only accounts store empty password fields; password login
      // detects that and points people at the Google button.
      const info = db
        .prepare(
          `INSERT INTO users (email, password_hash, password_salt, display_name, role, clinic_name, google_sub)
           VALUES (?, '', '', ?, ?, ?, ?)`
        )
        .run(
          identity.email,
          identity.name,
          role,
          role === "clinician" ? cookie.clinic_name : null,
          identity.sub
        );
      const userId = Number(info.lastInsertRowid);
      if (role === "patient") ensurePatientProfile(db, userId, identity.name);
      db.exec("COMMIT");
      user = { id: userId, role, google_sub: identity.sub };
    } catch (e) {
      db.exec("ROLLBACK");
      console.error("Google account creation failed:", e);
      return fail(origin, "google_failed");
    }
  }

  const { cookie: sessionCookie } = createSession(db, user.id);
  const res = NextResponse.redirect(new URL(user.role === "clinician" ? "/clinic" : "/", origin));
  res.headers.append("Set-Cookie", sessionCookie);
  res.headers.append("Set-Cookie", clearStateCookie());
  return res;
}
