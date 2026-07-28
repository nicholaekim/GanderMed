import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getProductDetails } from "@/lib/dpd";
import { getMedicationsWithIngredients, recomputeAlerts } from "@/lib/conflicts";
import { annotateAlertsWithExposure, computeExposure } from "@/lib/exposure";
import { attachReviews } from "@/lib/reviews";
import { getUserFromRequest, resolveProfileAccess } from "@/lib/auth";
import { canonicalIngredient, detectExtendedRelease } from "@/lib/normalize";
import type { AddMedicationPayload } from "@/lib/types";

export async function GET(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const access = resolveProfileAccess(db, user, request, { write: false });
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.status });

  const profile = db.prepare("SELECT id, name FROM profiles WHERE id = ?").get(access.profileId);
  return NextResponse.json({
    medications: getMedicationsWithIngredients(db, access.profileId),
    profile,
  });
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function POST(request: Request) {
  const db0 = getDb();
  const user = getUserFromRequest(db0, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const access = resolveProfileAccess(db0, user, request, { write: true });
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.status });
  const profileId = access.profileId;

  let body: AddMedicationPayload;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const isDpd = typeof body.drug_code === "number" && !!body.brand_name;
  const isManual = !!body.manual_name?.trim();
  if (!isDpd && !isManual) {
    return NextResponse.json(
      { error: "Select a product from the Health Canada search, or provide a manual name." },
      { status: 400 }
    );
  }

  const scheduleTimes = Array.isArray(body.schedule_times)
    ? [...new Set(body.schedule_times.filter((t) => TIME_RE.test(t)))].sort()
    : [];

  const db = getDb();

  let details = null;
  if (isDpd) {
    try {
      details = await getProductDetails(body.drug_code!);
    } catch (e) {
      console.error("DPD details failed:", e);
      return NextResponse.json(
        { error: "Could not fetch product details from Health Canada. Try again in a moment." },
        { status: 502 }
      );
    }
    if (!details.ingredients.length) {
      return NextResponse.json(
        { error: "Health Canada lists no active ingredients for this product, so it cannot be safety-checked. Add it as an unverified entry instead." },
        { status: 422 }
      );
    }
  }

  db.exec("BEGIN");
  let medId: number;
  try {
    const displayName = isDpd ? body.brand_name! : body.manual_name!.trim();
    const info = db
      .prepare(
        `INSERT INTO medications
         (profile_id, drug_code, din, brand_name, company_name, route, dosage_form, verified, is_extended_release,
          dose_value, dose_unit, is_prn, schedule_times, start_date, end_date, instructions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        isDpd ? body.drug_code! : null,
        isDpd ? body.din ?? null : null,
        displayName,
        isDpd ? body.company_name ?? null : null,
        details?.route ?? null,
        details?.dosage_form ?? null,
        isDpd ? 1 : 0,
        detectExtendedRelease(displayName, details?.dosage_form ?? null) ? 1 : 0,
        body.dose_value ?? null,
        body.dose_unit ?? null,
        body.is_prn ? 1 : 0,
        JSON.stringify(scheduleTimes),
        body.start_date ?? null,
        body.end_date ?? null,
        body.instructions?.trim() || null
      );
    medId = Number(info.lastInsertRowid);

    if (details) {
      const ins = db.prepare(
        `INSERT INTO medication_ingredients (medication_id, ingredient_name, canonical_name, strength, strength_unit)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const ing of details.ingredients) {
        ins.run(medId, ing.ingredient_name, canonicalIngredient(ing.ingredient_name), ing.strength, ing.strength_unit);
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    console.error("Insert medication failed:", e);
    return NextResponse.json({ error: "Could not save the medication." }, { status: 500 });
  }

  const { created, all } = recomputeAlerts(db, profileId);
  const exposure = computeExposure(db, profileId);
  annotateAlertsWithExposure(all, exposure);
  annotateAlertsWithExposure(created, exposure);
  attachReviews(db, profileId, all);
  attachReviews(db, profileId, created);
  const medication = getMedicationsWithIngredients(db, profileId).find((m) => m.id === medId);
  return NextResponse.json({ medication, newAlerts: created, alerts: all });
}
