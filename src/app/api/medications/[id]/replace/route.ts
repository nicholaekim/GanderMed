// Explicit product replacement (Phase 7). Verified identity is immutable on
// a medication row, so switching products = stop-and-retain the old row and
// create a fresh verified row that inherits the usage settings. The new row
// gets a new id, which deliberately breaks alert-review identity — reviews
// detach and the pair re-alerts for the new product, exactly like any other
// product swap.

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { DPD_VERIFY_MESSAGES, DpdVerifyError, getVerifiedProduct } from "@/lib/dpd";
import { getMedicationsWithIngredients, recomputeAlerts } from "@/lib/conflicts";
import { annotateAlertsWithExposure, computeExposure } from "@/lib/exposure";
import { attachReviews } from "@/lib/reviews";
import { getUserFromRequest, resolveProfileAccess } from "@/lib/auth";
import { canonicalIngredient, detectExtendedRelease } from "@/lib/normalize";
import { recordInitialSchedule } from "@/lib/adherence";
import { isPlanned } from "@/lib/lifecycle";
import { logMedEvent } from "@/lib/medevents";
import type { Medication } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const medId = Number(id);
  if (!Number.isInteger(medId)) return NextResponse.json({ error: "Bad id." }, { status: 400 });

  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const access = resolveProfileAccess(db, user, request, { write: true });
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.status });
  const profileId = access.profileId;

  let body: { drug_code?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof body.drug_code !== "number") {
    return NextResponse.json({ error: "Pick the replacement product from the Health Canada search." }, { status: 400 });
  }

  const old = db
    .prepare("SELECT * FROM medications WHERE id = ? AND profile_id = ?")
    .get(medId, profileId) as unknown as Medication | undefined;
  if (!old) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (old.replaced_by_id != null) {
    return NextResponse.json({ error: "This medication was already replaced." }, { status: 409 });
  }
  if (isPlanned(old)) {
    // An unstarted plan has nothing to hand over (no usage to inherit, no
    // history to retain). The plan's own confirmation actions cover this:
    // "cancelled or replaced" if the prescriber swapped it.
    return NextResponse.json(
      { error: "This is an unconfirmed medication plan — confirm it first, or mark it cancelled/replaced from the plan card." },
      { status: 409 }
    );
  }

  let verified;
  try {
    verified = await getVerifiedProduct(body.drug_code);
  } catch (e) {
    if (e instanceof DpdVerifyError) {
      return NextResponse.json({ error: DPD_VERIFY_MESSAGES[e.code] }, { status: 422 });
    }
    console.error("DPD verification failed:", e);
    return NextResponse.json(
      { error: "Could not fetch product details from Health Canada. Try again in a moment." },
      { status: 502 }
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  db.exec("BEGIN");
  let newId: number;
  try {
    // The new row inherits how the patient was taking the old product
    // (dose/schedule/PRN/instructions/actual-use) as a starting point they
    // can edit; strengths may differ between products, so the UI reminds
    // them to double-check the dose.
    const info = db
      .prepare(
        `INSERT INTO medications
         (profile_id, drug_code, din, brand_name, company_name, route, dosage_form, verified, is_extended_release,
          dose_value, dose_unit, is_prn, schedule_times, start_date, instructions, actual_use, patient_notes, lifecycle_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        verified.drug_code,
        verified.din,
        verified.brand_name,
        verified.company_name,
        verified.route,
        verified.dosage_form,
        detectExtendedRelease(verified.brand_name, verified.dosage_form) ? 1 : 0,
        old.dose_value,
        old.dose_unit,
        old.is_prn,
        old.schedule_times,
        today,
        old.instructions,
        old.actual_use,
        old.patient_notes,
        old.actual_use === "taking_differently" ? "taking_differently" : "currently_taking"
      );
    newId = Number(info.lastInsertRowid);
    recordInitialSchedule(db, newId, old.is_prn, old.schedule_times);

    const ins = db.prepare(
      `INSERT INTO medication_ingredients (medication_id, ingredient_name, canonical_name, strength, strength_unit)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const ing of verified.ingredients) {
      ins.run(newId, ing.ingredient_name, canonicalIngredient(ing.ingredient_name), ing.strength, ing.strength_unit);
    }

    // Stop-and-retain: dose history stays on the old row; the link records
    // what superseded it. BOTH status columns move — 'replaced' lifecycle
    // with its 'stopped' legacy mirror — or the old row would keep phantom
    // Today slots and current-use alerts.
    db.prepare(
      "UPDATE medications SET status = 'stopped', lifecycle_status = 'replaced', end_date = ?, replaced_by_id = ? WHERE id = ?"
    ).run(today, newId, medId);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    console.error("Replace medication failed:", e);
    return NextResponse.json({ error: "Could not replace the medication." }, { status: 500 });
  }

  logMedEvent(db, {
    medicationId: medId,
    profileId,
    type: "medication_replaced",
    actorUserId: user.id,
    actorRole: user.role === "clinician" ? "clinician" : "patient",
    meta: { replaced_by: newId, new_drug_code: verified.drug_code },
  });

  const { created, all } = recomputeAlerts(db, profileId);
  const exposure = computeExposure(db, profileId);
  annotateAlertsWithExposure(all, exposure);
  annotateAlertsWithExposure(created, exposure);
  attachReviews(db, profileId, all);
  attachReviews(db, profileId, created);
  return NextResponse.json({
    ok: true,
    medication: getMedicationsWithIngredients(db, profileId).find((m) => m.id === newId),
    newAlerts: created,
    alerts: all,
  });
}
