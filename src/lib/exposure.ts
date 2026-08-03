// Time-aware exposure engine. Turns actual dose events into:
//   1. estimated "active right now" ingredient windows,
//   2. rolling 24-hour ingredient totals with per-product sources,
//   3. an overlap annotation for alerts (is this warning about ingredients
//      that were BOTH actually taken recently, or just co-listed?).
//
// Everything here is deterministic arithmetic over curated demo profiles.
// When a dose can't be converted to milligrams (unit mismatch, combination
// product logged in mg), it is reported as "uncounted" with the reason —
// the engine refuses to guess.

import type { DatabaseSync } from "node:sqlite";
import type {
  ActiveIngredient,
  Alert,
  ExposureReport,
  ExposureStatus,
  Medication,
  RollingTotal,
} from "@/lib/types";
import { EXPOSURE_VERSION, INGREDIENT_PROFILES } from "@/data/ingredientProfiles";
import { getMedicationsWithIngredients } from "@/lib/conflicts";
import { inExposureWindows } from "@/lib/lifecycle";

const HOUR_MS = 3_600_000;
const ROLLING_WINDOW_MS = 24 * HOUR_MS;
// Look back far enough to catch the longest profile window (derived from the
// data so a new long-half-life ingredient can never silently fall outside it).
const LOOKBACK_MS =
  (Math.max(...Object.values(INGREDIENT_PROFILES).map((p) => p.active_window_hours)) + 24) * HOUR_MS;

const COUNTABLE_UNITS = new Set(["tablet(s)", "capsule(s)"]);

interface ProfileRow {
  canonical_name: string;
  active_window_hours: number;
  half_life_hours: number | null;
  window_basis: "half_life" | "effect_duration";
  max_daily_mg: number | null;
  note: string | null;
}

interface EventRow {
  medication_id: number;
  logged_at: string;
  status: string;
  dose_value: number | null;
  dose_unit: string | null;
}

export interface ExposureComputation {
  report: ExposureReport;
  /** keys `${medicationId}|${canonicalIngredient}` currently inside an estimated window */
  activeKeys: Set<string>;
  /** keys for which window modeling is possible at all (profiled ingredient, non-ER product) */
  modelableKeys: Set<string>;
  /** medications with at least one taken/late dose inside the lookback window */
  dosedMedIds: Set<number>;
}

function doseMg(
  event: EventRow,
  med: Medication,
  strength: string | null,
  strengthUnit: string | null
): { mg: number | null; reason?: string } {
  if (event.dose_value == null || event.dose_unit == null) {
    return { mg: null, reason: "no dose amount recorded" };
  }
  const unit = event.dose_unit.toLowerCase();
  if (COUNTABLE_UNITS.has(unit)) {
    if (strengthUnit?.toUpperCase() !== "MG" || !strength) {
      return { mg: null, reason: `strength listed as ${strength ?? "?"} ${strengthUnit ?? "?"} — can't convert to mg` };
    }
    const perUnit = parseFloat(strength);
    if (!isFinite(perUnit)) return { mg: null, reason: "unparseable strength" };
    return { mg: event.dose_value * perUnit };
  }
  if (unit === "mg") {
    if (med.ingredients.length !== 1) {
      return { mg: null, reason: "mg dose of a combination product is ambiguous" };
    }
    return { mg: event.dose_value };
  }
  return { mg: null, reason: `dose logged in ${event.dose_unit} — can't convert to mg` };
}

export function computeExposure(db: DatabaseSync, profileId: number): ExposureComputation {
  const now = Date.now();
  const meds = getMedicationsWithIngredients(db, profileId).filter((m) => m.verified === 1);
  const medById = new Map(meds.map((m) => [m.id, m]));

  const profiles = db.prepare("SELECT * FROM ingredient_profiles").all() as unknown as ProfileRow[];
  const profileByName = new Map(profiles.map((p) => [p.canonical_name, p]));

  const events = db
    .prepare(
      `SELECT de.medication_id, de.logged_at, de.status, de.dose_value, de.dose_unit
       FROM dose_events de JOIN medications m ON m.id = de.medication_id
       WHERE m.profile_id = ? AND de.status IN ('taken','late') AND de.logged_at >= ?
       ORDER BY de.logged_at ASC`
    )
    .all(profileId, new Date(now - LOOKBACK_MS).toISOString()) as unknown as EventRow[];

  // Which (med, ingredient) pairs can be window-modeled at all — used to
  // distinguish "no overlap recorded" from "we can't model this".
  const modelableKeys = new Set<string>();
  for (const m of meds) {
    // Only confirmed current use is window-modeled: a planned medication has
    // no doses in the body, and a paused one has no expected exposure.
    if (!inExposureWindows(m) || m.is_extended_release) continue;
    for (const ing of m.ingredients) {
      if (profileByName.has(ing.canonical_name)) modelableKeys.add(`${m.id}|${ing.canonical_name}`);
    }
  }

  const activeKeys = new Set<string>();
  const dosedMedIds = new Set<number>();
  const activeUntil = new Map<
    string,
    { until: number; sources: Map<string, number>; profile: ProfileRow }
  >(); // ingredient -> latest end
  const totals = new Map<string, RollingTotal>();

  for (const ev of events) {
    const med = medById.get(ev.medication_id);
    if (!med) continue;
    const takenAt = new Date(ev.logged_at).getTime();
    if (isNaN(takenAt)) continue;
    dosedMedIds.add(med.id);

    for (const ing of med.ingredients) {
      const name = ing.canonical_name;
      const profile = profileByName.get(name);

      // Rolling 24h totals (independent of ER status and window modeling).
      if (now - takenAt <= ROLLING_WINDOW_MS && profile?.max_daily_mg != null) {
        if (!totals.has(name)) {
          totals.set(name, {
            ingredient: name,
            total_mg: 0,
            max_daily_mg: profile.max_daily_mg,
            over: false,
            note: profile.note,
            sources: [],
            uncounted: [],
          });
        }
        const t = totals.get(name)!;
        const { mg, reason } = doseMg(ev, med, ing.strength, ing.strength_unit);
        if (mg != null) {
          t.total_mg += mg;
          t.sources.push({ brand_name: med.brand_name, at: ev.logged_at, mg });
        } else {
          t.uncounted.push({ brand_name: med.brand_name, at: ev.logged_at, reason: reason ?? "unknown" });
        }
      }

      // Estimated active windows (immediate-release, profiled ingredients only).
      if (profile && !med.is_extended_release) {
        const end = takenAt + profile.active_window_hours * HOUR_MS;
        if (end > now) {
          activeKeys.add(`${med.id}|${name}`);
          if (!activeUntil.has(name)) activeUntil.set(name, { until: end, sources: new Map(), profile });
          const a = activeUntil.get(name)!;
          a.until = Math.max(a.until, end);
          a.sources.set(med.brand_name, Math.max(a.sources.get(med.brand_name) ?? 0, end));
        }
      }
    }
  }

  for (const t of totals.values()) {
    t.total_mg = Math.round(t.total_mg * 100) / 100;
    t.over = t.max_daily_mg != null && t.total_mg > t.max_daily_mg;
    t.sources.sort((a, b) => b.at.localeCompare(a.at));
  }

  const active_now: ActiveIngredient[] = [...activeUntil.entries()]
    .map(([ingredient, a]) => ({
      ingredient,
      until: new Date(a.until).toISOString(),
      half_life_hours: a.profile.half_life_hours,
      window_basis: a.profile.window_basis,
      sources: [...a.sources.entries()].map(([brand_name, until]) => ({
        brand_name,
        until: new Date(until).toISOString(),
      })),
    }))
    .sort((a, b) => b.until.localeCompare(a.until));

  const totalsList = [...totals.values()].sort((a, b) => {
    if (a.over !== b.over) return a.over ? -1 : 1;
    const pa = a.max_daily_mg ? a.total_mg / a.max_daily_mg : 0;
    const pb = b.max_daily_mg ? b.total_mg / b.max_daily_mg : 0;
    return pb - pa;
  });

  return {
    report: {
      computed_at: new Date(now).toISOString(),
      version: EXPOSURE_VERSION,
      active_now,
      totals: totalsList,
    },
    activeKeys,
    modelableKeys,
    dosedMedIds,
  };
}

// Annotates alerts with what the recorded doses actually support saying:
//   overlap            — both sides estimated active right now
//   no_overlap         — both sides have logged doses, no estimated overlap
//   insufficient_data  — timing is modelable but doses aren't logged; this
//                        must NEVER be presented as reassurance
//   unknown            — timing isn't modelable (no profile / ER product)
// Exposure status NEVER changes an alert's severity — timing separation does
// not remove an interaction concern.
// Alert ingredient pairs are sorted alphabetically while med ids are sorted
// numerically, so ingredient_a is not necessarily med_a's ingredient — both
// orientations must be checked.
export function annotateAlertsWithExposure(alerts: Alert[], exposure: ExposureComputation): Alert[] {
  const { activeKeys, modelableKeys, dosedMedIds } = exposure;
  for (const a of alerts) {
    const pairings: [string, string][] = [
      [`${a.med_a_id}|${a.ingredient_a}`, `${a.med_b_id}|${a.ingredient_b}`],
      [`${a.med_a_id}|${a.ingredient_b}`, `${a.med_b_id}|${a.ingredient_a}`],
    ];
    let status: ExposureStatus = "unknown";
    for (const [keyA, keyB] of pairings) {
      if (!modelableKeys.has(keyA) || !modelableKeys.has(keyB)) continue;
      if (activeKeys.has(keyA) && activeKeys.has(keyB)) {
        status = "overlap";
        break;
      }
      status =
        dosedMedIds.has(a.med_a_id) && dosedMedIds.has(a.med_b_id) ? "no_overlap" : "insufficient_data";
    }
    a.exposure_status = status;
  }
  return alerts;
}
