// Phase 8: the adherence test matrix. Slots are deterministic functions of
// (schedule history × dates × now), so every case pins `now` to noon local
// and builds schedules around it — results never depend on when the suite
// runs. The golden rules: missed only exists for scheduled meds, PRN is
// never missed, and "no data" is null — never 0%.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAdherence, localDateStr, localDateTimeStr, recordScheduleChange } from "../src/lib/adherence";
import { GET as getAdherence } from "../src/app/api/adherence/route";
import { POST as postMedication } from "../src/app/api/medications/route";
import { PATCH as patchMedication } from "../src/app/api/medications/[id]/route";
import { addMed, addProfile, createUserSession, freshDb, jsonRequest, useTestDb } from "./helpers";
import type { DatabaseSync } from "node:sqlite";

const idCtx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

/** Noon today, local — every slot before ~11:00 is due, evening slots are future. */
function noonToday(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate(), 12, 0);
}

function daysAgoStr(now: Date, days: number): string {
  return localDateStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days));
}

/** A scheduled med created directly (helpers bypass routes → engine synthesizes history). */
function scheduledMed(db: DatabaseSync, profileId: number, times: string[], opts: { startDaysAgo?: number } = {}): number {
  const medId = addMed(db, profileId, { name: "TYLENOL", prn: false, ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });
  const now = noonToday();
  db.prepare("UPDATE medications SET schedule_times = ?, start_date = ? WHERE id = ?").run(
    JSON.stringify(times),
    daysAgoStr(now, opts.startDaysAgo ?? 30),
    medId
  );
  return medId;
}

/** Logs an event against an exact slot, the way the API stores it. */
function logSlot(
  db: DatabaseSync,
  medId: number,
  scheduledAt: string,
  status: "taken" | "late" | "skipped",
  loggedAt?: string
): void {
  db.prepare(
    `INSERT INTO dose_events (medication_id, scheduled_at, logged_at, status, dose_value, dose_unit)
     VALUES (?, ?, ?, ?, 1, 'tablet(s)')`
  ).run(medId, scheduledAt, loggedAt ?? new Date().toISOString(), status);
}

test("NO DATA ≠ 0%: no scheduled meds → null; due slots with no logs → a real 0%", () => {
  const db = freshDb();
  const now = noonToday();

  // Profile with only a PRN med: nothing is ever expected.
  const prnOnly = addProfile(db);
  addMed(db, prnOnly, { name: "ADVIL", prn: true, ingredients: [{ name: "IBUPROFEN", strength: "200" }] });
  const a = computeAdherence(db, prnOnly, 14, now);
  assert.equal(a.overall.adherence_pct, null, "no expected doses → null, never 0");

  // Profile with a scheduled med and zero logs: those are real missed doses.
  const withSched = addProfile(db);
  scheduledMed(db, withSched, ["08:00"]);
  const b = computeAdherence(db, withSched, 3, now);
  assert.equal(b.overall.counts.missed, 3, "one 08:00 slot per day, all missed by noon");
  assert.equal(b.overall.adherence_pct, 0, "all-missed is honestly 0%, not hidden");
});

test("on-time, late, and skipped land in the right buckets; late still counts as taken", () => {
  const db = freshDb();
  const now = noonToday();
  const p = addProfile(db);
  const med = scheduledMed(db, p, ["08:00"]);

  logSlot(db, med, `${daysAgoStr(now, 3)}T08:00`, "taken");
  logSlot(db, med, `${daysAgoStr(now, 2)}T08:00`, "late");
  logSlot(db, med, `${daysAgoStr(now, 1)}T08:00`, "skipped");
  // today's 08:00 left unlogged → missed by noon

  const a = computeAdherence(db, p, 4, now);
  assert.deepEqual(a.overall.counts, { on_time: 1, late: 1, skipped: 1, missed: 1, future: 0 });
  assert.equal(a.overall.adherence_pct, 50, "(1 on-time + 1 late) / 4 due");
});

test("FUTURE: slots not yet an hour past are excluded from the denominator", () => {
  const db = freshDb();
  const now = noonToday(); // 12:00
  const p = addProfile(db);
  scheduledMed(db, p, ["11:30", "20:00"]); // 11:30 is within grace, 20:00 is tonight

  const a = computeAdherence(db, p, 1, now);
  assert.equal(a.overall.counts.future, 2, "neither slot is judged yet");
  assert.equal(a.overall.expected_due, 0);
  assert.equal(a.overall.adherence_pct, null, "nothing due today yet → no data, not 0%");
});

test("PRN is never missed; its doses count as as-needed, as do unscheduled extras", () => {
  const db = freshDb();
  const now = noonToday();
  const p = addProfile(db);
  const prn = addMed(db, p, { name: "ADVIL", prn: true, ingredients: [{ name: "IBUPROFEN", strength: "200" }] });
  db.prepare(
    `INSERT INTO dose_events (medication_id, scheduled_at, logged_at, status, dose_value, dose_unit)
     VALUES (?, NULL, ?, 'taken', 1, 'tablet(s)')`
  ).run(prn, new Date(now.getTime() - 3_600_000).toISOString());

  const a = computeAdherence(db, p, 14, now);
  const med = a.per_med.find((m) => m.medication_id === prn)!;
  assert.equal(med.counts.missed, 0);
  assert.equal(med.expected_due, 0);
  assert.equal(med.unscheduled_doses, 1);
  assert.equal(a.overall.adherence_pct, null);
});

test("rogue duplicate logs for one slot count once — the latest log wins, matching the API", () => {
  const db = freshDb();
  const now = noonToday();
  const p = addProfile(db);
  const med = scheduledMed(db, p, ["08:00"]);
  const slot = `${daysAgoStr(now, 1)}T08:00`;

  logSlot(db, med, slot, "skipped", new Date(now.getTime() - 30 * 3_600_000).toISOString());
  logSlot(db, med, slot, "taken", new Date(now.getTime() - 20 * 3_600_000).toISOString());

  const a = computeAdherence(db, p, 2, now);
  assert.equal(a.overall.counts.on_time + a.overall.counts.skipped + a.overall.counts.missed, 2, "2 days × 1 slot");
  assert.equal(a.overall.counts.on_time, 1, "the later 'taken' supersedes the earlier 'skipped'");
  assert.equal(a.overall.counts.skipped, 0);
});

test("START CLAMP: no slots before the med existed; STOP CLAMP: none after end_date", () => {
  const db = freshDb();
  const now = noonToday();
  const p = addProfile(db);

  const started = scheduledMed(db, p, ["08:00"], { startDaysAgo: 1 }); // started yesterday
  const stopped = scheduledMed(db, p, ["09:00"]);
  db.prepare("UPDATE medications SET status = 'stopped', end_date = ? WHERE id = ?").run(daysAgoStr(now, 5), stopped);

  const a = computeAdherence(db, p, 14, now);
  const startedMed = a.per_med.find((m) => m.medication_id === started)!;
  assert.equal(startedMed.counts.missed, 2, "yesterday + today only — nothing before start_date");

  const stoppedMed = a.per_med.find((m) => m.medication_id === stopped)!;
  const stoppedTotal = stoppedMed.counts.missed + stoppedMed.counts.future;
  assert.equal(stoppedTotal, 9, "14-day window clipped at end_date 5 days ago: days -13..-5");
});

test("MID-WINDOW SCHEDULE CHANGE: each date is judged by the schedule in effect then", async () => {
  const db = useTestDb();
  const { cookie, profileId } = createUserSession(db, "patient");
  const now = noonToday();

  // Create via the real route so the initial history row exists.
  const created = await postMedication(
    jsonRequest("/api/medications", {
      method: "POST",
      cookie,
      body: { manual_name: "my vitamin", is_prn: false, schedule_times: ["08:00"], start_date: daysAgoStr(now, 6) },
    })
  );
  assert.equal(created.status, 200);
  const medId = ((await created.json()).medication as { id: number }).id;

  // Two days ago (at noon), the schedule moved from 08:00 to 21:00.
  const changeAt = `${daysAgoStr(now, 2)}T12:00`;
  db.prepare("UPDATE medication_schedule_history SET effective_to = ? WHERE medication_id = ? AND effective_to IS NULL").run(
    changeAt,
    medId
  );
  db.prepare(
    `INSERT INTO medication_schedule_history (medication_id, is_prn, schedule_times, effective_from)
     VALUES (?, 0, '["21:00"]', ?)`
  ).run(medId, changeAt);
  db.prepare("UPDATE medications SET schedule_times = '[\"21:00\"]' WHERE id = ?").run(medId);

  const a = computeAdherence(db, profileId!, 7, now);
  const med = a.per_med.find((m) => m.medication_id === medId)!;
  // Days -6..-3: 08:00 slots (old schedule) = 4 missed.
  // Change day (-2): 08:00 was before the noon change (old schedule owns it) = 1 missed; 21:00 ≥ change belongs to new = 1 missed.
  // Day -1: 21:00 missed. Today: 21:00 future.
  assert.equal(med.counts.missed, 7, "4 old + change-day 08:00 AND 21:00 + yesterday 21:00");
  assert.equal(med.counts.future, 1, "tonight's 21:00 not yet due");
});

test("PATCH schedule edits write history so past days keep their old schedule", async () => {
  const db = useTestDb();
  const { cookie, profileId } = createUserSession(db, "patient");
  const now = noonToday();

  const created = await postMedication(
    jsonRequest("/api/medications", {
      method: "POST",
      cookie,
      body: { manual_name: "bp pill", is_prn: false, schedule_times: ["08:00"], start_date: daysAgoStr(now, 3) },
    })
  );
  const medId = ((await created.json()).medication as { id: number }).id;

  const res = await patchMedication(
    jsonRequest(`/api/medications/${medId}`, { method: "PATCH", cookie, body: { schedule_times: ["09:30"] } }),
    idCtx(medId)
  );
  assert.equal(res.status, 200);

  const rows = db
    .prepare("SELECT schedule_times, effective_to FROM medication_schedule_history WHERE medication_id = ? ORDER BY id")
    .all(medId) as { schedule_times: string; effective_to: string | null }[];
  assert.equal(rows.length, 2, "old row closed + new row opened");
  assert.equal(rows[0].schedule_times, '["08:00"]');
  assert.ok(rows[0].effective_to, "old schedule closed at the edit time");
  assert.equal(rows[1].schedule_times, '["09:30"]');
  assert.equal(rows[1].effective_to, null);

  // The PATCH stamped the real wall-clock; pin the boundary to midnight so
  // the slot arithmetic is deterministic no matter when the suite runs.
  const boundary = `${localDateStr(now)}T00:01`;
  db.prepare("UPDATE medication_schedule_history SET effective_to = ? WHERE medication_id = ? AND effective_to IS NOT NULL").run(boundary, medId);
  db.prepare("UPDATE medication_schedule_history SET effective_from = ? WHERE medication_id = ? AND effective_to IS NULL").run(boundary, medId);

  // Judged at 10:00: three past days expect 08:00 (the old schedule); today
  // expects only 09:30 (new schedule), which is still inside its grace hour.
  const tenAm = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0);
  const a = computeAdherence(db, profileId!, 4, tenAm);
  const med = a.per_med.find((m) => m.medication_id === medId)!;
  assert.equal(med.counts.missed, 3, "three past 08:00 slots under the old schedule");
  assert.equal(med.counts.future, 1, "today's 09:30 under the new schedule, not yet due");
});

test("DST-safe date iteration: every date in the window yields exactly one slot per time", () => {
  const db = freshDb();
  const now = noonToday();
  const p = addProfile(db);
  scheduledMed(db, p, ["02:30"], { startDaysAgo: 400 }); // 02:30 sits inside the DST jump when one occurs

  // 370 days covers at least one spring-forward and one fall-back in DST zones.
  const a = computeAdherence(db, p, 370, now);
  const med = a.per_med[0];
  const total = med.counts.on_time + med.counts.late + med.counts.skipped + med.counts.missed + med.counts.future;
  assert.equal(total, 370, "one slot per calendar day — DST shifts the clock, never the slot count");
});

test("a late log AFTER a slot looked missed converts it — adherence self-corrects", () => {
  const db = freshDb();
  const now = noonToday();
  const p = addProfile(db);
  const med = scheduledMed(db, p, ["08:00"]);
  const slot = `${localDateStr(now)}T08:00`;

  assert.equal(computeAdherence(db, p, 1, now).overall.counts.missed, 1, "unlogged at noon → missed");
  logSlot(db, med, slot, "late");
  const after = computeAdherence(db, p, 1, now);
  assert.equal(after.overall.counts.missed, 0);
  assert.equal(after.overall.counts.late, 1);
  assert.equal(after.overall.adherence_pct, 100, "late is still taken");
});

test("recordScheduleChange is self-healing for meds with no history rows", () => {
  const db = freshDb();
  const p = addProfile(db);
  const med = scheduledMed(db, p, ["08:00"]);

  recordScheduleChange(db, med, { is_prn: 0, schedule_times: '["08:00"]' }, { is_prn: 0, schedule_times: '["10:00"]' }, localDateTimeStr(noonToday()));
  const rows = db
    .prepare("SELECT effective_from, effective_to FROM medication_schedule_history WHERE medication_id = ? ORDER BY id")
    .all(med) as { effective_from: string; effective_to: string | null }[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].effective_from, "1970-01-01T00:00", "pre-change schedule backfilled as since-forever");
});

test("ROUTE: patients read their own adherence; clinicians need an active grant", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  scheduledMed(db, patient.profileId!, ["08:00"]);

  const own = await getAdherence(jsonRequest("/api/adherence?days=14", { cookie: patient.cookie }));
  assert.equal(own.status, 200);
  assert.ok((await own.json()).adherence.formula, "the formula ships with the data");

  const denied = await getAdherence(
    jsonRequest(`/api/adherence?patient=${patient.profileId}&days=14`, { cookie: clin.cookie })
  );
  assert.equal(denied.status, 403, "no grant, no adherence data");
});
