// Golden cases for the time-aware exposure engine: rolling totals must be
// exact, uncountable doses must be surfaced (never guessed), and the
// alert-overlap annotation must handle both med/ingredient orientations.

import { test } from "node:test";
import assert from "node:assert/strict";
import { annotateAlertsWithExposure, computeExposure } from "../src/lib/exposure";
import { recomputeAlerts } from "../src/lib/conflicts";
import { addMed, addProfile, freshDb, logDose } from "./helpers";

test("rolling 24h total sums tablet doses × strength", () => {
  const db = freshDb();
  const p = addProfile(db);
  const tylenol = addMed(db, p, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });
  logDose(db, tylenol, { hoursAgo: 2 });
  logDose(db, tylenol, { hoursAgo: 3, doseValue: 2 });

  const { report } = computeExposure(db, p);
  const acet = report.totals.find((t) => t.ingredient === "acetaminophen");
  assert.ok(acet);
  assert.equal(acet!.total_mg, 1500);
  assert.equal(acet!.max_daily_mg, 4000);
  assert.equal(acet!.over, false);
});

test("exceeding the OTC daily max flags over-limit", () => {
  const db = freshDb();
  const p = addProfile(db);
  const advil = addMed(db, p, { name: "ADVIL", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });
  for (let i = 0; i < 7; i++) logDose(db, advil, { hoursAgo: i + 1 });

  const { report } = computeExposure(db, p);
  const ibu = report.totals.find((t) => t.ingredient === "ibuprofen");
  assert.equal(ibu!.total_mg, 1400);
  assert.equal(ibu!.over, true);
});

test("doses older than 24h leave the rolling total; long-acting drugs stay active", () => {
  const db = freshDb();
  const p = addProfile(db);
  const tylenol = addMed(db, p, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });
  const warfarin = addMed(db, p, { name: "APO-WARFARIN", ingredients: [{ name: "WARFARIN SODIUM", strength: "1" }] });
  logDose(db, tylenol, { hoursAgo: 30 });
  logDose(db, warfarin, { hoursAgo: 30 });

  const { report } = computeExposure(db, p);
  assert.equal(report.totals.length, 0, "30h-old dose must not appear in 24h totals");
  const active = report.active_now.map((a) => a.ingredient);
  assert.ok(active.includes("warfarin"), "warfarin (48h window) must still be active at 30h");
  assert.ok(!active.includes("acetaminophen"), "acetaminophen (6h window) must be inactive at 30h");
});

test("mL doses are surfaced as uncounted, never guessed", () => {
  const db = freshDb();
  const p = addProfile(db);
  const nyquil = addMed(db, p, { name: "NYQUIL", ingredients: [{ name: "ACETAMINOPHEN", strength: "650" }] });
  logDose(db, nyquil, { hoursAgo: 1, doseValue: 30, doseUnit: "mL" });

  const { report } = computeExposure(db, p);
  const acet = report.totals.find((t) => t.ingredient === "acetaminophen");
  assert.equal(acet!.total_mg, 0);
  assert.equal(acet!.uncounted.length, 1);
  assert.match(acet!.uncounted[0].reason, /mL/);
});

test("mg doses of combination products are ambiguous → uncounted", () => {
  const db = freshDb();
  const p = addProfile(db);
  const combo = addMed(db, p, {
    name: "ADVIL FLU",
    ingredients: [
      { name: "IBUPROFEN", strength: "200" },
      { name: "DIPHENHYDRAMINE HYDROCHLORIDE", strength: "25" },
    ],
  });
  logDose(db, combo, { hoursAgo: 1, doseValue: 200, doseUnit: "mg" });

  const { report } = computeExposure(db, p);
  const ibu = report.totals.find((t) => t.ingredient === "ibuprofen");
  assert.equal(ibu!.total_mg, 0);
  assert.match(ibu!.uncounted[0].reason, /combination/i);
});

test("extended-release: totals still count, active window is NOT modeled", () => {
  const db = freshDb();
  const p = addProfile(db);
  const er = addMed(db, p, {
    name: "SOME IBUPROFEN 12 HOUR",
    extendedRelease: true,
    ingredients: [{ name: "IBUPROFEN", strength: "600" }],
  });
  logDose(db, er, { hoursAgo: 1 });

  const { report } = computeExposure(db, p);
  const ibu = report.totals.find((t) => t.ingredient === "ibuprofen");
  assert.equal(ibu!.total_mg, 600, "mg totals are release-independent");
  assert.equal(report.active_now.length, 0, "ER products must not get an estimated window");
});

test("REGRESSION: alert overlap annotation checks both med/ingredient orientations", () => {
  // Alert ingredient pairs sort alphabetically while med ids sort numerically,
  // so ingredient_a can belong to med_b. This shipped as a real bug once.
  const db = freshDb();
  const p = addProfile(db);
  const warfarin = addMed(db, p, { name: "APO-WARFARIN", ingredients: [{ name: "WARFARIN SODIUM", strength: "1" }] });
  const advil = addMed(db, p, { name: "ADVIL", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });
  logDose(db, warfarin, { hoursAgo: 1 });
  logDose(db, advil, { hoursAgo: 1 });

  const { all } = recomputeAlerts(db, p);
  annotateAlertsWithExposure(all, computeExposure(db, p));
  assert.equal(all[0].exposure_status, "overlap");
});

test("HONESTY: no recorded doses must read as insufficient_data, never as reassurance", () => {
  const db = freshDb();
  const p = addProfile(db);
  addMed(db, p, { name: "APO-WARFARIN", ingredients: [{ name: "WARFARIN SODIUM", strength: "1" }] });
  addMed(db, p, { name: "ADVIL", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });

  const { all } = recomputeAlerts(db, p);
  annotateAlertsWithExposure(all, computeExposure(db, p));
  assert.equal(all[0].exposure_status, "insufficient_data");
});

test("HONESTY: one dosed medication is still insufficient data for the pair", () => {
  const db = freshDb();
  const p = addProfile(db);
  const warfarin = addMed(db, p, { name: "APO-WARFARIN", ingredients: [{ name: "WARFARIN SODIUM", strength: "1" }] });
  addMed(db, p, { name: "ADVIL", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });
  logDose(db, warfarin, { hoursAgo: 1 });

  const { all } = recomputeAlerts(db, p);
  annotateAlertsWithExposure(all, computeExposure(db, p));
  assert.equal(all[0].exposure_status, "insufficient_data");
});

test("both meds dosed but windows apart → no_overlap (a real modelled result)", () => {
  const db = freshDb();
  const p = addProfile(db);
  const warfarin = addMed(db, p, { name: "APO-WARFARIN", ingredients: [{ name: "WARFARIN SODIUM", strength: "1" }] });
  const advil = addMed(db, p, { name: "ADVIL", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });
  // Both logged. Warfarin (48h window) is still active at 30h; ibuprofen
  // (8h window) is long inactive → modelled, dosed, and NOT overlapping.
  logDose(db, warfarin, { hoursAgo: 30 });
  logDose(db, advil, { hoursAgo: 30 });

  const { all } = recomputeAlerts(db, p);
  annotateAlertsWithExposure(all, computeExposure(db, p));
  assert.equal(all[0].exposure_status, "no_overlap");
});
