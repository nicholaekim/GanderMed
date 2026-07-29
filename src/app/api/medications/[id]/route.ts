import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getMedicationsWithIngredients, recomputeAlerts } from "@/lib/conflicts";
import { annotateAlertsWithExposure, computeExposure } from "@/lib/exposure";
import { attachReviews } from "@/lib/reviews";
import { getUserFromRequest, resolveProfileAccess } from "@/lib/auth";
import type { Medication } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

// Verified product identity is immutable — switching products is an explicit
// Replace action (POST [id]/replace) so reviews/alerts re-key correctly.
const IMMUTABLE_FIELDS = [
  "brand_name",
  "din",
  "drug_code",
  "company_name",
  "route",
  "dosage_form",
  "verified",
  "is_extended_release",
  "ingredients",
] as const;

// Server-owned bookkeeping the client may never write.
const SERVER_OWNED_FIELDS = ["provenance", "last_material_change_at", "replaced_by_id", "profile_id", "created_at"] as const;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function authorize(
  request: Request
): { fail: NextResponse } | { db: ReturnType<typeof getDb>; profileId: number } {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return { fail: NextResponse.json({ error: "Not signed in." }, { status: 401 }) };
  const access = resolveProfileAccess(db, user, request, { write: true });
  if ("error" in access) return { fail: NextResponse.json({ error: access.error }, { status: access.status }) };
  return { db, profileId: access.profileId };
}

export async function PATCH(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const medId = Number(id);
  if (!Number.isInteger(medId)) return NextResponse.json({ error: "Bad id." }, { status: 400 });

  const auth = authorize(request);
  if ("fail" in auth) return auth.fail;
  const { db, profileId } = auth;

  let body: {
    status?: "active" | "stopped";
    actual_use?: string;
    patient_notes?: string | null;
    dose_value?: number | null;
    dose_unit?: string | null;
    is_prn?: boolean;
    schedule_times?: string[];
    start_date?: string | null;
    instructions?: string | null;
  } & Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  for (const f of IMMUTABLE_FIELDS) {
    if (f in body) {
      return NextResponse.json(
        { error: `'${f}' is part of the verified product identity and can't be edited. Use Replace to switch products.` },
        { status: 400 }
      );
    }
  }
  for (const f of SERVER_OWNED_FIELDS) {
    if (f in body) {
      return NextResponse.json({ error: `'${f}' is managed by the server and can't be set.` }, { status: 400 });
    }
  }

  const current = db
    .prepare("SELECT * FROM medications WHERE id = ? AND profile_id = ?")
    .get(medId, profileId) as unknown as Medication | undefined;
  if (!current) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  let materialChange = false;

  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "stopped") {
      return NextResponse.json({ error: "status must be 'active' or 'stopped'." }, { status: 400 });
    }
    sets.push("status = ?", "end_date = ?");
    args.push(body.status, body.status === "stopped" ? new Date().toISOString().slice(0, 10) : null);
  }
  if (body.actual_use !== undefined) {
    const allowed = ["taking", "not_taking", "taking_differently", "recently_stopped", "unsure"];
    if (!allowed.includes(body.actual_use)) {
      return NextResponse.json({ error: `actual_use must be one of: ${allowed.join(", ")}.` }, { status: 400 });
    }
    sets.push("actual_use = ?");
    args.push(body.actual_use);
  }
  if (body.patient_notes !== undefined) {
    const note = (body.patient_notes ?? "").trim().slice(0, 500) || null;
    sets.push("patient_notes = ?");
    args.push(note);
  }

  if (body.dose_value !== undefined) {
    if (body.dose_value !== null && (typeof body.dose_value !== "number" || !isFinite(body.dose_value) || body.dose_value < 0)) {
      return NextResponse.json({ error: "dose_value must be a non-negative number or null." }, { status: 400 });
    }
    sets.push("dose_value = ?");
    args.push(body.dose_value);
    if (body.dose_value !== current.dose_value) materialChange = true;
  }
  if (body.dose_unit !== undefined) {
    const unit = (body.dose_unit ?? "").trim().slice(0, 30) || null;
    sets.push("dose_unit = ?");
    args.push(unit);
    if (unit !== current.dose_unit) materialChange = true;
  }

  // PRN and schedule are validated together: PRN medications carry no
  // schedule, and schedule times must be well-formed HH:MM.
  const wantsPrn = body.is_prn !== undefined ? !!body.is_prn : current.is_prn === 1;
  if (body.is_prn !== undefined) {
    sets.push("is_prn = ?");
    args.push(wantsPrn ? 1 : 0);
    if ((wantsPrn ? 1 : 0) !== current.is_prn) materialChange = true;
  }
  if (body.schedule_times !== undefined || body.is_prn !== undefined) {
    let times: string[];
    if (wantsPrn) {
      times = [];
    } else if (body.schedule_times !== undefined) {
      if (!Array.isArray(body.schedule_times) || body.schedule_times.some((t) => typeof t !== "string" || !TIME_RE.test(t))) {
        return NextResponse.json({ error: "schedule_times must be an array of HH:MM strings." }, { status: 400 });
      }
      times = [...new Set(body.schedule_times)].sort();
    } else {
      times = JSON.parse(current.schedule_times) as string[];
    }
    const encoded = JSON.stringify(times);
    sets.push("schedule_times = ?");
    args.push(encoded);
    if (encoded !== current.schedule_times) materialChange = true;
  }

  if (body.start_date !== undefined) {
    if (body.start_date !== null && (typeof body.start_date !== "string" || !DATE_RE.test(body.start_date))) {
      return NextResponse.json({ error: "start_date must be YYYY-MM-DD or null." }, { status: 400 });
    }
    sets.push("start_date = ?");
    args.push(body.start_date);
  }
  if (body.instructions !== undefined) {
    sets.push("instructions = ?");
    args.push((body.instructions ?? "").trim().slice(0, 500) || null);
  }

  if (sets.length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  // Dose/schedule edits stamp the medication so attached clinician reviews
  // can warn "dose changed since this review" (the review itself survives —
  // it targets the product combination, which hasn't changed).
  if (materialChange) {
    sets.push("last_material_change_at = datetime('now')");
  }

  db.prepare(`UPDATE medications SET ${sets.join(", ")} WHERE id = ? AND profile_id = ?`).run(...args, medId, profileId);

  const { all } = recomputeAlerts(db, profileId);
  return NextResponse.json({
    ok: true,
    medication: getMedicationsWithIngredients(db, profileId).find((m) => m.id === medId),
    alerts: attachReviews(db, profileId, annotateAlertsWithExposure(all, computeExposure(db, profileId))),
  });
}

export async function DELETE(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const medId = Number(id);
  if (!Number.isInteger(medId)) return NextResponse.json({ error: "Bad id." }, { status: 400 });

  const auth = authorize(request);
  if ("fail" in auth) return auth.fail;
  const { db, profileId } = auth;

  const info = db.prepare("DELETE FROM medications WHERE id = ? AND profile_id = ?").run(medId, profileId);
  if (Number(info.changes) === 0) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const { all } = recomputeAlerts(db, profileId);
  return NextResponse.json({
    ok: true,
    alerts: attachReviews(db, profileId, annotateAlertsWithExposure(all, computeExposure(db, profileId))),
  });
}
