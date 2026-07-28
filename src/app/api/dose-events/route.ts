import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest, resolveProfileAccess } from "@/lib/auth";

export async function GET(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const access = resolveProfileAccess(db, user, request, { write: false });
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.status });

  const daysParam = Number(new URL(request.url).searchParams.get("days"));
  const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(daysParam, 90) : 14;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

  const events = db
    .prepare(
      `SELECT de.*, m.brand_name FROM dose_events de
       JOIN medications m ON m.id = de.medication_id
       WHERE m.profile_id = ? AND de.logged_at >= ?
       ORDER BY de.logged_at DESC LIMIT 300`
    )
    .all(access.profileId, cutoff);
  return NextResponse.json({ events });
}

// A dose is recorded as "late" when it's taken more than an hour after its
// scheduled slot — the report distinguishes adherence, not just activity.
const LATE_THRESHOLD_MS = 60 * 60 * 1000;

export async function POST(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const access = resolveProfileAccess(db, user, request, { write: true });
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.status });

  let body: {
    medication_id?: number;
    scheduled_at?: string | null;
    action?: "taken" | "skipped";
    dose_value?: number | null;
    dose_unit?: string | null;
    /** Optional backdate (ISO) — used by demo seeding; defaults to server now. */
    logged_at?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const medId = Number(body.medication_id);
  if (!Number.isInteger(medId)) return NextResponse.json({ error: "medication_id required." }, { status: 400 });
  if (body.action !== "taken" && body.action !== "skipped") {
    return NextResponse.json({ error: "action must be 'taken' or 'skipped'." }, { status: 400 });
  }

  const med = db
    .prepare("SELECT * FROM medications WHERE id = ? AND profile_id = ?")
    .get(medId, access.profileId) as { dose_value: number | null; dose_unit: string | null } | undefined;
  if (!med) return NextResponse.json({ error: "Medication not found." }, { status: 404 });

  const backdate = body.logged_at ? new Date(body.logged_at) : null;
  const now = backdate && !isNaN(backdate.getTime()) ? backdate : new Date();
  const scheduledAt = body.scheduled_at ?? null;
  let status: "taken" | "skipped" | "late" = body.action;
  if (body.action === "taken" && scheduledAt) {
    const sched = new Date(scheduledAt);
    if (!isNaN(sched.getTime()) && now.getTime() - sched.getTime() > LATE_THRESHOLD_MS) {
      status = "late";
    }
  }

  // One record per scheduled slot: re-logging a slot replaces the old record.
  if (scheduledAt) {
    db.prepare("DELETE FROM dose_events WHERE medication_id = ? AND scheduled_at = ?").run(medId, scheduledAt);
  }

  const info = db
    .prepare(
      `INSERT INTO dose_events (medication_id, scheduled_at, logged_at, status, dose_value, dose_unit)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      medId,
      scheduledAt,
      now.toISOString(),
      status,
      body.dose_value ?? med.dose_value ?? null,
      body.dose_unit ?? med.dose_unit ?? null
    );

  const event = db.prepare("SELECT * FROM dose_events WHERE id = ?").get(Number(info.lastInsertRowid));
  return NextResponse.json({ event });
}
