// Clinician-entered MEDICATION PLANS. This is NOT e-prescribing: the plan
// records a prescription that was written outside GanderMed, and nothing is
// transmitted anywhere. The patient must confirm receiving and starting it
// before it counts as taken — until then it is a planned medication.
//
// Server-enforced boundaries:
//   - only a clinician with a live patient-approved grant may create a plan
//     (org-aware, per-request membership — same pattern as alert reviews);
//   - the product identity comes from Health Canada, never the client;
//   - the prescribed_* fields are written once here and are immutable;
//   - the clinician can NEVER mark the plan received, started, or taken —
//     those transitions belong to the patient (see medications/[id]/lifecycle).

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest } from "@/lib/auth";
import { DPD_VERIFY_MESSAGES, DpdVerifyError, getVerifiedProduct } from "@/lib/dpd";
import { getMedicationsWithIngredients, recomputeAlerts } from "@/lib/conflicts";
import { annotateAlertsWithExposure, computeExposure } from "@/lib/exposure";
import { attachReviews } from "@/lib/reviews";
import { canonicalIngredient, detectExtendedRelease } from "@/lib/normalize";
import { recordInitialSchedule } from "@/lib/adherence";
import { activeMembership, canReview } from "@/lib/org";
import { logMedEvent, notify } from "@/lib/medevents";
import { logAudit } from "@/lib/access";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (user.role !== "clinician") {
    return NextResponse.json({ error: "Medication plans are entered by care-team accounts." }, { status: 403 });
  }

  const profileId = Number(new URL(request.url).searchParams.get("patient"));
  if (!Number.isInteger(profileId)) {
    return NextResponse.json({ error: "Missing ?patient=<id>." }, { status: 400 });
  }

  // Org-aware grant check (the alert-reviews pattern): individual grant, or
  // the org's grant while the caller is an ACTIVE member right now. Under
  // org access, entering a plan is a clinical act — pharmacist/owner only.
  const membership = activeMembership(db, user.id);
  const grant = db
    .prepare(
      `SELECT id, organization_id FROM access_grants
       WHERE profile_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)
         AND ((organization_id IS NULL AND clinician_user_id = ?)
           OR (organization_id IS NOT NULL AND organization_id = ?))
       ORDER BY organization_id IS NULL DESC LIMIT 1`
    )
    .get(profileId, new Date().toISOString(), user.id, membership?.organization_id ?? -1) as
    | { id: number; organization_id: number | null }
    | undefined;
  if (!grant) {
    return NextResponse.json({ error: "No active patient-approved access for this record." }, { status: 403 });
  }
  if (grant.organization_id != null && (!membership || !canReview(membership.org_role))) {
    return NextResponse.json(
      { error: "Medication plans require a pharmacist or owner account in your organization." },
      { status: 403 }
    );
  }

  let body: {
    drug_code?: number;
    prescribed_dose_value?: number | null;
    prescribed_dose_unit?: string | null;
    prescribed_is_prn?: boolean;
    prescribed_schedule_times?: string[];
    prescribed_instructions?: string | null;
    prescribed_at?: string | null;
    prescriber_name?: string | null;
    prescriber_profession?: string | null;
    prescriber_licence_number?: string | null;
    replaces_medication_id?: number | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof body.drug_code !== "number") {
    return NextResponse.json({ error: "Pick the product from the Health Canada search." }, { status: 400 });
  }
  if (
    body.prescribed_dose_value != null &&
    (typeof body.prescribed_dose_value !== "number" || !isFinite(body.prescribed_dose_value) || body.prescribed_dose_value < 0)
  ) {
    return NextResponse.json({ error: "prescribed_dose_value must be a non-negative number." }, { status: 400 });
  }
  if (body.prescribed_at != null && !DATE_RE.test(body.prescribed_at)) {
    return NextResponse.json({ error: "prescribed_at must be YYYY-MM-DD." }, { status: 400 });
  }
  const prn = !!body.prescribed_is_prn;
  const times = prn
    ? []
    : Array.isArray(body.prescribed_schedule_times)
      ? [...new Set(body.prescribed_schedule_times.filter((t) => typeof t === "string" && TIME_RE.test(t)))].sort()
      : [];

  // Optional replacement link: the OLD medication is only linked here — its
  // lifecycle changes when the PATIENT confirms stopping it. The prescriber
  // saying "replaced" and the patient still taking it are two different
  // truths, and reconciliation shows the gap instead of papering over it.
  let replaces: { id: number; brand_name: string } | null = null;
  if (body.replaces_medication_id != null) {
    replaces = (db
      .prepare("SELECT id, brand_name FROM medications WHERE id = ? AND profile_id = ?")
      .get(Number(body.replaces_medication_id), profileId) ?? null) as { id: number; brand_name: string } | null;
    if (!replaces) return NextResponse.json({ error: "The medication being replaced was not found." }, { status: 404 });
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

  const prescribedAt = body.prescribed_at ?? new Date().toISOString().slice(0, 10);
  const encodedTimes = JSON.stringify(times);
  const doseUnit = (body.prescribed_dose_unit ?? "").trim().slice(0, 30) || null;
  const instructions = (body.prescribed_instructions ?? "").trim().slice(0, 500) || null;

  db.exec("BEGIN");
  let medId: number;
  try {
    // The operative dose/schedule columns are initialized FROM the
    // prescription as the starting point; once the patient starts and edits
    // them, they diverge as the patient-reported truth while prescribed_*
    // stays frozen.
    const info = db
      .prepare(
        `INSERT INTO medications
         (profile_id, drug_code, din, brand_name, company_name, route, dosage_form, verified, is_extended_release,
          dose_value, dose_unit, is_prn, schedule_times, start_date, instructions,
          status, lifecycle_status, source_type, source_user_id, provenance,
          prescriber_name, prescriber_profession, prescriber_licence_number, prescribed_at,
          prescribed_dose_value, prescribed_dose_unit, prescribed_is_prn, prescribed_schedule_times, prescribed_instructions)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, NULL, ?,
                 'stopped', 'prescribed', 'clinician_medication_plan', ?, 'prescriber-listed',
                 ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        body.prescribed_dose_value ?? null,
        doseUnit,
        prn ? 1 : 0,
        encodedTimes,
        instructions,
        user.id,
        (body.prescriber_name ?? "").trim().slice(0, 120) || user.display_name,
        (body.prescriber_profession ?? "").trim().slice(0, 80) || null,
        (body.prescriber_licence_number ?? "").trim().slice(0, 60) || null,
        prescribedAt,
        body.prescribed_dose_value ?? null,
        doseUnit,
        prn ? 1 : 0,
        encodedTimes,
        instructions
      );
    medId = Number(info.lastInsertRowid);
    recordInitialSchedule(db, medId, prn ? 1 : 0, encodedTimes);

    const ins = db.prepare(
      `INSERT INTO medication_ingredients (medication_id, ingredient_name, canonical_name, strength, strength_unit)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const ing of verified.ingredients) {
      ins.run(medId, ing.ingredient_name, canonicalIngredient(ing.ingredient_name), ing.strength, ing.strength_unit);
    }
    if (replaces) {
      db.prepare("UPDATE medications SET replaced_by_id = ? WHERE id = ?").run(medId, replaces.id);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    console.error("Medication plan insert failed:", e);
    return NextResponse.json({ error: "Could not save the medication plan." }, { status: 500 });
  }

  logMedEvent(db, {
    medicationId: medId,
    profileId,
    type: "plan_created",
    actorUserId: user.id,
    actorRole: "clinician",
    meta: {
      grant: grant.id,
      org: grant.organization_id,
      drug_code: verified.drug_code,
      replaces: replaces?.id ?? null,
    },
  });
  logAudit(db, {
    actor: user.id,
    action: "medication_plan_created",
    profileId,
    targetId: medId,
    meta: grant.organization_id != null ? { via: "org", org: grant.organization_id } : { via: "individual" },
  });

  const { created, all } = recomputeAlerts(db, profileId);
  const exposure = computeExposure(db, profileId);
  annotateAlertsWithExposure(all, exposure);
  annotateAlertsWithExposure(created, exposure);
  attachReviews(db, profileId, all);
  attachReviews(db, profileId, created);

  // Notify the patient: a new plan awaits their confirmation, plus any
  // planned interaction the check just surfaced.
  const patientUser = db.prepare("SELECT user_id FROM profiles WHERE id = ?").get(profileId) as {
    user_id: number | null;
  };
  if (patientUser?.user_id) {
    notify(db, {
      userId: patientUser.user_id,
      profileId,
      medicationId: medId,
      type: "plan_created",
      body: `${verified.brand_name}: a new medication plan was entered by ${user.display_name}. Please confirm when you receive and start it.`,
    });
    for (const a of created.filter((x) => x.concern_class === "planned")) {
      notify(db, {
        userId: patientUser.user_id,
        profileId,
        medicationId: medId,
        type: "planned_alert",
        body: `Potential ${a.severity} concern involving newly prescribed ${verified.brand_name} — you haven't started it yet. Worth discussing with your pharmacist before the first dose.`,
        dedupeKey: `planned_alert:${a.id}`,
      });
    }
    if (replaces) {
      notify(db, {
        userId: patientUser.user_id,
        profileId,
        medicationId: medId,
        type: "plan_replacement",
        body: `${verified.brand_name} was entered as a replacement for ${replaces.brand_name}. Once you start the new one, please confirm whether you've stopped the old one.`,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    medication: getMedicationsWithIngredients(db, profileId).find((m) => m.id === medId),
    newAlerts: created,
    alerts: all,
  });
}
