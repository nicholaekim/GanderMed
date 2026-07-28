import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createSession, getUserFromRequest, verifyPassword } from "@/lib/auth";

export async function POST(request: Request) {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";

  const db = getDb();
  const row = db
    .prepare("SELECT id, password_hash, password_salt FROM users WHERE email = ?")
    .get(email) as { id: number; password_hash: string; password_salt: string } | undefined;

  if (row && row.password_hash === "") {
    return NextResponse.json(
      { error: "This account uses Google sign-in — use the “Continue with Google” button." },
      { status: 401 }
    );
  }
  if (!row || !verifyPassword(password, row.password_salt, row.password_hash)) {
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }

  const { cookie } = createSession(db, row.id);
  const user = getUserFromRequest(db, new Request(request.url, { headers: { cookie } }));
  return NextResponse.json({ user }, { headers: { "Set-Cookie": cookie } });
}
