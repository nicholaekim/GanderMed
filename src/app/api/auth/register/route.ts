import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createSession, ensurePatientProfile, getUserFromRequest, hashPassword } from "@/lib/auth";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  let body: {
    email?: string;
    password?: string;
    display_name?: string;
    role?: "patient" | "clinician";
    clinic_name?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";
  const name = body.display_name?.trim() ?? "";
  const role = body.role;

  if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  if (password.length < 8) return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
  if (name.length < 2) return NextResponse.json({ error: "Enter your name." }, { status: 400 });
  if (role !== "patient" && role !== "clinician") {
    return NextResponse.json({ error: "Choose an account type." }, { status: 400 });
  }
  const clinicName = role === "clinician" ? body.clinic_name?.trim() || null : null;
  if (role === "clinician" && !clinicName) {
    return NextResponse.json({ error: "Enter your clinic or practice name." }, { status: 400 });
  }

  const db = getDb();
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return NextResponse.json({ error: "An account with this email already exists." }, { status: 409 });

  const { hash, salt } = hashPassword(password);
  db.exec("BEGIN");
  let userId: number;
  try {
    const info = db
      .prepare(
        `INSERT INTO users (email, password_hash, password_salt, display_name, role, clinic_name)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(email, hash, salt, name, role, clinicName);
    userId = Number(info.lastInsertRowid);

    if (role === "patient") ensurePatientProfile(db, userId, name);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    console.error("Registration failed:", e);
    return NextResponse.json({ error: "Could not create the account." }, { status: 500 });
  }

  const { cookie } = createSession(db, userId);
  const user = getUserFromRequest(db, new Request(request.url, { headers: { cookie } }));
  return NextResponse.json({ user }, { headers: { "Set-Cookie": cookie } });
}
