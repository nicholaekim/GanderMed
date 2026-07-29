import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { buildAuthUrl, encodeStateCookie, googleConfigured, sanitizeNextPath } from "@/lib/google";

// Starts the Google sign-in flow: stash a nonce + the chosen role in an
// httpOnly cookie, then hand the browser to Google.
export async function GET(request: Request) {
  const url = new URL(request.url);
  if (!googleConfigured()) {
    return NextResponse.redirect(new URL("/login?error=google_not_configured", url.origin));
  }

  const role = url.searchParams.get("role") === "clinician" ? "clinician" : "patient";
  const clinic = url.searchParams.get("clinic_name")?.trim() || null;
  const next = sanitizeNextPath(url.searchParams.get("next"));
  const nonce = randomBytes(16).toString("hex");

  const res = NextResponse.redirect(buildAuthUrl(url.origin, nonce));
  res.headers.append("Set-Cookie", encodeStateCookie({ nonce, role, clinic_name: clinic, next }));
  return res;
}
