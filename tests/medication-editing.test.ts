// Phase 7: medication editing + provenance. The safety properties under
// test: verified product identity is immutable (switching products is an
// explicit, history-retaining Replace), dose/schedule edits stamp the row so
// attached clinician reviews warn "dose changed since this review", and the
// Replace action breaks review identity so the pair re-alerts.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __setDpdFetchForTests } from "../src/lib/dpd";
import { recomputeAlerts } from "../src/lib/conflicts";
import { attachReviews } from "../src/lib/reviews";
import { POST as postMedication } from "../src/app/api/medications/route";
import { PATCH as patchMedication } from "../src/app/api/medications/[id]/route";
import { POST as replaceMedication } from "../src/app/api/medications/[id]/replace/route";
import { addMed, createUserSession, jsonRequest, logDose, useTestDb } from "./helpers";
import type { DatabaseSync } from "node:sqlite";
import type { Alert, Medication } from "../src/lib/types";

afterEach(() => __setDpdFetchForTests(null));

const idCtx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

function mockDpdProduct(opts: { brand?: string; din?: string; ingredient?: string; strength?: string; status?: string } = {}) {
  const {
    brand = "ALEVE",
    din = "07654321",
    ingredient = "NAPROXEN SODIUM",
    strength = "220",
    status = "Marketed",
  } = opts;
  __setDpdFetchForTests(async <T,>(path: string): Promise<T[]> => {
    if (path.startsWith("drugproduct/")) {
      return [
        {
          drug_code: 888,
          class_name: "Human",
          drug_identification_number: din,
          brand_name: brand,
          descriptor: "",
          number_of_ais: "1",
          company_name: "REPLACEMENT CO",
          last_update_date: "2026-01-01",
        },
      ] as T[];
    }
    if (path.startsWith("activeingredient/")) {
      return [{ ingredient_name: ingredient, strength, strength_unit: "MG" }] as T[];
    }
    if (path.startsWith("route/")) return [{ route_of_administration_name: "Oral" }] as T[];
    if (path.startsWith("form/")) return [{ pharmaceutical_form_name: "Tablet" }] as T[];
    if (path.startsWith("status/")) return [{ status }] as T[];
    return [];
  });
}

function medRow(db: DatabaseSync, id: number): Medication {
  return db.prepare("SELECT * FROM medications WHERE id = ?").get(id) as unknown as Medication;
}

function addReview(db: DatabaseSync, profileId: number, alert: Alert): number {
  const reviewer = Number(
    db
      .prepare(
        `INSERT INTO users (email, password_hash, password_salt, display_name, role, clinic_name)
         VALUES ('doc${Math.random().toString(36).slice(2, 8)}@t.local', 'x', 'x', 'Dr. T', 'clinician', 'Clinic')`
      )
      .run().lastInsertRowid
  );
  return Number(
    db
      .prepare(
        `INSERT INTO alert_reviews
         (profile_id, kind, ingredient_a, ingredient_b, med_a_id, med_b_id,
          reviewer_user_id, reviewer_name, reviewer_clinic, note, source_version, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Dr. T', 'Clinic', 'Intentional and monitored.', ?, ?)`
      )
      .run(
        profileId,
        alert.kind,
        alert.ingredient_a,
        alert.ingredient_b,
        alert.med_a_id,
        alert.med_b_id,
        reviewer,
        alert.source_version,
        new Date(Date.now() + 30 * 86_400_000).toISOString()
      ).lastInsertRowid
  );
}

test("dose and schedule edits persist and stamp last_material_change_at", async () => {
  const db = useTestDb();
  const { cookie, profileId } = createUserSession(db, "patient");
  const medId = addMed(db, profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });

  const res = await patchMedication(
    jsonRequest(`/api/medications/${medId}`, {
      method: "PATCH",
      cookie,
      body: { dose_value: 2, dose_unit: "tablet(s)", is_prn: false, schedule_times: ["21:00", "09:00", "09:00"] },
    }),
    idCtx(medId)
  );
  assert.equal(res.status, 200);
  const row = medRow(db, medId);
  assert.equal(row.dose_value, 2);
  assert.equal(row.is_prn, 0);
  assert.equal(row.schedule_times, JSON.stringify(["09:00", "21:00"]), "times deduped and sorted");
  assert.ok(row.last_material_change_at, "material change stamped");
});

test("instruction/note-only edits are NOT material", async () => {
  const db = useTestDb();
  const { cookie, profileId } = createUserSession(db, "patient");
  const medId = addMed(db, profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });

  const res = await patchMedication(
    jsonRequest(`/api/medications/${medId}`, {
      method: "PATCH",
      cookie,
      body: { instructions: "take with food", patient_notes: "makes me drowsy", start_date: "2026-07-01" },
    }),
    idCtx(medId)
  );
  assert.equal(res.status, 200);
  assert.equal(medRow(db, medId).last_material_change_at, null);
});

test("re-sending the current dose values is not a material change", async () => {
  const db = useTestDb();
  const { cookie, profileId } = createUserSession(db, "patient");
  const medId = addMed(db, profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });
  const before = medRow(db, medId);

  const res = await patchMedication(
    jsonRequest(`/api/medications/${medId}`, {
      method: "PATCH",
      cookie,
      body: { dose_value: before.dose_value, dose_unit: before.dose_unit, is_prn: before.is_prn === 1 },
    }),
    idCtx(medId)
  );
  assert.equal(res.status, 200);
  assert.equal(medRow(db, medId).last_material_change_at, null, "no-op edits must not raise dose-changed warnings");
});

test("IMMUTABLE: product identity and server-owned fields are rejected", async () => {
  const db = useTestDb();
  const { cookie, profileId } = createUserSession(db, "patient");
  const medId = addMed(db, profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });

  for (const body of [
    { brand_name: "EVIL BRAND" },
    { din: "99999999" },
    { drug_code: 123 },
    { verified: 0 },
    { is_extended_release: 1 },
    { provenance: "pharmacy-confirmed" },
    { replaced_by_id: 5 },
  ]) {
    const res = await patchMedication(
      jsonRequest(`/api/medications/${medId}`, { method: "PATCH", cookie, body }),
      idCtx(medId)
    );
    assert.equal(res.status, 400, `${Object.keys(body)[0]} must be rejected`);
  }
  const row = medRow(db, medId);
  assert.equal(row.brand_name, "TYLENOL");
  assert.equal(row.provenance, "patient-reported");
});

test("malformed schedule_times are rejected; PRN clears the schedule", async () => {
  const db = useTestDb();
  const { cookie, profileId } = createUserSession(db, "patient");
  const medId = addMed(db, profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });

  const bad = await patchMedication(
    jsonRequest(`/api/medications/${medId}`, { method: "PATCH", cookie, body: { is_prn: false, schedule_times: ["25:99"] } }),
    idCtx(medId)
  );
  assert.equal(bad.status, 400);

  const prn = await patchMedication(
    jsonRequest(`/api/medications/${medId}`, { method: "PATCH", cookie, body: { is_prn: true, schedule_times: ["08:00"] } }),
    idCtx(medId)
  );
  assert.equal(prn.status, 200);
  const row = medRow(db, medId);
  assert.equal(row.is_prn, 1);
  assert.equal(row.schedule_times, "[]", "PRN medications carry no schedule");
});

test("clinicians cannot edit or replace medications", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  const medId = addMed(db, patient.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });
  mockDpdProduct();

  const patch = await patchMedication(
    jsonRequest(`/api/medications/${medId}?patient=${patient.profileId}`, {
      method: "PATCH",
      cookie: clin.cookie,
      body: { dose_value: 99 },
    }),
    idCtx(medId)
  );
  assert.equal(patch.status, 403);

  const rep = await replaceMedication(
    jsonRequest(`/api/medications/${medId}/replace?patient=${patient.profileId}`, {
      method: "POST",
      cookie: clin.cookie,
      body: { drug_code: 888 },
    }),
    idCtx(medId)
  );
  assert.equal(rep.status, 403);
});

test("REPLACE: old row is stopped and retained with its dose history; new row is authoritative", async () => {
  const db = useTestDb();
  const { cookie, profileId } = createUserSession(db, "patient");
  const oldId = addMed(db, profileId!, { name: "ADVIL", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });
  db.prepare("UPDATE medications SET dose_value = 1, dose_unit = 'tablet(s)', instructions = 'with food' WHERE id = ?").run(oldId);
  logDose(db, oldId, { hoursAgo: 5 });
  mockDpdProduct();

  const res = await replaceMedication(
    jsonRequest(`/api/medications/${oldId}/replace`, { method: "POST", cookie, body: { drug_code: 888 } }),
    idCtx(oldId)
  );
  assert.equal(res.status, 200);
  const newMed = (await res.json()).medication as Medication;

  assert.equal(newMed.brand_name, "ALEVE", "identity comes from Health Canada, not the client");
  assert.equal(newMed.verified, 1);
  assert.equal(newMed.dose_value, 1, "usage settings inherited");
  assert.equal(newMed.instructions, "with food");
  assert.equal(newMed.provenance, "patient-reported");

  const old = medRow(db, oldId);
  assert.equal(old.status, "stopped");
  assert.ok(old.end_date, "stop date recorded");
  assert.equal(old.replaced_by_id, newMed.id, "supersession link recorded");
  const doses = db
    .prepare("SELECT COUNT(*) AS n FROM dose_events WHERE medication_id = ?")
    .get(oldId) as { n: number };
  assert.equal(doses.n, 1, "dose history stays on the retained old row");
});

test("REPLACE: an unmarketed replacement is refused and nothing changes", async () => {
  const db = useTestDb();
  const { cookie, profileId } = createUserSession(db, "patient");
  const oldId = addMed(db, profileId!, { name: "ADVIL", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });
  mockDpdProduct({ status: "Cancelled Post Market" });

  const res = await replaceMedication(
    jsonRequest(`/api/medications/${oldId}/replace`, { method: "POST", cookie, body: { drug_code: 888 } }),
    idCtx(oldId)
  );
  assert.equal(res.status, 422);
  assert.equal(medRow(db, oldId).status, "active", "old med untouched on failure");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM medications").get() as { n: number }).n, 1);
});

test("REPLACE: a med can only be replaced once", async () => {
  const db = useTestDb();
  const { cookie, profileId } = createUserSession(db, "patient");
  const oldId = addMed(db, profileId!, { name: "ADVIL", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });
  mockDpdProduct();

  const first = await replaceMedication(
    jsonRequest(`/api/medications/${oldId}/replace`, { method: "POST", cookie, body: { drug_code: 888 } }),
    idCtx(oldId)
  );
  assert.equal(first.status, 200);
  const second = await replaceMedication(
    jsonRequest(`/api/medications/${oldId}/replace`, { method: "POST", cookie, body: { drug_code: 888 } }),
    idCtx(oldId)
  );
  assert.equal(second.status, 409);
});

test("REVIEW FLAG: a dose change after a review attaches a dose_changed_at warning — review survives", async () => {
  const db = useTestDb();
  const { cookie, profileId } = createUserSession(db, "patient");
  const warfarin = addMed(db, profileId!, { name: "APO-WARFARIN", ingredients: [{ name: "WARFARIN SODIUM", strength: "1" }] });
  addMed(db, profileId!, { name: "ADVIL", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });

  const { all } = recomputeAlerts(db, profileId!);
  assert.ok(all.length > 0, "warfarin+ibuprofen must alert");
  const reviewId = addReview(db, profileId!, all[0]);
  db.prepare("UPDATE alert_reviews SET created_at = datetime('now','-1 hour') WHERE id = ?").run(reviewId);

  // Before any edit: attached, no warning.
  let alerts = attachReviews(db, profileId!, recomputeAlerts(db, profileId!).all);
  assert.ok(alerts[0].review, "review attaches");
  assert.equal(alerts[0].review!.dose_changed_at, null);

  const res = await patchMedication(
    jsonRequest(`/api/medications/${warfarin}`, { method: "PATCH", cookie, body: { dose_value: 2.5 } }),
    idCtx(warfarin)
  );
  assert.equal(res.status, 200);

  alerts = attachReviews(db, profileId!, recomputeAlerts(db, profileId!).all);
  assert.ok(alerts[0].review, "the review STAYS attached — product combination unchanged");
  assert.ok(alerts[0].review!.dose_changed_at, "but it now carries the dose-changed warning");
});

test("REVIEW RE-ALERT: replacing a product breaks review identity and the pair re-alerts", async () => {
  const db = useTestDb();
  const { cookie, profileId } = createUserSession(db, "patient");
  addMed(db, profileId!, { name: "APO-WARFARIN", ingredients: [{ name: "WARFARIN SODIUM", strength: "1" }] });
  const advil = addMed(db, profileId!, { name: "ADVIL", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });

  const { all } = recomputeAlerts(db, profileId!);
  addReview(db, profileId!, all[0]);
  assert.ok(attachReviews(db, profileId!, recomputeAlerts(db, profileId!).all)[0].review, "review attached pre-replace");

  mockDpdProduct(); // naproxen product — still an NSAID, pair still alerts
  const res = await replaceMedication(
    jsonRequest(`/api/medications/${advil}/replace`, { method: "POST", cookie, body: { drug_code: 888 } }),
    idCtx(advil)
  );
  assert.equal(res.status, 200);

  const after = attachReviews(db, profileId!, recomputeAlerts(db, profileId!).all);
  assert.ok(after.length > 0, "warfarin + replacement NSAID still alerts");
  assert.equal(after[0].review, null, "review does NOT carry over to the new product — re-alert by design");
});

test("PROVENANCE: new medications default to patient-reported", async () => {
  const db = useTestDb();
  const { cookie } = createUserSession(db, "patient");
  mockDpdProduct();

  const res = await postMedication(
    jsonRequest("/api/medications", { method: "POST", cookie, body: { drug_code: 888, is_prn: true, schedule_times: [] } })
  );
  assert.equal(res.status, 200);
  assert.equal(((await res.json()).medication as Medication).provenance, "patient-reported");
});
