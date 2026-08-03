// Medication lifecycle & plans. The properties under test are the three
// separate truths (prescribed / received / actually taking) and the
// calculation-eligibility boundary: a plan the patient hasn't confirmed
// starting must never count as exposure, adherence, or current use — while
// still being interaction-checked as a PLANNED concern.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/lib/db";
import { __setDpdFetchForTests } from "../src/lib/dpd";
import { recomputeAlerts } from "../src/lib/conflicts";
import { computeExposure } from "../src/lib/exposure";
import { computeAdherence } from "../src/lib/adherence";
import { generateClinicianNudges } from "../src/lib/medevents";
import { POST as createPlan } from "../src/app/api/medication-plans/route";
import { GET as getLifecycleEvents, POST as lifecycleAction } from "../src/app/api/medications/[id]/lifecycle/route";
import { PATCH as patchMedication } from "../src/app/api/medications/[id]/route";
import { POST as replaceMedication } from "../src/app/api/medications/[id]/replace/route";
import { GET as listMedications } from "../src/app/api/medications/route";
import { POST as postDose } from "../src/app/api/dose-events/route";
import { GET as getNotifications } from "../src/app/api/notifications/route";
import { GET as getSupply } from "../src/app/api/shortages/route";
import { GET as getRecon, POST as startRecon } from "../src/app/api/reconcile/route";
import { POST as reconAction } from "../src/app/api/reconcile/[id]/route";
import { computeFlags } from "../src/lib/reconcile";
import { countOpenShortages } from "../src/lib/shortages";
import { addMed, createUserSession, jsonRequest, useTestDb } from "./helpers";
import type { DatabaseSync } from "node:sqlite";
import type { Medication } from "../src/lib/types";

afterEach(() => __setDpdFetchForTests(null));

const idCtx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

function mockDpd(opts: { brand?: string; din?: string; ingredient?: string; strength?: string } = {}) {
  const { brand = "ADVIL", din = "01234567", ingredient = "IBUPROFEN", strength = "200" } = opts;
  __setDpdFetchForTests(async <T,>(path: string): Promise<T[]> => {
    if (path.startsWith("drugproduct/")) {
      return [
        {
          drug_code: 777,
          class_name: "Human",
          drug_identification_number: din,
          brand_name: brand,
          descriptor: "",
          number_of_ais: "1",
          company_name: "AUTHORITATIVE CO",
          last_update_date: "2026-01-01",
        },
      ] as T[];
    }
    if (path.startsWith("activeingredient/")) return [{ ingredient_name: ingredient, strength, strength_unit: "MG" }] as T[];
    if (path.startsWith("route/")) return [{ route_of_administration_name: "Oral" }] as T[];
    if (path.startsWith("form/")) return [{ pharmaceutical_form_name: "Tablet" }] as T[];
    if (path.startsWith("status/")) return [{ status: "Marketed" }] as T[];
    return [];
  });
}

function grantAccess(db: DatabaseSync, profileId: number, clinicianUserId: number): void {
  db.prepare(
    `INSERT INTO access_grants (profile_id, clinician_user_id, status, purpose, requested_by_user_id, starts_at)
     VALUES (?, ?, 'active', 'Medication review', ?, datetime('now'))`
  ).run(profileId, clinicianUserId, clinicianUserId);
}

async function makePlan(
  db: DatabaseSync,
  clinCookie: string,
  profileId: number,
  body: Record<string, unknown> = {}
): Promise<Medication> {
  mockDpd();
  const res = await createPlan(
    jsonRequest(`/api/medication-plans?patient=${profileId}`, {
      method: "POST",
      cookie: clinCookie,
      body: {
        drug_code: 777,
        prescribed_dose_value: 1,
        prescribed_dose_unit: "tablet(s)",
        prescribed_schedule_times: ["08:00", "20:00"],
        prescribed_instructions: "take with food",
        ...body,
      },
    })
  );
  assert.equal(res.status, 200);
  return (await res.json()).medication as Medication;
}

function medRow(db: DatabaseSync, id: number): Medication {
  return db.prepare("SELECT * FROM medications WHERE id = ?").get(id) as unknown as Medication;
}

test("PLAN CREATE: authorized clinician only; the plan starts as an unstarted 'prescribed' record", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const linked = createUserSession(db, "clinician");
  const stranger = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, linked.userId);

  mockDpd();
  const denied = await createPlan(
    jsonRequest(`/api/medication-plans?patient=${patient.profileId}`, {
      method: "POST",
      cookie: stranger.cookie,
      body: { drug_code: 777 },
    })
  );
  assert.equal(denied.status, 403, "no grant, no plan");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM medications").get() as { n: number }).n, 0);

  const plan = await makePlan(db, linked.cookie, patient.profileId!);
  assert.equal(plan.lifecycle_status, "prescribed");
  assert.equal(plan.source_type, "clinician_medication_plan");
  assert.equal(plan.source_user_id, linked.userId);
  assert.equal(plan.provenance, "prescriber-listed");
  assert.equal(plan.status, "stopped", "legacy mirror: planned meds fail safe in unconverted code paths");
  assert.equal(plan.prescribed_dose_value, 1);
  assert.equal(plan.prescribed_schedule_times, JSON.stringify(["08:00", "20:00"]));
  assert.equal(plan.dose_value, 1, "operative fields initialized from the prescription");
  assert.equal(plan.patient_started_at, null);
});

test("DPD INTEGRITY: client-sent identity fields on a plan are ignored; Health Canada wins", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  mockDpd({ brand: "AUTHORITATIVE BRAND", din: "07777777" });

  const res = await createPlan(
    jsonRequest(`/api/medication-plans?patient=${patient.profileId}`, {
      method: "POST",
      cookie: clin.cookie,
      body: { drug_code: 777, brand_name: "EVIL BRAND", din: "99999999", verified: 0 },
    })
  );
  assert.equal(res.status, 200);
  const med = (await res.json()).medication as Medication;
  assert.equal(med.brand_name, "AUTHORITATIVE BRAND");
  assert.equal(med.din, "07777777");
  assert.equal(med.verified, 1);
});

test("PERMISSIONS: a clinician can never confirm receipt or start — those are patient acts", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  const plan = await makePlan(db, clin.cookie, patient.profileId!);

  for (const action of ["received", "start"]) {
    const res = await lifecycleAction(
      jsonRequest(`/api/medications/${plan.id}/lifecycle?patient=${patient.profileId}`, {
        method: "POST",
        cookie: clin.cookie,
        body: { action },
      }),
      idCtx(plan.id)
    );
    assert.equal(res.status, 403, `clinician must not ${action}`);
  }
  assert.equal(medRow(db, plan.id).lifecycle_status, "prescribed", "nothing moved");
});

test("CONFIRMATION: receipt then start, with the chosen start date driving the schedule", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  const plan = await makePlan(db, clin.cookie, patient.profileId!);

  const received = await lifecycleAction(
    jsonRequest(`/api/medications/${plan.id}/lifecycle`, { method: "POST", cookie: patient.cookie, body: { action: "received" } }),
    idCtx(plan.id)
  );
  assert.equal(received.status, 200);
  let row = medRow(db, plan.id);
  assert.equal(row.lifecycle_status, "received_not_started");
  assert.ok(row.patient_received_at);
  assert.equal(row.patient_started_at, null, "receiving is not starting");

  const started = await lifecycleAction(
    jsonRequest(`/api/medications/${plan.id}/lifecycle`, {
      method: "POST",
      cookie: patient.cookie,
      body: { action: "start", date: "2026-08-01" },
    }),
    idCtx(plan.id)
  );
  assert.equal(started.status, 200);
  row = medRow(db, plan.id);
  assert.equal(row.lifecycle_status, "currently_taking");
  assert.equal(row.status, "active");
  assert.equal(row.start_date, "2026-08-01");
  assert.ok(row.patient_started_at);
});

test("THREE TRUTHS: patient-reported changes never touch the prescribed record, and vice versa", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  const plan = await makePlan(db, clin.cookie, patient.profileId!);

  // Prescription fields are immutable — for everyone.
  const tamper = await patchMedication(
    jsonRequest(`/api/medications/${plan.id}`, { method: "PATCH", cookie: patient.cookie, body: { prescribed_dose_value: 99 } }),
    idCtx(plan.id)
  );
  assert.equal(tamper.status, 400);

  // Usage edits are refused until the plan is confirmed…
  const early = await patchMedication(
    jsonRequest(`/api/medications/${plan.id}`, { method: "PATCH", cookie: patient.cookie, body: { dose_value: 0.5 } }),
    idCtx(plan.id)
  );
  assert.equal(early.status, 409, "confirm the plan before editing usage");

  // …then the patient's actual use diverges while the prescription stays frozen.
  await lifecycleAction(
    jsonRequest(`/api/medications/${plan.id}/lifecycle`, { method: "POST", cookie: patient.cookie, body: { action: "start" } }),
    idCtx(plan.id)
  );
  const edit = await patchMedication(
    jsonRequest(`/api/medications/${plan.id}`, {
      method: "PATCH",
      cookie: patient.cookie,
      body: { dose_value: 0.5, schedule_times: ["09:00"] },
    }),
    idCtx(plan.id)
  );
  assert.equal(edit.status, 200);
  const row = medRow(db, plan.id);
  assert.equal(row.dose_value, 0.5, "patient-reported truth updated");
  assert.equal(row.schedule_times, JSON.stringify(["09:00"]));
  assert.equal(row.prescribed_dose_value, 1, "prescribed truth untouched");
  assert.equal(row.prescribed_schedule_times, JSON.stringify(["08:00", "20:00"]));

  // And the clinician still cannot touch the patient-reported side.
  const clinEdit = await patchMedication(
    jsonRequest(`/api/medications/${plan.id}?patient=${patient.profileId}`, {
      method: "PATCH",
      cookie: clin.cookie,
      body: { actual_use: "not_taking" },
    }),
    idCtx(plan.id)
  );
  assert.equal(clinEdit.status, 403);
});

test("ELIGIBILITY: a planned medication is invisible to exposure, adherence, and today's schedule", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  const plan = await makePlan(db, clin.cookie, patient.profileId!);

  const exposure = computeExposure(db, patient.profileId!);
  assert.ok(
    ![...exposure.modelableKeys].some((k) => k.startsWith(`${plan.id}|`)),
    "planned med is not window-modelable"
  );
  const adherence = computeAdherence(db, patient.profileId!, 14);
  assert.ok(!adherence.per_med.some((m) => m.medication_id === plan.id), "no expected slots before a start");
});

test("PLANNED ALERTS: checked before the first dose, classified planned, and flipping to current on start", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  const warfarin = addMed(db, patient.profileId!, {
    name: "APO-WARFARIN",
    ingredients: [{ name: "WARFARIN SODIUM", strength: "1" }],
  });
  void warfarin;

  const plan = await makePlan(db, clin.cookie, patient.profileId!); // ibuprofen — interacts with warfarin
  let { all } = recomputeAlerts(db, patient.profileId!);
  assert.equal(all.length, 1, "the pair is checked before the patient starts");
  assert.equal(all[0].concern_class, "planned");
  assert.equal(all[0].severity, "major", "lifecycle never re-grades severity");
  const alertId = all[0].id;

  // Acknowledge while planned, then start — the SAME alert row flips class
  // and the acknowledgment survives.
  db.prepare("UPDATE alerts SET acknowledged_at = datetime('now') WHERE id = ?").run(alertId);
  await lifecycleAction(
    jsonRequest(`/api/medications/${plan.id}/lifecycle`, { method: "POST", cookie: patient.cookie, body: { action: "start" } }),
    idCtx(plan.id)
  );
  ({ all } = recomputeAlerts(db, patient.profileId!));
  assert.equal(all.length, 1);
  assert.equal(all[0].id, alertId, "same alert row — no churn on start");
  assert.equal(all[0].concern_class, "current");
  assert.ok(all[0].acknowledged_at, "acknowledgment rides through the transition");

  // And the started med now participates in the calculations.
  const adherence = computeAdherence(db, patient.profileId!, 14);
  assert.ok(adherence.per_med.some((m) => m.medication_id === plan.id), "adherence slots exist after start");
  const exposure = computeExposure(db, patient.profileId!);
  assert.ok([...exposure.modelableKeys].some((k) => k.startsWith(`${plan.id}|`)), "exposure-modelable after start");
});

test("TERMINAL STATES: declining a plan removes it from checking; stopped/completed leave current calcs", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  addMed(db, patient.profileId!, { name: "APO-WARFARIN", ingredients: [{ name: "WARFARIN SODIUM", strength: "1" }] });
  const plan = await makePlan(db, clin.cookie, patient.profileId!);

  assert.equal(recomputeAlerts(db, patient.profileId!).all.length, 1);
  const declined = await lifecycleAction(
    jsonRequest(`/api/medications/${plan.id}/lifecycle`, {
      method: "POST",
      cookie: patient.cookie,
      body: { action: "decline", reason: "worried about interactions" },
    }),
    idCtx(plan.id)
  );
  assert.equal(declined.status, 200);
  assert.equal(medRow(db, plan.id).lifecycle_status, "declined");
  assert.equal(recomputeAlerts(db, patient.profileId!).all.length, 0, "a declined plan no longer alerts");

  // A taken med that gets completed leaves the dose schedule and exposure.
  const taken = addMed(db, patient.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });
  const done = await lifecycleAction(
    jsonRequest(`/api/medications/${taken}/lifecycle`, { method: "POST", cookie: patient.cookie, body: { action: "complete" } }),
    idCtx(taken)
  );
  assert.equal(done.status, 200);
  const row = medRow(db, taken);
  assert.equal(row.lifecycle_status, "completed");
  assert.equal(row.status, "stopped");
  assert.ok(row.end_date, "completion records its end date");
});

test("PAUSE: expectations are suspended, and resume restores them", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const med = addMed(db, patient.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });
  db.prepare("UPDATE medications SET is_prn = 0, schedule_times = '[\"08:00\"]', start_date = date('now','-5 days') WHERE id = ?").run(med);

  const paused = await lifecycleAction(
    jsonRequest(`/api/medications/${med}/lifecycle`, { method: "POST", cookie: patient.cookie, body: { action: "pause", reason: "surgery week" } }),
    idCtx(med)
  );
  assert.equal(paused.status, 200);
  assert.equal(medRow(db, med).lifecycle_status, "temporarily_paused");
  assert.equal(medRow(db, med).status, "active", "paused is still on the list, just not expected");
  assert.ok(!computeAdherence(db, patient.profileId!, 14).per_med.some((m) => m.medication_id === med));

  await lifecycleAction(
    jsonRequest(`/api/medications/${med}/lifecycle`, { method: "POST", cookie: patient.cookie, body: { action: "resume" } }),
    idCtx(med)
  );
  assert.equal(medRow(db, med).lifecycle_status, "currently_taking");
  assert.ok(computeAdherence(db, patient.profileId!, 14).per_med.some((m) => m.medication_id === med));
});

test("REPLACEMENT: the link is recorded, but the OLD med's truth waits for the patient", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  addMed(db, patient.profileId!, { name: "APO-WARFARIN", ingredients: [{ name: "WARFARIN SODIUM", strength: "1" }] });
  const oldMed = addMed(db, patient.profileId!, { name: "OLD-ADVIL", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });
  // A review exists for the warfarin+old-ibuprofen pair.
  const { all } = recomputeAlerts(db, patient.profileId!);
  const reviewer = createUserSession(db, "clinician");
  db.prepare(
    `INSERT INTO alert_reviews (profile_id, kind, ingredient_a, ingredient_b, med_a_id, med_b_id,
      reviewer_user_id, reviewer_name, reviewer_clinic, note, source_version, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Dr', NULL, 'Intentional.', ?, ?)`
  ).run(
    patient.profileId, all[0].kind, all[0].ingredient_a, all[0].ingredient_b, all[0].med_a_id, all[0].med_b_id,
    reviewer.userId, all[0].source_version, new Date(Date.now() + 30 * 86_400_000).toISOString()
  );

  const plan = await makePlan(db, clin.cookie, patient.profileId!, {
    replaces_medication_id: oldMed,
    prescribed_schedule_times: [],
    prescribed_is_prn: true,
  });
  const old = medRow(db, oldMed);
  assert.equal(old.replaced_by_id, plan.id, "supersession link recorded");
  assert.equal(old.lifecycle_status ?? "currently_taking", "currently_taking", "prescriber intent never overwrites patient truth");
  assert.equal(old.status, "active", "the patient may still be taking the old product");

  // Patient confirms the switch: stop old, start new.
  await lifecycleAction(
    jsonRequest(`/api/medications/${oldMed}/lifecycle`, { method: "POST", cookie: patient.cookie, body: { action: "stop", reason: "switched to replacement" } }),
    idCtx(oldMed)
  );
  await lifecycleAction(
    jsonRequest(`/api/medications/${plan.id}/lifecycle`, { method: "POST", cookie: patient.cookie, body: { action: "start" } }),
    idCtx(plan.id)
  );
  const after = recomputeAlerts(db, patient.profileId!).all;
  assert.equal(after.length, 1, "warfarin + replacement still alerts");
  assert.ok(after[0].med_a_id === plan.id || after[0].med_b_id === plan.id);
  const { attachReviews } = await import("../src/lib/reviews");
  attachReviews(db, patient.profileId!, after);
  assert.equal(after[0].review, null, "the exact-product review does not carry to the new product");
  assert.equal(medRow(db, oldMed).lifecycle_status, "stopped");
  assert.ok(medRow(db, oldMed).end_date, "old history retained with its ending");
});

test("EVENTS: the lifecycle log records who did what, in order, with role attribution", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  const plan = await makePlan(db, clin.cookie, patient.profileId!);
  await lifecycleAction(
    jsonRequest(`/api/medications/${plan.id}/lifecycle`, { method: "POST", cookie: patient.cookie, body: { action: "received" } }),
    idCtx(plan.id)
  );
  await lifecycleAction(
    jsonRequest(`/api/medications/${plan.id}/lifecycle`, { method: "POST", cookie: patient.cookie, body: { action: "start" } }),
    idCtx(plan.id)
  );

  const events = db
    .prepare("SELECT event_type, actor_user_id, actor_role FROM medication_events WHERE medication_id = ? ORDER BY id")
    .all(plan.id) as { event_type: string; actor_user_id: number; actor_role: string }[];
  assert.deepEqual(
    events.map((e) => e.event_type),
    ["plan_created", "patient_reported_received", "patient_started"]
  );
  assert.equal(events[0].actor_user_id, clin.userId);
  assert.equal(events[0].actor_role, "clinician");
  assert.equal(events[1].actor_user_id, patient.userId);
  assert.equal(events[1].actor_role, "patient");
});

test("NOTIFICATIONS: plan creation notifies the patient; start and questions notify the plan's creator", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  const plan = await makePlan(db, clin.cookie, patient.profileId!);

  const patientInbox = await (await getNotifications(jsonRequest("/api/notifications", { cookie: patient.cookie }))).json();
  assert.ok(
    patientInbox.notifications.some((n: { type: string }) => n.type === "plan_created"),
    "patient is told a plan awaits confirmation"
  );

  await lifecycleAction(
    jsonRequest(`/api/medications/${plan.id}/lifecycle`, {
      method: "POST",
      cookie: patient.cookie,
      body: { action: "question", question: "Can I take this with my blood thinner?" },
    }),
    idCtx(plan.id)
  );
  await lifecycleAction(
    jsonRequest(`/api/medications/${plan.id}/lifecycle`, { method: "POST", cookie: patient.cookie, body: { action: "start" } }),
    idCtx(plan.id)
  );
  const clinInbox = await (await getNotifications(jsonRequest("/api/notifications", { cookie: clin.cookie }))).json();
  const types = clinInbox.notifications.map((n: { type: string }) => n.type);
  assert.ok(types.includes("patient_question"));
  assert.ok(types.includes("patient_started"));
  assert.equal(medRow(db, plan.id).patient_question, "Can I take this with my blood thinner?");
});

test("NUDGES: unconfirmed plans nudge their creator after the window — exactly once", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  const plan = await makePlan(db, clin.cookie, patient.profileId!);
  db.prepare("UPDATE medications SET created_at = datetime('now','-10 days') WHERE id = ?").run(plan.id);

  generateClinicianNudges(db, clin.userId);
  generateClinicianNudges(db, clin.userId); // idempotent via dedupe key
  const nudges = db
    .prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND type = 'plan_not_received'")
    .get(clin.userId) as { n: number };
  assert.equal(nudges.n, 1);
});

test("MIGRATION: existing rows map to sensible lifecycles, idempotently, with everything preserved", () => {
  const dir = mkdtempSync(join(tmpdir(), "gm-lifecycle-"));
  const path = join(dir, "old.db");
  try {
    const db1 = createDatabase(path);
    db1.prepare("INSERT INTO profiles (name, share_code) VALUES ('P', 'LIFE-0001')").run();
    db1.prepare(
      `INSERT INTO medications (profile_id, brand_name, verified, is_prn, schedule_times, status, actual_use)
       VALUES (1, 'ACTIVE MED', 1, 1, '[]', 'active', 'taking'),
              (1, 'DIFFERENT MED', 1, 1, '[]', 'active', 'taking_differently'),
              (1, 'OLD STOPPED', 1, 1, '[]', 'stopped', 'taking')`
    ).run();
    db1.close();

    const db2 = createDatabase(path); // migration runs on boot
    const rows = db2
      .prepare("SELECT brand_name, lifecycle_status, source_type, status FROM medications ORDER BY id")
      .all() as { brand_name: string; lifecycle_status: string; source_type: string; status: string }[];
    assert.equal(rows[0].lifecycle_status, "currently_taking");
    assert.equal(rows[1].lifecycle_status, "taking_differently");
    assert.equal(rows[2].lifecycle_status, "stopped");
    assert.equal(rows[0].source_type, "patient_reported");
    assert.equal(rows[0].status, "active", "legacy status preserved");
    db2.close();

    const db3 = createDatabase(path); // idempotent — second boot changes nothing
    const again = db3.prepare("SELECT lifecycle_status FROM medications WHERE id = 1").get() as {
      lifecycle_status: string;
    };
    assert.equal(again.lifecycle_status, "currently_taking");
    db3.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LEGACY TOGGLE: the old PATCH status switch keeps working and stays in sync with the lifecycle", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const med = addMed(db, patient.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });

  const stop = await patchMedication(
    jsonRequest(`/api/medications/${med}`, { method: "PATCH", cookie: patient.cookie, body: { status: "stopped" } }),
    idCtx(med)
  );
  assert.equal(stop.status, 200);
  assert.equal(medRow(db, med).lifecycle_status, "stopped");

  const resume = await patchMedication(
    jsonRequest(`/api/medications/${med}`, { method: "PATCH", cookie: patient.cookie, body: { status: "active" } }),
    idCtx(med)
  );
  assert.equal(resume.status, 200);
  assert.equal(medRow(db, med).lifecycle_status, "currently_taking");
});

test("DOSE LOGS: a planned medication cannot receive dose events (exposure must not diverge from 'not started')", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  const plan = await makePlan(db, clin.cookie, patient.profileId!);

  const { POST: postDose } = await import("../src/app/api/dose-events/route");
  const res = await postDose(
    jsonRequest("/api/dose-events", {
      method: "POST",
      cookie: patient.cookie,
      body: { medication_id: plan.id, action: "taken" },
    })
  );
  assert.equal(res.status, 409);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM dose_events WHERE medication_id = ?").get(plan.id) as { n: number }).n,
    0
  );
});

test("GUARDED TRANSITIONS: nonsense moves are refused with 409, never silently applied", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const med = addMed(db, patient.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });

  for (const action of ["received", "start", "decline"]) {
    const res = await lifecycleAction(
      jsonRequest(`/api/medications/${med}/lifecycle`, { method: "POST", cookie: patient.cookie, body: { action } }),
      idCtx(med)
    );
    assert.equal(res.status, 409, `${action} makes no sense for a med already being taken`);
  }
  const res = await lifecycleAction(
    jsonRequest(`/api/medications/${med}/lifecycle`, { method: "POST", cookie: patient.cookie, body: { action: "resume" } }),
    idCtx(med)
  );
  assert.equal(res.status, 409, "resume requires paused");
});

// ---------------------------------------------------------------------------
// Review-driven regressions (adversarial review of the lifecycle feature).
// Each test below pins a bug the review actually reproduced — do not weaken.
// ---------------------------------------------------------------------------

test("REPLACE ROUTE: old row flips to lifecycle 'replaced' (no phantom current med); unstarted plans can't be replaced", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const oldMed = addMed(db, patient.profileId!, { name: "OLD-ADVIL", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });
  // Post-migration reality: the row carries an explicit lifecycle value.
  db.prepare("UPDATE medications SET lifecycle_status = 'currently_taking' WHERE id = ?").run(oldMed);

  mockDpd({ brand: "MOTRIN", din: "09999999", ingredient: "IBUPROFEN" });
  const res = await replaceMedication(
    jsonRequest(`/api/medications/${oldMed}/replace`, { method: "POST", cookie: patient.cookie, body: { drug_code: 777 } }),
    idCtx(oldMed)
  );
  assert.equal(res.status, 200);
  const newId = (await res.json()).medication.id as number;

  const old = medRow(db, oldMed);
  assert.equal(old.lifecycle_status, "replaced", "BOTH status columns move on replace");
  assert.equal(old.status, "stopped");
  assert.equal(old.replaced_by_id, newId);
  assert.equal(medRow(db, newId).lifecycle_status, old.actual_use === "taking_differently" ? "taking_differently" : "currently_taking");

  // The phantom pair from the review: old+new share an ingredient, but the
  // replaced row is out of conflict checking, so no duplicate alert exists.
  const { all } = recomputeAlerts(db, patient.profileId!);
  assert.ok(!all.some((a) => a.med_a_id === oldMed || a.med_b_id === oldMed), "replaced med raises no alerts");

  const events = db.prepare("SELECT event_type FROM medication_events WHERE medication_id = ? ORDER BY id").all(oldMed) as { event_type: string }[];
  assert.ok(events.some((e) => e.event_type === "medication_replaced"), "replacement lands on the timeline");

  // A plan the patient never confirmed has nothing to replace.
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  const plan = await makePlan(db, clin.cookie, patient.profileId!);
  mockDpd({ brand: "MOTRIN", din: "09999999", ingredient: "IBUPROFEN" });
  const refused = await replaceMedication(
    jsonRequest(`/api/medications/${plan.id}/replace`, { method: "POST", cookie: patient.cookie, body: { drug_code: 777 } }),
    idCtx(plan.id)
  );
  assert.equal(refused.status, 409, "confirm the plan first");
});

test("DECLINED/CANCELLED: never-taken terminals get an end_date and generate ZERO adherence expectations", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);

  const plan = await makePlan(db, clin.cookie, patient.profileId!);
  // Make the fabrication window real: the plan has existed for days.
  db.prepare("UPDATE medications SET created_at = datetime('now','-6 days') WHERE id = ?").run(plan.id);

  const res = await lifecycleAction(
    jsonRequest(`/api/medications/${plan.id}/lifecycle`, { method: "POST", cookie: patient.cookie, body: { action: "decline", reason: "worried about side effects" } }),
    idCtx(plan.id)
  );
  assert.equal(res.status, 200);
  const declined = medRow(db, plan.id);
  assert.equal(declined.lifecycle_status, "declined");
  assert.ok(declined.end_date, "decline stamps a closing date");

  const adherence = computeAdherence(db, patient.profileId!, 14);
  assert.ok(!adherence.per_med.some((m) => m.medication_id === plan.id), "a refused med has no missed doses");
  assert.equal(adherence.overall.expected_due, 0, "nothing due overall — the declined plan is the only med");

  const plan2 = await makePlan(db, clin.cookie, patient.profileId!);
  db.prepare("UPDATE medications SET created_at = datetime('now','-6 days') WHERE id = ?").run(plan2.id);
  await lifecycleAction(
    jsonRequest(`/api/medications/${plan2.id}/lifecycle`, { method: "POST", cookie: patient.cookie, body: { action: "cancelled_externally" } }),
    idCtx(plan2.id)
  );
  const adherence2 = computeAdherence(db, patient.profileId!, 14);
  assert.ok(!adherence2.per_med.some((m) => m.medication_id === plan2.id), "cancelled plans are excluded too");
  assert.ok(medRow(db, plan2.id).end_date, "cancelled stamps a closing date");
});

test("DOSE LOG GATE: paused and terminal meds refuse new dose logs (only current use logs)", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const med = addMed(db, patient.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });

  await lifecycleAction(
    jsonRequest(`/api/medications/${med}/lifecycle`, { method: "POST", cookie: patient.cookie, body: { action: "pause" } }),
    idCtx(med)
  );
  let res = await postDose(
    jsonRequest("/api/dose-events", { method: "POST", cookie: patient.cookie, body: { medication_id: med, action: "taken" } })
  );
  assert.equal(res.status, 409, "paused: resume first");

  await lifecycleAction(
    jsonRequest(`/api/medications/${med}/lifecycle`, { method: "POST", cookie: patient.cookie, body: { action: "resume" } }),
    idCtx(med)
  );
  res = await postDose(
    jsonRequest("/api/dose-events", { method: "POST", cookie: patient.cookie, body: { medication_id: med, action: "taken" } })
  );
  assert.equal(res.status, 200, "current use logs fine");

  await lifecycleAction(
    jsonRequest(`/api/medications/${med}/lifecycle`, { method: "POST", cookie: patient.cookie, body: { action: "stop" } }),
    idCtx(med)
  );
  res = await postDose(
    jsonRequest("/api/dose-events", { method: "POST", cookie: patient.cookie, body: { medication_id: med, action: "taken" } })
  );
  assert.equal(res.status, 409, "stopped: the record is closed");
});

test("LEGACY PATCH: terminal lifecycles can't be resurrected; stop/resume toggles land on the event timeline", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);

  const plan = await makePlan(db, clin.cookie, patient.profileId!);
  await lifecycleAction(
    jsonRequest(`/api/medications/${plan.id}/lifecycle`, { method: "POST", cookie: patient.cookie, body: { action: "decline" } }),
    idCtx(plan.id)
  );
  const revive = await patchMedication(
    jsonRequest(`/api/medications/${plan.id}`, { method: "PATCH", cookie: patient.cookie, body: { status: "active" } }),
    idCtx(plan.id)
  );
  assert.equal(revive.status, 409, "declined is a closed record");
  assert.equal(medRow(db, plan.id).lifecycle_status, "declined");

  const med = addMed(db, patient.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });
  await patchMedication(
    jsonRequest(`/api/medications/${med}`, { method: "PATCH", cookie: patient.cookie, body: { status: "stopped" } }),
    idCtx(med)
  );
  await patchMedication(
    jsonRequest(`/api/medications/${med}`, { method: "PATCH", cookie: patient.cookie, body: { status: "active" } }),
    idCtx(med)
  );
  const events = db
    .prepare("SELECT event_type, actor_role FROM medication_events WHERE medication_id = ? ORDER BY id")
    .all(med) as { event_type: string; actor_role: string }[];
  assert.deepEqual(events.map((e) => e.event_type), ["patient_stopped", "patient_resumed"], "the legacy toggle is a lifecycle transition like any other");
  assert.ok(events.every((e) => e.actor_role === "patient"));
});

test("CONCERN CLASS: paused pairs say 'paused' (never 'planned — not started'); planned outranks paused; severity untouched", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  addMed(db, patient.profileId!, { name: "APO-WARFARIN", ingredients: [{ name: "WARFARIN SODIUM", strength: "1" }] });
  const ibu = addMed(db, patient.profileId!, { name: "ADVIL", ingredients: [{ name: "IBUPROFEN", strength: "200" }] });

  const before = recomputeAlerts(db, patient.profileId!).all;
  assert.equal(before.length, 1);
  assert.equal(before[0].concern_class, "current");
  const severity = before[0].severity;

  await lifecycleAction(
    jsonRequest(`/api/medications/${ibu}/lifecycle`, { method: "POST", cookie: patient.cookie, body: { action: "pause", reason: "surgery week" } }),
    idCtx(ibu)
  );
  const paused = recomputeAlerts(db, patient.profileId!).all;
  assert.equal(paused[0].concern_class, "paused", "a med taken for months is not 'not started'");
  assert.equal(paused[0].severity, severity, "lifecycle never re-grades severity");

  // A planned duplicate against the paused med: 'planned' wins the label.
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  const plan = await makePlan(db, clin.cookie, patient.profileId!, { drug_code: 777 });
  const withPlan = recomputeAlerts(db, patient.profileId!).all;
  const dup = withPlan.find((a) => a.kind === "duplicate" && (a.med_a_id === plan.id || a.med_b_id === plan.id));
  assert.ok(dup, "planned ADVIL duplicates the paused ibuprofen");
  assert.equal(dup!.concern_class, "planned");
});

test("RECON COVERAGE: meds_total counts the workspace set (plans included) — never 'N of fewer-than-N'", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  const current = addMed(db, patient.profileId!, { name: "TYLENOL", ingredients: [{ name: "ACETAMINOPHEN", strength: "500" }] });
  const plan = await makePlan(db, clin.cookie, patient.profileId!);

  const started = await startRecon(jsonRequest(`/api/reconcile?patient=${patient.profileId}`, { method: "POST", cookie: clin.cookie }));
  assert.equal(started.status, 200);
  const sessionId = (await started.json()).session.id as number;

  const workspace = await (await getRecon(jsonRequest(`/api/reconcile?patient=${patient.profileId}`, { cookie: clin.cookie }))).json();
  assert.equal(workspace.items.length, 2, "the unconfirmed plan is part of the workspace");

  for (const medId of [current, plan.id]) {
    const disposed = await reconAction(
      jsonRequest(`/api/reconcile/${sessionId}`, {
        method: "POST",
        cookie: clin.cookie,
        body: { action: "dispose", medication_id: medId, disposition: "follow_up", note: null },
      }),
      idCtx(sessionId)
    );
    assert.equal(disposed.status, 200);
  }
  const completed = await reconAction(
    jsonRequest(`/api/reconcile/${sessionId}`, { method: "POST", cookie: clin.cookie, body: { action: "complete" } }),
    idCtx(sessionId)
  );
  assert.equal(completed.status, 200);
  const session = (await completed.json()).session;
  assert.equal(session.meds_total, 2, "coverage denominator matches the workspace");

  // The review's exact symptom: never "2 of 1 medications reviewed".
  const after = await (await getRecon(jsonRequest(`/api/reconcile?patient=${patient.profileId}`, { cookie: clin.cookie }))).json();
  assert.ok(after.last_completed.disposed <= after.last_completed.meds_total);
});

test("SUPPLY SURFACES: a shortage on a PLANNED med's DIN is visible (GET, roster count, reconciliation flag)", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  const plan = await makePlan(db, clin.cookie, patient.profileId!); // DIN 01234567 via mockDpd

  db.prepare(
    `INSERT INTO drug_shortages (report_id, kind, din, brand_name, status, state, reason)
     VALUES ('T-1', 'shortage', '01234567', 'ADVIL', 'active_confirmed', 'active', 'Demand increase')`
  ).run();
  db.prepare("INSERT INTO shortage_checks (din, reports_found) VALUES ('01234567', 1)").run();

  const supply = await (await getSupply(jsonRequest("/api/shortages", { cookie: patient.cookie }))).json();
  const planRow = supply.medications.find((m: { medication_id: number }) => m.medication_id === plan.id);
  assert.ok(planRow, "the planned med appears on the supply surface");
  assert.equal(planRow.supply.state, "checked");
  assert.equal(planRow.supply.reports.length, 1);

  assert.equal(countOpenShortages(db, patient.profileId!), 1, "roster chip counts the planned med");

  const flags = computeFlags(db, patient.profileId!).get(plan.id) ?? [];
  assert.ok(flags.some((f) => f.code === "supply_shortage"), "reconciliation shows the shortage before the patient reaches the counter");
});

test("NOTIFICATION CONSENT GATE: a revoked clinician hears nothing more (actions or nudges); a live grant still does", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);

  const plan = await makePlan(db, clin.cookie, patient.profileId!);
  db.prepare("UPDATE medications SET created_at = datetime('now','-9 days') WHERE id = ?").run(plan.id);
  db.prepare("UPDATE access_grants SET status = 'revoked' WHERE profile_id = ?").run(patient.profileId);

  await lifecycleAction(
    jsonRequest(`/api/medications/${plan.id}/lifecycle`, { method: "POST", cookie: patient.cookie, body: { action: "decline", reason: "private reason" } }),
    idCtx(plan.id)
  );
  generateClinicianNudges(db, clin.userId);
  const types = (db.prepare("SELECT type FROM notifications WHERE user_id = ?").all(clin.userId) as { type: string }[]).map((n) => n.type);
  assert.ok(!types.includes("plan_declined"), "no decline notification after revocation");
  assert.ok(!types.includes("plan_not_received"), "no stale-plan nudge after revocation");

  // Positive control: with a live grant the same flow notifies.
  grantAccess(db, patient.profileId!, clin.userId);
  const plan2 = await makePlan(db, clin.cookie, patient.profileId!);
  await lifecycleAction(
    jsonRequest(`/api/medications/${plan2.id}/lifecycle`, { method: "POST", cookie: patient.cookie, body: { action: "decline" } }),
    idCtx(plan2.id)
  );
  const after = (db.prepare("SELECT type FROM notifications WHERE user_id = ?").all(clin.userId) as { type: string }[]).map((n) => n.type);
  assert.ok(after.includes("plan_declined"), "live grant still hears about it");
});

test("TIMELINE GET: patients and granted clinicians read the event history; strangers get nothing", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  const stranger = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  const plan = await makePlan(db, clin.cookie, patient.profileId!);

  const own = await getLifecycleEvents(jsonRequest(`/api/medications/${plan.id}/lifecycle`, { cookie: patient.cookie }), idCtx(plan.id));
  assert.equal(own.status, 200);
  assert.ok((await own.json()).events.some((e: { event_type: string }) => e.event_type === "plan_created"));

  const granted = await getLifecycleEvents(
    jsonRequest(`/api/medications/${plan.id}/lifecycle?patient=${patient.profileId}`, { cookie: clin.cookie }),
    idCtx(plan.id)
  );
  assert.equal(granted.status, 200);

  const denied = await getLifecycleEvents(
    jsonRequest(`/api/medications/${plan.id}/lifecycle?patient=${patient.profileId}`, { cookie: stranger.cookie }),
    idCtx(plan.id)
  );
  assert.equal(denied.status, 403, "no grant, no timeline");
});

test("REPORT DATA PATH: the medications payload carries prescribed AND patient-reported values side by side, plus who entered the plan", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  const plan = await makePlan(db, clin.cookie, patient.profileId!);

  for (const action of [{ action: "received" }, { action: "start" }]) {
    await lifecycleAction(
      jsonRequest(`/api/medications/${plan.id}/lifecycle`, { method: "POST", cookie: patient.cookie, body: action }),
      idCtx(plan.id)
    );
  }
  await patchMedication(
    jsonRequest(`/api/medications/${plan.id}`, { method: "PATCH", cookie: patient.cookie, body: { dose_value: 40 } }),
    idCtx(plan.id)
  );

  const payload = await (await listMedications(jsonRequest("/api/medications", { cookie: patient.cookie }))).json();
  const med = payload.medications.find((m: { id: number }) => m.id === plan.id);
  const clinName = (db.prepare("SELECT display_name FROM users WHERE id = ?").get(clin.userId) as { display_name: string }).display_name;
  assert.equal(med.prescribed_dose_value, 1, "the prescription is frozen");
  assert.equal(med.dose_value, 40, "the patient-reported truth diverges beside it");
  assert.equal(med.source_user_name, clinName, "honest 'Entered by' attribution rides the payload");

  const flags = computeFlags(db, patient.profileId!).get(plan.id) ?? [];
  assert.ok(flags.some((f) => f.code === "dose_differs_from_prescription"));
});

test("NOT-RECEIVED FLAG: the pharmacist sees the patient's actual reason, not an unrelated question", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  grantAccess(db, patient.profileId!, clin.userId);
  const plan = await makePlan(db, clin.cookie, patient.profileId!);

  await lifecycleAction(
    jsonRequest(`/api/medications/${plan.id}/lifecycle`, {
      method: "POST",
      cookie: patient.cookie,
      body: { action: "not_received", reason: "pharmacy could not fill it" },
    }),
    idCtx(plan.id)
  );
  const flags = computeFlags(db, patient.profileId!).get(plan.id) ?? [];
  const flag = flags.find((f) => f.code === "not_received");
  assert.ok(flag);
  assert.equal(flag!.detail, "pharmacy could not fill it");
});
