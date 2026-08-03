// Real adherence (Phase 8): deterministic expected-slot generation and
// matching against what was actually logged.
//
// Definitions (all computed at read time — never persisted):
//   - An EXPECTED SLOT is (medication, local date, HH:mm) generated from the
//     schedule that was IN EFFECT on that date (medication_schedule_history),
//     clamped to the med's start_date (falling back to its creation date) and
//     — for stopped meds — its end_date.
//   - A slot's outcome comes from the dose event logged against that exact
//     scheduled_at: taken → on_time, late → late, skipped → skipped. With no
//     event, the slot is MISSED once more than 60 minutes past its time
//     (matching the server's late threshold), otherwise FUTURE. A late log
//     after the fact converts a missed slot — adherence self-corrects.
//   - PRN medications generate NO slots and can never be "missed"; their
//     taken doses (and any extra unscheduled doses) are counted separately.
//   - THE FORMULA: adherence % = (on_time + late) / (on_time + late +
//     skipped + missed), over slots due in the window. Zero due slots →
//     null, rendered as "no data" — NEVER as 0%.
//
// Timezone: schedule times and scheduled_at are LOCAL wall-clock values (the
// app assumes patient and server share a timezone — documented limitation).
// Dates are iterated with local Date components, so DST transitions shift
// the wall clock, never the number of slots on a date.

import type { DatabaseSync } from "node:sqlite";
import { inAdherence, type LifecycleStatus } from "@/lib/lifecycle";

export type SlotOutcome = "on_time" | "late" | "skipped" | "missed" | "future";

export const ADHERENCE_FORMULA =
  "(on-time + late) ÷ (on-time + late + skipped + missed), over scheduled doses due in the window. No due doses → no percentage (never 0%).";

const GRACE_MS = 60 * 60 * 1000; // a slot isn't "missed" until an hour past — same as the late threshold

export interface MedAdherence {
  medication_id: number;
  brand_name: string;
  med_status: "active" | "stopped";
  is_prn: boolean;
  counts: Record<SlotOutcome, number>;
  /** Denominator: slots already due in the window. */
  expected_due: number;
  /** null = no due slots for this med ("no data"), distinct from 0. */
  adherence_pct: number | null;
  /** Taken doses without a scheduled slot (PRN and extras). */
  unscheduled_doses: number;
}

export interface AdherenceReport {
  window_days: number;
  computed_at: string;
  formula: string;
  per_med: MedAdherence[];
  overall: {
    counts: Record<SlotOutcome, number>;
    expected_due: number;
    adherence_pct: number | null;
    unscheduled_doses: number;
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

export function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function localDateTimeStr(d: Date): string {
  return `${localDateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Records a schedule/PRN change so past dates keep their true schedule.
 * Self-healing: a med with no open history row first gets its pre-change
 * schedule backfilled as "in effect since forever".
 */
export function recordScheduleChange(
  db: DatabaseSync,
  medicationId: number,
  previous: { is_prn: number; schedule_times: string },
  next: { is_prn: number; schedule_times: string },
  effectiveLocal: string
): void {
  const open = db
    .prepare("SELECT id FROM medication_schedule_history WHERE medication_id = ? AND effective_to IS NULL")
    .get(medicationId) as { id: number } | undefined;
  if (open) {
    db.prepare("UPDATE medication_schedule_history SET effective_to = ? WHERE id = ?").run(effectiveLocal, open.id);
  } else {
    db.prepare(
      `INSERT INTO medication_schedule_history (medication_id, is_prn, schedule_times, effective_from, effective_to)
       VALUES (?, ?, ?, '1970-01-01T00:00', ?)`
    ).run(medicationId, previous.is_prn, previous.schedule_times, effectiveLocal);
  }
  db.prepare(
    `INSERT INTO medication_schedule_history (medication_id, is_prn, schedule_times, effective_from, effective_to)
     VALUES (?, ?, ?, ?, NULL)`
  ).run(medicationId, next.is_prn, next.schedule_times, effectiveLocal);
}

/** Initial history row for a newly created medication. */
export function recordInitialSchedule(db: DatabaseSync, medicationId: number, isPrn: number, scheduleTimes: string): void {
  db.prepare(
    `INSERT INTO medication_schedule_history (medication_id, is_prn, schedule_times, effective_from)
     VALUES (?, ?, ?, '1970-01-01T00:00')`
  ).run(medicationId, isPrn, scheduleTimes);
}

interface MedRow {
  id: number;
  brand_name: string;
  status: "active" | "stopped";
  lifecycle_status: LifecycleStatus | null;
  is_prn: number;
  schedule_times: string;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
}

interface HistoryRow {
  is_prn: number;
  schedule_times: string;
  effective_from: string;
  effective_to: string | null;
}

interface EventRow {
  medication_id: number;
  scheduled_at: string | null;
  logged_at: string;
  status: "taken" | "late" | "skipped";
}

function emptyCounts(): Record<SlotOutcome, number> {
  return { on_time: 0, late: 0, skipped: 0, missed: 0, future: 0 };
}

function pct(counts: Record<SlotOutcome, number>): { due: number; pct: number | null } {
  const due = counts.on_time + counts.late + counts.skipped + counts.missed;
  return { due, pct: due > 0 ? Math.round((100 * (counts.on_time + counts.late)) / due) : null };
}

export function computeAdherence(db: DatabaseSync, profileId: number, days: number, now: Date = new Date()): AdherenceReport {
  // Planned medications generate NO expected slots (nothing is due before
  // the patient confirms starting); paused ones have their expectations
  // suspended. Terminal meds keep their history via the date clamps below.
  const meds = (
    db
      .prepare(
        `SELECT id, brand_name, status, lifecycle_status, is_prn, schedule_times, start_date, end_date, created_at
         FROM medications WHERE profile_id = ?`
      )
      .all(profileId) as unknown as MedRow[]
  ).filter((m) => inAdherence(m));

  const historyStmt = db.prepare(
    "SELECT is_prn, schedule_times, effective_from, effective_to FROM medication_schedule_history WHERE medication_id = ? ORDER BY effective_from"
  );

  const events = db
    .prepare(
      `SELECT de.medication_id, de.scheduled_at, de.logged_at, de.status
       FROM dose_events de JOIN medications m ON m.id = de.medication_id
       WHERE m.profile_id = ?`
    )
    .all(profileId) as unknown as EventRow[];

  // The API keeps one event per slot (re-log replaces); if rogue duplicates
  // exist anyway, the latest log wins — matching the API's semantics.
  const bySlot = new Map<string, EventRow>();
  const unscheduledByMed = new Map<number, number>();

  // Window dates, oldest first, via local components (DST-safe).
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    dates.push(localDateStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  }
  const windowStart = dates[0];
  const windowEnd = dates[dates.length - 1];

  for (const ev of events) {
    if (ev.scheduled_at) {
      const day = ev.scheduled_at.slice(0, 10);
      if (day < windowStart || day > windowEnd) continue;
      const key = `${ev.medication_id}|${ev.scheduled_at}`;
      const prev = bySlot.get(key);
      if (!prev || ev.logged_at > prev.logged_at) bySlot.set(key, ev);
    } else if (ev.status === "taken" || ev.status === "late") {
      const local = localDateStr(new Date(ev.logged_at));
      if (local < windowStart || local > windowEnd) continue;
      unscheduledByMed.set(ev.medication_id, (unscheduledByMed.get(ev.medication_id) ?? 0) + 1);
    }
  }

  const nowMs = now.getTime();
  const per_med: MedAdherence[] = [];
  const overallCounts = emptyCounts();
  let overallUnscheduled = 0;

  for (const med of meds) {
    let history = historyStmt.all(med.id) as unknown as HistoryRow[];
    if (history.length === 0) {
      // Legacy/test rows without history: the current schedule is the best
      // available statement of the past.
      history = [{ is_prn: med.is_prn, schedule_times: med.schedule_times, effective_from: "1970-01-01T00:00", effective_to: null }];
    }

    // A med exists for adherence from its start date (or the day it was
    // recorded) until its stop date.
    const createdLocal = localDateStr(new Date(med.created_at.replace(" ", "T") + "Z"));
    const firstDay = med.start_date ?? createdLocal;
    const lastDay = med.status === "stopped" ? (med.end_date ?? windowEnd) : windowEnd;

    const counts = emptyCounts();
    for (const date of dates) {
      if (date < firstDay || date > lastDay) continue;
      for (const h of history) {
        if (h.is_prn === 1) continue;
        let times: string[];
        try {
          times = JSON.parse(h.schedule_times) as string[];
        } catch {
          continue;
        }
        for (const t of times) {
          const slotDt = `${date}T${t}`;
          if (slotDt < h.effective_from || (h.effective_to !== null && slotDt >= h.effective_to)) continue;
          const ev = bySlot.get(`${med.id}|${slotDt}`);
          if (ev) {
            counts[ev.status === "taken" ? "on_time" : ev.status === "late" ? "late" : "skipped"]++;
          } else {
            const [y, m, d] = date.split("-").map(Number);
            const [hh, mm] = t.split(":").map(Number);
            const slotMs = new Date(y, m - 1, d, hh, mm).getTime();
            counts[nowMs > slotMs + GRACE_MS ? "missed" : "future"]++;
          }
        }
      }
    }

    const unscheduled = unscheduledByMed.get(med.id) ?? 0;
    const { due, pct: medPct } = pct(counts);
    if (due === 0 && counts.future === 0 && unscheduled === 0) continue; // nothing to report for this med

    (Object.keys(counts) as SlotOutcome[]).forEach((k) => (overallCounts[k] += counts[k]));
    overallUnscheduled += unscheduled;
    per_med.push({
      medication_id: med.id,
      brand_name: med.brand_name,
      med_status: med.status,
      is_prn: med.is_prn === 1,
      counts,
      expected_due: due,
      adherence_pct: medPct,
      unscheduled_doses: unscheduled,
    });
  }

  per_med.sort((a, b) => (a.med_status === b.med_status ? a.brand_name.localeCompare(b.brand_name) : a.med_status === "active" ? -1 : 1));

  const { due: overallDue, pct: overallPct } = pct(overallCounts);
  return {
    window_days: days,
    computed_at: now.toISOString(),
    formula: ADHERENCE_FORMULA,
    per_med,
    overall: { counts: overallCounts, expected_due: overallDue, adherence_pct: overallPct, unscheduled_doses: overallUnscheduled },
  };
}
