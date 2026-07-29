import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createSession, getUserFromRequest, verifyPassword } from "@/lib/auth";
import { allowRequest, clientIp } from "@/lib/ratelimit";

export async function POST(request: Request) {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";

  if (!allowRequest(`login:${clientIp(request)}:${email}`, 10, 15 * 60_000)) {
    return NextResponse.json({ error: "Too many attempts — try again in a few minutes." }, { status: 429 });
  }

  const db = getDb();
  const row = db
    .prepare("SELECT id, password_hash, password_salt FROM users WHERE email = ?")
    .get(email) as { id: number; password_hash: string; password_salt: string } | undefined;

  // One generic message for every failure — wrong password, unknown email,
  // and Google-only accounts (empty hash never verifies) — so responses
  // don't reveal whether an email is registered or how.
  if (!row || row.password_hash === "" || !verifyPassword(password, row.password_salt, row.password_hash)) {
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }

  const { cookie } = createSession(db, row.id);
  const user = getUserFromRequest(db, new Request(request.url, { headers: { cookie } }));
  return NextResponse.json({ user }, { headers: { "Set-Cookie": cookie } });
}
