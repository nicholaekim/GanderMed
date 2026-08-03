// In-app notifications. GET lists the caller's own (running the lazy
// clinician nudges first); POST marks one or all read. Strictly per-user —
// notifications are never visible across accounts.

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest } from "@/lib/auth";
import { generateClinicianNudges } from "@/lib/medevents";

export async function GET(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  if (user.role === "clinician") generateClinicianNudges(db, user.id);

  const notifications = db
    .prepare(
      `SELECT id, type, body, medication_id, created_at, read_at
       FROM notifications WHERE user_id = ? ORDER BY read_at IS NOT NULL, created_at DESC, id DESC LIMIT 50`
    )
    .all(user.id);
  const unread = (
    db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL").get(user.id) as {
      n: number;
    }
  ).n;
  return NextResponse.json({ notifications, unread });
}

export async function POST(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: { action?: string; id?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (body.action !== "read") return NextResponse.json({ error: "action must be 'read'." }, { status: 400 });

  if (body.id != null) {
    db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND user_id = ? AND read_at IS NULL").run(
      Number(body.id),
      user.id
    );
  } else {
    db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").run(user.id);
  }
  return NextResponse.json({ ok: true });
}
