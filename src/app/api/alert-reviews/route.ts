import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest } from "@/lib/auth";
import { logAudit } from "@/lib/access";
import type { Alert } from "@/lib/types";

const VALID_DAYS = new Set([30, 90, 180]);

// Clinicians only: record that this exact combination was professionally
// reviewed. This is the one deliberate write a care-team account has — it
// annotates, it does not modify the patient's record.
export async function POST(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (user.role !== "clinician") {
    return NextResponse.json({ error: "Only care-team accounts can review alerts." }, { status: 403 });
  }

  let body: { alert_id?: number; note?: string; expires_days?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const alertId = Number(body.alert_id);
  const note = body.note?.trim() ?? "";
  const days = Number(body.expires_days);
  if (!Number.isInteger(alertId)) return NextResponse.json({ error: "alert_id required." }, { status: 400 });
  if (note.length < 5) return NextResponse.json({ error: "Write a short review note (what was decided and why)." }, { status: 400 });
  if (!VALID_DAYS.has(days)) return NextResponse.json({ error: "expires_days must be 30, 90, or 180." }, { status: 400 });

  const alert = db.prepare("SELECT * FROM alerts WHERE id = ?").get(alertId) as unknown as Alert | undefined;
  if (!alert) return NextResponse.json({ error: "Alert not found." }, { status: 404 });

  const grant = db
    .prepare(
      `SELECT 1 FROM access_grants
       WHERE clinician_user_id = ? AND profile_id = ? AND status = 'active'
         AND (expires_at IS NULL OR expires_at > datetime('now'))`
    )
    .get(user.id, alert.profile_id);
  if (!grant) return NextResponse.json({ error: "No active patient-approved access for this record." }, { status: 403 });

  db.exec("BEGIN");
  try {
    // Replace semantics: a newer review supersedes any active one for the
    // same combination (the old row stays, soft-revoked, as history).
    db.prepare(
      `UPDATE alert_reviews SET revoked_at = ?
       WHERE profile_id = ? AND kind = ? AND med_a_id = ? AND med_b_id = ?
         AND ingredient_a = ? AND ingredient_b = ? AND revoked_at IS NULL`
    ).run(
      new Date().toISOString(),
      alert.profile_id, alert.kind, alert.med_a_id, alert.med_b_id,
      alert.ingredient_a, alert.ingredient_b
    );
    const expires = new Date(Date.now() + days * 86_400_000).toISOString();
    const info = db
      .prepare(
        `INSERT INTO alert_reviews
         (profile_id, kind, ingredient_a, ingredient_b, med_a_id, med_b_id,
          reviewer_user_id, reviewer_name, reviewer_clinic, note, source_version, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        alert.profile_id, alert.kind, alert.ingredient_a, alert.ingredient_b,
        alert.med_a_id, alert.med_b_id,
        user.id, user.display_name, user.clinic_name, note, alert.source_version, expires
      );
    db.exec("COMMIT");
    const reviewId = Number(info.lastInsertRowid);
    logAudit(db, { actor: user.id, action: "review_created", profileId: alert.profile_id, targetId: reviewId });
    const review = db.prepare("SELECT * FROM alert_reviews WHERE id = ?").get(reviewId);
    return NextResponse.json({ review });
  } catch (e) {
    db.exec("ROLLBACK");
    console.error("Review insert failed:", e);
    return NextResponse.json({ error: "Could not save the review." }, { status: 500 });
  }
}
