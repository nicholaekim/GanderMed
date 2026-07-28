// Clinician alert reviews ("this combination is intentional and managed").
// A review is keyed to the exact combination identity — kind, the two product
// ids, the ingredient pair, and the ruleset version — NOT to the alert row.
// Alerts are recomputed constantly; the review re-attaches only while that
// identity holds, so the system re-alerts automatically when a product is
// swapped, a new product introduces the same pair, the ruleset updates, or
// the review expires. Reviews are annotations by professionals; they never
// change severity and never suppress an alert entirely.

import type { DatabaseSync } from "node:sqlite";
import type { Alert, AlertReview } from "@/lib/types";

interface ReviewRow extends AlertReview {
  profile_id: number;
  kind: string;
  ingredient_a: string;
  ingredient_b: string;
  med_a_id: number;
  med_b_id: number;
  source_version: string;
}

function identityKey(r: {
  kind: string;
  med_a_id: number;
  med_b_id: number;
  ingredient_a: string;
  ingredient_b: string;
  source_version: string;
}): string {
  return `${r.kind}|${r.med_a_id}|${r.med_b_id}|${r.ingredient_a}|${r.ingredient_b}|${r.source_version}`;
}

export function attachReviews(db: DatabaseSync, profileId: number, alerts: Alert[]): Alert[] {
  const rows = db
    .prepare(
      `SELECT id, note, reviewer_name, reviewer_clinic, created_at, expires_at,
              profile_id, kind, ingredient_a, ingredient_b, med_a_id, med_b_id, source_version
       FROM alert_reviews
       WHERE profile_id = ? AND revoked_at IS NULL AND expires_at > ?`
    )
    .all(profileId, new Date().toISOString()) as unknown as ReviewRow[];
  const byKey = new Map(rows.map((r) => [identityKey(r), r]));

  for (const a of alerts) {
    const r = byKey.get(identityKey(a));
    a.review = r
      ? {
          id: r.id,
          note: r.note,
          reviewer_name: r.reviewer_name,
          reviewer_clinic: r.reviewer_clinic,
          created_at: r.created_at,
          expires_at: r.expires_at,
        }
      : null;
  }
  return alerts;
}
