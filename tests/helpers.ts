// Shared test fixtures: an in-memory database with the REAL schema and the
// REAL seeded ruleset, plus builders that write rows the same shape the API
// routes do. No mocks — the engine under test is the production engine.

import type { DatabaseSync } from "node:sqlite";
import { createDatabase } from "../src/lib/db";
import { canonicalIngredient } from "../src/lib/normalize";

export function freshDb(): DatabaseSync {
  return createDatabase(":memory:");
}

let shareCounter = 0;

export function addProfile(db: DatabaseSync, name = "Test Patient"): number {
  shareCounter += 1;
  const info = db
    .prepare("INSERT INTO profiles (name, share_code) VALUES (?, ?)")
    .run(name, `TEST-${String(shareCounter).padStart(4, "0")}`);
  return Number(info.lastInsertRowid);
}

export interface MedSpec {
  name: string;
  ingredients: { name: string; strength?: string; unit?: string }[];
  verified?: boolean;
  prn?: boolean;
  extendedRelease?: boolean;
  status?: "active" | "stopped";
}

export function addMed(db: DatabaseSync, profileId: number, spec: MedSpec): number {
  const info = db
    .prepare(
      `INSERT INTO medications
       (profile_id, brand_name, verified, is_extended_release, dose_value, dose_unit, is_prn, schedule_times, status)
       VALUES (?, ?, ?, ?, 1, 'tablet(s)', ?, '[]', ?)`
    )
    .run(
      profileId,
      spec.name,
      spec.verified === false ? 0 : 1,
      spec.extendedRelease ? 1 : 0,
      spec.prn === false ? 0 : 1,
      spec.status ?? "active"
    );
  const medId = Number(info.lastInsertRowid);
  const ins = db.prepare(
    `INSERT INTO medication_ingredients (medication_id, ingredient_name, canonical_name, strength, strength_unit)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const ing of spec.ingredients) {
    ins.run(medId, ing.name, canonicalIngredient(ing.name), ing.strength ?? null, ing.unit ?? (ing.strength ? "MG" : null));
  }
  return medId;
}

export function logDose(
  db: DatabaseSync,
  medId: number,
  opts: { hoursAgo: number; doseValue?: number; doseUnit?: string; status?: "taken" | "late" | "skipped" }
): void {
  db.prepare(
    `INSERT INTO dose_events (medication_id, scheduled_at, logged_at, status, dose_value, dose_unit)
     VALUES (?, NULL, ?, ?, ?, ?)`
  ).run(
    medId,
    new Date(Date.now() - opts.hoursAgo * 3_600_000).toISOString(),
    opts.status ?? "taken",
    opts.doseValue ?? 1,
    opts.doseUnit ?? "tablet(s)"
  );
}
