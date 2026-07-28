// Golden cases for the conflict engine: the alerts that MUST fire, the
// entries that MUST be excluded, and the acknowledgment/review lifecycle.

import { test } from "node:test";
import assert from "node:assert/strict";
import { recomputeAlerts } from "../src/lib/conflicts";
import { attachReviews } from "../src/lib/reviews";
import { addMed, addProfile, freshDb } from "./helpers";

test("warfarin + ibuprofen produces exactly one MAJOR interaction alert", () => {
  const db = freshDb();
  const p = addProfile(db);
  addMed(db, p, { name: "APO-WARFARIN", ingredients: [{ name: "WARFARIN SODIUM", strength: "1" }] });
  addMed(db, p, { name: "ADVIL", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });

  const { all } = recomputeAlerts(db, p);
  assert.equal(all.length, 1);
  assert.equal(all[0].kind, "interaction");
  assert.equal(all[0].severity, "major");
  assert.deepEqual([all[0].ingredient_a, all[0].ingredient_b], ["ibuprofen", "warfarin"]);
  assert.match(all[0].recommended_action, /pharmacist/i);
});

test("two products sharing ibuprofen produce a duplicate alert, not an interaction", () => {
  const db = freshDb();
  const p = addProfile(db);
  addMed(db, p, { name: "ADVIL", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });
  addMed(db, p, { name: "MOTRIN", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });

  const { all } = recomputeAlerts(db, p);
  assert.equal(all.length, 1);
  assert.equal(all[0].kind, "duplicate");
  assert.equal(all[0].severity, "moderate");
});

test("duplicate acetaminophen is MAJOR (overdose danger list)", () => {
  const db = freshDb();
  const p = addProfile(db);
  addMed(db, p, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });
  addMed(db, p, { name: "NYQUIL", ingredients: [{ name: "ACETAMINOPHEN", strength: "650" }] });

  const { all } = recomputeAlerts(db, p);
  assert.equal(all[0].kind, "duplicate");
  assert.equal(all[0].severity, "major");
});

test("levothyroxine + calcium carbonate fires with dose-separation advice", () => {
  const db = freshDb();
  const p = addProfile(db);
  addMed(db, p, { name: "SYNTHROID", ingredients: [{ name: "LEVOTHYROXINE SODIUM", strength: "112", unit: "MCG" }] });
  addMed(db, p, { name: "TUMS", ingredients: [{ name: "CALCIUM CARBONATE", strength: "750" }] });

  const { all } = recomputeAlerts(db, p);
  assert.equal(all.length, 1);
  assert.equal(all[0].severity, "moderate");
  assert.match(all[0].recommended_action, /4 hours apart/i);
});

test("unverified (manual) medications are excluded from checking", () => {
  const db = freshDb();
  const p = addProfile(db);
  addMed(db, p, { name: "APO-WARFARIN", ingredients: [{ name: "WARFARIN SODIUM", strength: "1" }] });
  addMed(db, p, { name: "my ibuprofen", verified: false, ingredients: [{ name: "IBUPROFEN", strength: "200" }] });

  assert.equal(recomputeAlerts(db, p).all.length, 0);
});

test("stopped medications are excluded from checking", () => {
  const db = freshDb();
  const p = addProfile(db);
  addMed(db, p, { name: "APO-WARFARIN", ingredients: [{ name: "WARFARIN SODIUM", strength: "1" }] });
  addMed(db, p, { name: "ADVIL", status: "stopped", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });

  assert.equal(recomputeAlerts(db, p).all.length, 0);
});

test("acknowledgment survives recomputes; alert disappears when the med is removed", () => {
  const db = freshDb();
  const p = addProfile(db);
  addMed(db, p, { name: "APO-WARFARIN", ingredients: [{ name: "WARFARIN SODIUM", strength: "1" }] });
  const advil = addMed(db, p, { name: "ADVIL", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });

  const first = recomputeAlerts(db, p).all[0];
  db.prepare("UPDATE alerts SET acknowledged_at = ? WHERE id = ?").run(new Date().toISOString(), first.id);

  const again = recomputeAlerts(db, p).all;
  assert.equal(again.length, 1);
  assert.equal(again[0].id, first.id);
  assert.ok(again[0].acknowledged_at, "acknowledgment must survive recompute");

  db.prepare("DELETE FROM medications WHERE id = ?").run(advil);
  assert.equal(recomputeAlerts(db, p).all.length, 0, "stale alerts must be removed");
});

test("clinician reviews attach by combination identity and detach on ruleset change", () => {
  const db = freshDb();
  const p = addProfile(db);
  addMed(db, p, { name: "APO-WARFARIN", ingredients: [{ name: "WARFARIN SODIUM", strength: "1" }] });
  addMed(db, p, { name: "ADVIL", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });

  const reviewer = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, password_salt, display_name, role, clinic_name)
       VALUES ('doc@test.local', 'x', 'x', 'Dr. Test', 'clinician', 'Test Clinic')`
    ).run().lastInsertRowid
  );

  const alert = recomputeAlerts(db, p).all[0];
  db.prepare(
    `INSERT INTO alert_reviews
     (profile_id, kind, ingredient_a, ingredient_b, med_a_id, med_b_id,
      reviewer_user_id, reviewer_name, reviewer_clinic, note, source_version, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Dr. Test', 'Test Clinic', 'Intentional, monitored.', ?, ?)`
  ).run(
    p, alert.kind, alert.ingredient_a, alert.ingredient_b, alert.med_a_id, alert.med_b_id,
    reviewer, alert.source_version, new Date(Date.now() + 86_400_000).toISOString()
  );

  const withReview = attachReviews(db, p, recomputeAlerts(db, p).all);
  assert.ok(withReview[0].review, "matching review must attach");
  assert.equal(withReview[0].review!.reviewer_name, "Dr. Test");

  // A ruleset version bump means the review no longer applies — must re-alert.
  db.prepare("UPDATE alert_reviews SET source_version = 'obsolete-0.0'").run();
  const afterBump = attachReviews(db, p, recomputeAlerts(db, p).all);
  assert.equal(afterBump[0].review, null, "stale-version review must NOT attach");
});
