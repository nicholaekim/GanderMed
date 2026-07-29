// Golden cases for the time-aware exposure engine: rolling totals must be
// exact, uncountable doses must be surfaced (never guessed), and the
// alert-overlap annotation must handle both med/ingredient orientations.

import { test } from "node:test";
import assert from "node:assert/strict";
import { annotateAlertsWithExposure, computeExposure } from "../src/lib/exposure";
import { recomputeAlerts } from "../src/lib/conflicts";
import { INGREDIENT_PROFILES } from "../src/data/ingredientProfiles";
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
  assert.ok(active.includes("warfarin"), "warfarin (120h effect window) must still be active at 30h");
  assert.ok(!active.includes("acetaminophen"), "acetaminophen (13h washout) must be inactive at 30h");
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
  // Both logged. Warfarin (120h effect window) is still active at 30h;
  // ibuprofen (10h washout) is long inactive → modelled, dosed, NOT overlapping.
  logDose(db, warfarin, { hoursAgo: 30 });
  logDose(db, advil, { hoursAgo: 30 });

  const { all } = recomputeAlerts(db, p);
  annotateAlertsWithExposure(all, computeExposure(db, p));
  assert.equal(all[0].exposure_status, "no_overlap");
});

// ---- Half-life model (v2 profiles) ----

test("DATA INTEGRITY: every half_life-basis window equals round(5 × t½)", () => {
  for (const [name, p] of Object.entries(INGREDIENT_PROFILES)) {
    assert.ok(p.half_life_hours > 0, `${name}: half-life must be positive`);
    assert.ok(p.active_window_hours > 0, `${name}: window must be positive`);
    if (p.window_basis === "half_life") {
      assert.equal(
        p.active_window_hours,
        Math.round(5 * p.half_life_hours),
        `${name}: half_life-basis window must be the 5×t½ washout`
      );
    } else {
      assert.ok(p.note, `${name}: an effect_duration window must explain itself in the note`);
    }
  }
});

test("HALF-LIFE: naproxen (t½ ~14h) is still active 40h after a dose", () => {
  // Under the old fixed 12h window this dose would have read as cleared —
  // half-life washout modeling is what keeps multi-day NSAIDs visible.
  const db = freshDb();
  const p = addProfile(db);
  const aleve = addMed(db, p, { name: "ALEVE", ingredients: [{ name: "NAPROXEN SODIUM", strength: "220" }] });
  logDose(db, aleve, { hoursAgo: 40 });

  const { report } = computeExposure(db, p);
  const entry = report.active_now.find((a) => a.ingredient === "naproxen");
  assert.ok(entry, "naproxen must still be active at 40h (70h washout window)");
  assert.equal(entry!.window_basis, "half_life");
  assert.equal(entry!.half_life_hours, 14);
});

test("EFFECT DURATION: aspirin's antiplatelet window far outlasts its short half-life", () => {
  const db = freshDb();
  const p = addProfile(db);
  const asa = addMed(db, p, { name: "ASPIRIN", ingredients: [{ name: "ACETYLSALICYLIC ACID", strength: "325" }] });
  logDose(db, asa, { hoursAgo: 72 }); // salicylate itself cleared long ago

  const { report } = computeExposure(db, p);
  const entry = report.active_now.find((a) => a.ingredient === "aspirin");
  assert.ok(entry, "aspirin must still count as active 3 days post-dose (platelet effect)");
  assert.equal(entry!.window_basis, "effect_duration");
  assert.ok(
    entry!.half_life_hours! * 5 < 120,
    "the window is deliberately wider than 5×t½ — that's the point of effect_duration"
  );
});

test("HALF-LIFE OVERLAP: warfarin + naproxen dosed a day apart still overlap", () => {
  // The clinically dangerous case the old fixed windows missed: an NSAID
  // taken yesterday is still on board when today's warfarin dose lands.
  const db = freshDb();
  const p = addProfile(db);
  const warfarin = addMed(db, p, { name: "APO-WARFARIN", ingredients: [{ name: "WARFARIN SODIUM", strength: "1" }] });
  const aleve = addMed(db, p, { name: "ALEVE", ingredients: [{ name: "NAPROXEN SODIUM", strength: "220" }] });
  logDose(db, aleve, { hoursAgo: 30 });
  logDose(db, warfarin, { hoursAgo: 2 });

  const { all } = recomputeAlerts(db, p);
  annotateAlertsWithExposure(all, computeExposure(db, p));
  assert.equal(all[0].exposure_status, "overlap");
});

test("the lookback horizon always covers the longest profile window", () => {
  // A dose of the longest-window ingredient logged just inside its window
  // must still be found — the lookback is derived from the data, not a
  // hand-maintained constant.
  const longest = Math.max(...Object.values(INGREDIENT_PROFILES).map((x) => x.active_window_hours));
  const db = freshDb();
  const p = addProfile(db);
  const prozac = addMed(db, p, { name: "PROZAC", ingredients: [{ name: "FLUOXETINE HYDROCHLORIDE", strength: "20" }] });
  logDose(db, prozac, { hoursAgo: longest - 2 });

  const { report } = computeExposure(db, p);
  assert.ok(
    report.active_now.some((a) => a.ingredient === "fluoxetine"),
    `fluoxetine dosed ${longest - 2}h ago must still be inside its ${longest}h window`
  );
});
