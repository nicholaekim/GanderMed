// Minimal Google OpenID Connect client for "Continue with Google".
// Hand-rolled (rather than NextAuth) so it plugs into the app's existing
// session + role system: the callback ends by minting the same dcai_session
// cookie every other login path uses.
//
// Security notes for this flow:
// - `state` carries only a random nonce; the nonce plus the chosen role and
//   clinic name live in a short-lived httpOnly cookie, compared on callback.
// - The id_token is NOT signature-verified. That is acceptable here because
//   we receive it directly from Google's token endpoint over TLS in a
//   server-to-server exchange (Google's documented shortcut). If tokens ever
//   arrive via any other path, full JWKS verification becomes mandatory.

import { cookieSecureSuffix } from "@/lib/auth";

export const OAUTH_COOKIE = "dcai_oauth";

export function googleConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export interface OauthStatePayload {
  nonce: string;
  role: "patient" | "clinician";
  clinic_name: string | null;
  /** In-app path to land on after sign-in (e.g. an intake link). */
  next?: string | null;
}

/** Only same-app paths may ride through auth redirects — no absolute/protocol-relative URLs. */
export function sanitizeNextPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  return value.length <= 300 ? value : null;
}

export function encodeStateCookie(payload: OauthStatePayload): string {
  const value = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${OAUTH_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${cookieSecureSuffix()}`;
}

export function clearStateCookie(): string {
  return `${OAUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecureSuffix()}`;
}

export function readStateCookie(request: Request): OauthStatePayload | null {
  const header = request.headers.get("cookie") ?? "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${OAUTH_COOKIE}=([A-Za-z0-9_-]+)`));
  if (!match) return null;
  try {
    const parsed = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
    if (typeof parsed?.nonce !== "string") return null;
    return {
      nonce: parsed.nonce,
      role: parsed.role === "clinician" ? "clinician" : "patient",
      clinic_name: typeof parsed.clinic_name === "string" && parsed.clinic_name.trim() ? parsed.clinic_name.trim() : null,
      next: sanitizeNextPath(typeof parsed.next === "string" ? parsed.next : null),
    };
  } catch {
    return null;
  }
}

export function redirectUri(origin: string): string {
  return `${origin}/api/auth/google/callback`;
}

export function buildAuthUrl(origin: string, nonce: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: "openid email profile",
    state: nonce,
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

type Exchanger = (origin: string, code: string) => Promise<GoogleIdentity>;

// Swappable so auth tests can simulate Google identities without network.
let activeExchanger: Exchanger | null = null;

export function __setGoogleExchangeForTests(fn: Exchanger | null): void {
  activeExchanger = fn;
}

export async function performExchange(origin: string, code: string): Promise<GoogleIdentity> {
  return (activeExchanger ?? exchangeCode)(origin, code);
}

export async function exchangeCode(origin: string, code: string): Promise<GoogleIdentity> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri(origin),
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { id_token?: string };
  if (!data.id_token) throw new Error("Google response missing id_token");

  const parts = data.id_token.split(".");
  if (parts.length !== 3) throw new Error("Malformed id_token");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
  };
  if (!payload.sub || !payload.email) throw new Error("id_token missing sub/email");

  const email = payload.email.toLowerCase();
  return {
    sub: payload.sub,
    email,
    emailVerified: payload.email_verified !== false,
    name: payload.name?.trim() || email.split("@")[0],
  };
}
