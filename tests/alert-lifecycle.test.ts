// Phase 1 regression suite: alerts must track the CURRENT rule content.
// A rule regrade, rewording, or re-versioning is a material change — the
// alert row must update, the patient's acknowledgment must clear, and a
// clinician review tied to the old version must stop attaching.

import { test } from "node:test";
import assert from "node:assert/strict";
import { recomputeAlerts } from "../src/lib/conflicts";
import { attachReviews } from "../src/lib/reviews";
import { addMed, addProfile, freshDb } from "./helpers";
import type { DatabaseSync } from "node:sqlite";

function setupWarfarinIbuprofen(db: DatabaseSync, p: number) {
  addMed(db, p, { name: "APO-WARFARIN", ingredients: [{ name: "WARFARIN SODIUM", strength: "1" }] });
  addMed(db, p, { name: "ADVIL", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });
}

function mutateRule(db: DatabaseSync, changes: string) {
  db.exec(
    `UPDATE interaction_rules SET ${changes} WHERE ingredient_a = 'ibuprofen' AND ingredient_b = 'warfarin'`
  );
}

function ackAlert(db: DatabaseSync, alertId: number) {
  db.prepare("UPDATE alerts SET acknowledged_at = ? WHERE id = ?").run(new Date().toISOString(), alertId);
}

function addReviewFor(db: DatabaseSync, p: number, alert: ReturnType<typeof recomputeAlerts>["all"][number]) {
  const reviewer = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, password_salt, display_name, role, clinic_name)
       VALUES ('doc${Math.random().toString(36).slice(2, 8)}@t.local', 'x', 'x', 'Dr. T', 'clinician', 'Clinic')`
    ).run().lastInsertRowid
  );
  db.prepare(
    `INSERT INTO alert_reviews
     (profile_id, kind, ingredient_a, ingredient_b, med_a_id, med_b_id,
      reviewer_user_id, reviewer_name, reviewer_clinic, note, source_version, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Dr. T', 'Clinic', 'Reviewed and managed.', ?, ?)`
  ).run(
    p, alert.kind, alert.ingredient_a, alert.ingredient_b, alert.med_a_id, alert.med_b_id,
    reviewer, alert.source_version, new Date(Date.now() + 86_400_000).toISOString()
  );
}

test("1. a moderate→major regrade updates the existing alert in place", () => {
  const db = freshDb();
  const p = addProfile(db);
  setupWarfarinIbuprofen(db, p);
  const before = recomputeAlerts(db, p).all[0];
  assert.equal(before.severity, "major");

  mutateRule(db, "severity = 'moderate'");
  const after = recomputeAlerts(db, p).all[0];
  assert.equal(after.id, before.id, "same combination keeps the same row");
  assert.equal(after.severity, "moderate", "severity must track the current rule");
});

test("2. a ruleset-version change updates the alert's source_version", () => {
  const db = freshDb();
  const p = addProfile(db);
  setupWarfarinIbuprofen(db, p);
  recomputeAlerts(db, p);

  mutateRule(db, "source_version = 'demo-9.9.9'");
  const after = recomputeAlerts(db, p).all[0];
  assert.equal(after.source_version, "demo-9.9.9");
});

test("3. a material rule change clears the patient's acknowledgment and re-counts as new", () => {
  const db = freshDb();
  const p = addProfile(db);
  setupWarfarinIbuprofen(db, p);
  const first = recomputeAlerts(db, p).all[0];
  ackAlert(db, first.id);

  mutateRule(db, "mechanism = 'Updated wording with stronger evidence.'");
  const { created, all } = recomputeAlerts(db, p);
  assert.equal(all[0].acknowledged_at, null, "acknowledgment must clear on material change");
  assert.equal(created.length, 1, "a materially changed alert counts as newly flagged");
  assert.equal(created[0].id, first.id);
});

test("4. a clinician review tied to the old rule version stops attaching", () => {
  const db = freshDb();
  const p = addProfile(db);
  setupWarfarinIbuprofen(db, p);
  const alert = recomputeAlerts(db, p).all[0];
  addReviewFor(db, p, alert);

  const attached = attachReviews(db, p, recomputeAlerts(db, p).all);
  assert.ok(attached[0].review, "review attaches while versions match");

  mutateRule(db, "source_version = 'demo-9.9.9'");
  const after = attachReviews(db, p, recomputeAlerts(db, p).all);
  assert.equal(after[0].source_version, "demo-9.9.9");
  assert.equal(after[0].review, null, "old-version review must NOT attach to the updated alert");
});

test("5. a non-material recompute preserves acknowledgment and review", () => {
  const db = freshDb();
  const p = addProfile(db);
  setupWarfarinIbuprofen(db, p);
  const alert = recomputeAlerts(db, p).all[0];
  ackAlert(db, alert.id);
  addReviewFor(db, p, alert);

  const again = attachReviews(db, p, recomputeAlerts(db, p).all);
  assert.equal(again[0].id, alert.id);
  assert.ok(again[0].acknowledged_at, "unchanged alert keeps acknowledgment");
  assert.ok(again[0].review, "unchanged alert keeps its review");
  assert.equal(recomputeAlerts(db, p).created.length, 0, "no phantom new alerts");
});

test("6. removing or stopping a medication still removes stale alerts", () => {
  const db = freshDb();
  const p = addProfile(db);
  addMed(db, p, { name: "APO-WARFARIN", ingredients: [{ name: "WARFARIN SODIUM", strength: "1" }] });
  const advil = addMed(db, p, { name: "ADVIL", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });
  assert.equal(recomputeAlerts(db, p).all.length, 1);

  db.prepare("UPDATE medications SET status = 'stopped' WHERE id = ?").run(advil);
  assert.equal(recomputeAlerts(db, p).all.length, 0, "stopping removes the alert");

  db.prepare("UPDATE medications SET status = 'active' WHERE id = ?").run(advil);
  assert.equal(recomputeAlerts(db, p).all.length, 1);
  db.prepare("DELETE FROM medications WHERE id = ?").run(advil);
  assert.equal(recomputeAlerts(db, p).all.length, 0, "deleting removes the alert");
});

test("7. a different product with the same ingredient pair needs a fresh review", () => {
  const db = freshDb();
  const p = addProfile(db);
  addMed(db, p, { name: "APO-WARFARIN", ingredients: [{ name: "WARFARIN SODIUM", strength: "1" }] });
  const advil = addMed(db, p, { name: "ADVIL", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });
  const alert = recomputeAlerts(db, p).all[0];
  addReviewFor(db, p, alert);
  assert.ok(attachReviews(db, p, recomputeAlerts(db, p).all)[0].review);

  // Swap the ibuprofen product: same ingredient pair, different medication.
  db.prepare("DELETE FROM medications WHERE id = ?").run(advil);
  addMed(db, p, { name: "MOTRIN", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });

  const after = attachReviews(db, p, recomputeAlerts(db, p).all);
  assert.equal(after.length, 1);
  assert.equal(after[0].review, null, "review was for the old product pair — must not attach");
});
