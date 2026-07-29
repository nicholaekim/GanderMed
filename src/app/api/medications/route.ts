import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { DpdVerifyError, getVerifiedProduct, type VerifiedProduct } from "@/lib/dpd";
import { getMedicationsWithIngredients, recomputeAlerts } from "@/lib/conflicts";
import { annotateAlertsWithExposure, computeExposure } from "@/lib/exposure";
import { attachReviews } from "@/lib/reviews";
import { logAudit } from "@/lib/access";
import { getUserFromRequest, resolveProfileAccess } from "@/lib/auth";
import { canonicalIngredient, detectExtendedRelease } from "@/lib/normalize";
import type { AddMedicationPayload } from "@/lib/types";

export async function GET(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const access = resolveProfileAccess(db, user, request, { write: false });
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.status });

  if (user.role === "clinician") {
    logAudit(db, { actor: user.id, action: "record_opened", profileId: access.profileId });
  }
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

  const isDpd = typeof body.drug_code === "number";
  const isManual = !isDpd && !!body.manual_name?.trim();
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

  // Verified path: the client supplies ONLY drug_code. Brand, DIN, company,
  // route, form, and ingredients are resolved authoritatively from Health
  // Canada, and non-marketed / non-human / ingredient-less products are
  // rejected. Client-sent metadata is ignored entirely.
  let verified: VerifiedProduct | null = null;
  if (isDpd) {
    try {
      verified = await getVerifiedProduct(body.drug_code!);
    } catch (e) {
      if (e instanceof DpdVerifyError) {
        const messages: Record<string, string> = {
          not_found: "Health Canada has no product with that identifier.",
          not_human: "That product isn't a human medication, so it can't be added as a verified product.",
          not_marketed:
            "That product isn't currently marketed in Canada, so it can't be safety-checked. Add it as an unverified entry if you still take it.",
          no_ingredients:
            "Health Canada lists no active ingredients for this product, so it cannot be safety-checked. Add it as an unverified entry instead.",
        };
        return NextResponse.json({ error: messages[e.code] }, { status: 422 });
      }
      console.error("DPD verification failed:", e);
      return NextResponse.json(
        { error: "Could not fetch product details from Health Canada. Try again in a moment." },
        { status: 502 }
      );
    }
  }

  db.exec("BEGIN");
  let medId: number;
  try {
    const displayName = verified ? verified.brand_name : body.manual_name!.trim();
    const info = db
      .prepare(
        `INSERT INTO medications
         (profile_id, drug_code, din, brand_name, company_name, route, dosage_form, verified, is_extended_release,
          dose_value, dose_unit, is_prn, schedule_times, start_date, end_date, instructions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        verified?.drug_code ?? null,
        verified?.din ?? null,
        displayName,
        verified?.company_name ?? null,
        verified?.route ?? null,
        verified?.dosage_form ?? null,
        verified ? 1 : 0,
        detectExtendedRelease(displayName, verified?.dosage_form ?? null) ? 1 : 0,
        body.dose_value ?? null,
        body.dose_unit ?? null,
        body.is_prn ? 1 : 0,
        JSON.stringify(scheduleTimes),
        body.start_date ?? null,
        body.end_date ?? null,
        body.instructions?.trim() || null
      );
    medId = Number(info.lastInsertRowid);

    if (verified) {
      const ins = db.prepare(
        `INSERT INTO medication_ingredients (medication_id, ingredient_name, canonical_name, strength, strength_unit)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const ing of verified.ingredients) {
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
