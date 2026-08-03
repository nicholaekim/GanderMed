// Drug shortage awareness. The property that matters most here is the one
// the rest of this app keeps insisting on: silence is not safety. "We never
// checked", "we can't check this", and "we checked and nothing is reported"
// must stay three visibly different answers — and supply data must never
// leak into the clinical engine.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  __setShortageFetchForTests,
  countOpenShortages,
  lookupForMedication,
  normalizeDin,
  normalizeState,
  parseReport,
  reportsForDins,
  syncShortages,
  type DscReport,
} from "../src/lib/shortages";
import { computeFlags } from "../src/lib/reconcile";
import { GET as shortagesGet, POST as shortagesRefresh } from "../src/app/api/shortages/route";
import { __resetRateLimitsForTests } from "../src/lib/ratelimit";
import { addMed, createUserSession, freshDb, jsonRequest, useTestDb } from "./helpers";
import type { DatabaseSync } from "node:sqlite";

afterEach(() => {
  __setShortageFetchForTests(null);
  __resetRateLimitsForTests();
});

/** A DSC-shaped shortage report. */
function shortageReport(din: string, overrides: Partial<DscReport> = {}): DscReport {
  return {
    id: `rep-${din}-${String(overrides.status ?? "active_confirmed")}`,
    type: "shortage",
    status: "active_confirmed",
    din,
    en_drug_brand_name: "APO-TEST",
    company_name: "Apotex",
    en_shortage_reason: "Demand increase for the drug",
    actual_start_date: "2026-06-01",
    estimated_end_date: "2026-09-30",
    updated_date: "2026-07-15",
    ...overrides,
  };
}

/** Mocks the API: a map of DIN → reports; any other DIN returns nothing. */
function mockDsc(byDin: Record<string, DscReport[]>) {
  __setShortageFetchForTests(async (din) => byDin[din] ?? []);
}

function verifiedMed(db: DatabaseSync, profileId: number, name: string, din: string): number {
  const medId = addMed(db, profileId, { name, ingredients: [{ name: "TESTOSTERONE", strength: "1" }] });
  db.prepare("UPDATE medications SET din = ? WHERE id = ?").run(din, medId);
  return medId;
}

test("DIN normalization pads and rejects junk so DPD and DSC values join", () => {
  assert.equal(normalizeDin("2242924"), "02242924");
  assert.equal(normalizeDin("02242924"), "02242924");
  assert.equal(normalizeDin("DIN 02242924"), "02242924");
  assert.equal(normalizeDin(""), null);
  assert.equal(normalizeDin(null), null);
  assert.equal(normalizeDin("123456789"), null, "too long to be a DIN");
});

test("status mapping: unrecognized statuses become 'unknown' rather than being dropped", () => {
  assert.equal(normalizeState("active_confirmed", "shortage"), "active");
  assert.equal(normalizeState("anticipated_shortage", "shortage"), "anticipated");
  assert.equal(normalizeState("avoided_shortage", "shortage"), "resolved");
  assert.equal(normalizeState("resolved", "shortage"), "resolved");
  assert.equal(normalizeState("discontinued", "discontinuation"), "discontinued");
  assert.equal(normalizeState("reversed", "discontinuation"), "resolved");
  assert.equal(normalizeState("some_new_status_2027", "shortage"), "unknown");
});

test("report parsing tolerates missing fields and detects discontinuations", () => {
  const parsed = parseReport(shortageReport("02242924"), "02242924");
  assert.ok(parsed);
  assert.equal(parsed!.state, "active");
  assert.equal(parsed!.kind, "shortage");
  assert.equal(parsed!.reason, "Demand increase for the drug");

  const disc = parseReport({ id: "d1", type: "discontinuation", din: "02242924", discontinuation_date: "2026-05-01" }, "02242924");
  assert.equal(disc!.kind, "discontinuation");
  assert.equal(disc!.state, "discontinued");

  const sparse = parseReport({ id: "x1" }, "02242924");
  assert.equal(sparse!.din, "02242924", "falls back to the DIN we asked about");
  assert.equal(sparse!.state, "unknown");
  assert.equal(parseReport({ status: "active" }, "02242924"), null, "no id → not storable");
});

test("HONESTY: never-checked, not-checkable, and checked-clear are three different answers", async () => {
  const db = useTestDb();
  const { profileId } = createUserSession(db, "patient");
  const checked = verifiedMed(db, profileId!, "APO-TEST", "02242924");
  const unchecked = verifiedMed(db, profileId!, "OTHER-BRAND", "00999999");
  const manual = addMed(db, profileId!, { name: "mystery supplement", verified: false, ingredients: [] });

  mockDsc({}); // the API answers, but reports nothing for anyone
  // Only ask about one of the two DINs, so the other stays never-checked.
  db.prepare("UPDATE medications SET status = 'stopped' WHERE id = ?").run(unchecked);
  await syncShortages(db, {});
  db.prepare("UPDATE medications SET status = 'active' WHERE id = ?").run(unchecked);

  const rows = db.prepare("SELECT id, din, verified FROM medications").all() as {
    id: number;
    din: string | null;
    verified: number;
  }[];
  const byId = new Map(rows.map((r) => [r.id, r]));

  const checkedLookup = lookupForMedication(db, byId.get(checked)!);
  assert.equal(checkedLookup.state, "checked");
  assert.equal(checkedLookup.state === "checked" && checkedLookup.reports.length, 0, "checked and clear");

  assert.equal(lookupForMedication(db, byId.get(unchecked)!).state, "never_checked");
  assert.equal(lookupForMedication(db, byId.get(manual)!).state, "not_checkable");
});

test("a failed lookup never counts as a clean check", async () => {
  const db = useTestDb();
  const { profileId } = createUserSession(db, "patient");
  const medId = verifiedMed(db, profileId!, "APO-TEST", "02242924");
  __setShortageFetchForTests(async () => {
    throw new Error("network down");
  });

  const result = await syncShortages(db, {});
  assert.equal(result.outcome, "error");
  assert.equal(result.dins_checked, 0);

  const med = db.prepare("SELECT din, verified FROM medications WHERE id = ?").get(medId) as {
    din: string;
    verified: number;
  };
  assert.equal(lookupForMedication(db, med).state, "never_checked", "an error must not read as 'no shortage'");
});

test("sync caches reports, skips freshly-checked DINs, and records the run", async () => {
  const db = useTestDb();
  const { profileId } = createUserSession(db, "patient");
  verifiedMed(db, profileId!, "APO-TEST", "02242924");
  mockDsc({ "02242924": [shortageReport("02242924")] });

  const first = await syncShortages(db, {});
  assert.equal(first.outcome, "ok");
  assert.equal(first.dins_checked, 1);
  assert.equal(first.reports_upserted, 1);

  const second = await syncShortages(db, {});
  assert.equal(second.dins_checked, 0, "recently-checked DINs are skipped");

  const forced = await syncShortages(db, { force: true });
  assert.equal(forced.dins_checked, 1);
  const stored = db.prepare("SELECT COUNT(*) AS n FROM drug_shortages").get() as { n: number };
  assert.equal(stored.n, 1, "re-running upserts rather than duplicating");
  const runs = db.prepare("SELECT COUNT(*) AS n FROM shortage_syncs").get() as { n: number };
  assert.equal(runs.n, 3, "every run is recorded, including the no-op");
});

test("FLAGS: active shortages and discontinuations flag; resolved ones never do", async () => {
  const db = useTestDb();
  const { profileId } = createUserSession(db, "patient");
  const shorted = verifiedMed(db, profileId!, "APO-TEST", "02242924");
  const discontinued = verifiedMed(db, profileId!, "GONE-BRAND", "02111111");
  const fine = verifiedMed(db, profileId!, "FINE-BRAND", "02222222");

  mockDsc({
    "02242924": [shortageReport("02242924")],
    "02111111": [{ id: "d9", type: "discontinuation", din: "02111111", discontinuation_date: "2026-04-01" }],
    "02222222": [shortageReport("02222222", { id: "r-resolved", status: "resolved" })],
  });
  await syncShortages(db, {});

  const flags = computeFlags(db, profileId!);
  const codes = (id: number) => (flags.get(id) ?? []).map((f) => f.code);
  assert.ok(codes(shorted).includes("supply_shortage"));
  assert.ok(codes(discontinued).includes("supply_discontinued"));
  assert.ok(!codes(fine).includes("supply_shortage"), "a resolved report is history, not a discrepancy");
  assert.ok(!codes(fine).includes("supply_discontinued"));

  const detail = (flags.get(shorted) ?? []).find((f) => f.code === "supply_shortage");
  assert.match(detail!.detail ?? "", /Demand increase/, "the reason travels with the flag");
});

test("supply data never touches the clinical engine: no alerts, no severity changes", async () => {
  const db = useTestDb();
  const { profileId } = createUserSession(db, "patient");
  verifiedMed(db, profileId!, "APO-TEST", "02242924");
  mockDsc({ "02242924": [shortageReport("02242924")] });
  await syncShortages(db, {});
  computeFlags(db, profileId!);

  const alerts = db.prepare("SELECT COUNT(*) AS n FROM alerts").get() as { n: number };
  assert.equal(alerts.n, 0, "a shortage is a supply fact, not an interaction");
});

test("unverified medications are never given a supply verdict", async () => {
  const db = useTestDb();
  const { profileId } = createUserSession(db, "patient");
  const manual = addMed(db, profileId!, { name: "herbal thing", verified: false, ingredients: [] });
  mockDsc({});
  await syncShortages(db, {});

  const flags = computeFlags(db, profileId!);
  const codes = (flags.get(manual) ?? []).map((f) => f.code);
  assert.ok(!codes.includes("supply_shortage"));
  assert.ok(codes.includes("unverified"), "it is still flagged for the reason that actually applies");
});

test("STALENESS: an old check is still 'checked' but marked out of date", async () => {
  const db = useTestDb();
  const { profileId } = createUserSession(db, "patient");
  const medId = verifiedMed(db, profileId!, "APO-TEST", "02242924");
  mockDsc({});
  await syncShortages(db, {});
  db.prepare("UPDATE shortage_checks SET checked_at = datetime('now','-30 days')").run();

  const med = db.prepare("SELECT din, verified FROM medications WHERE id = ?").get(medId) as {
    din: string;
    verified: number;
  };
  const lookup = lookupForMedication(db, med);
  assert.equal(lookup.state, "checked");
  assert.equal(lookup.state === "checked" && lookup.stale, true);
});

test("roster count reflects only active verified meds with open reports", async () => {
  const db = freshDb();
  db.prepare("INSERT INTO profiles (name, share_code) VALUES ('P', 'SUPP-0001')").run();
  const profileId = 1;
  const shorted = verifiedMed(db, profileId, "APO-TEST", "02242924");
  const stopped = verifiedMed(db, profileId, "STOPPED-BRAND", "02333333");
  db.prepare("UPDATE medications SET status = 'stopped' WHERE id = ?").run(stopped);

  db.prepare(
    `INSERT INTO drug_shortages (report_id, kind, din, status, state) VALUES
     ('a1','shortage','02242924','active_confirmed','active'),
     ('a2','shortage','02333333','active_confirmed','active')`
  ).run();

  assert.equal(countOpenShortages(db, profileId), 1, "stopped medications don't count");
  assert.equal(reportsForDins(db, ["02242924"]).get("02242924")!.length, 1);
  void shorted;
});

test("ROUTES: patients read their own supply status; clinicians need a grant; refresh is clinician-only", async () => {
  const db = useTestDb();
  const patient = createUserSession(db, "patient");
  const clin = createUserSession(db, "clinician");
  verifiedMed(db, patient.profileId!, "APO-TEST", "02242924");

  const own = await shortagesGet(jsonRequest("/api/shortages", { cookie: patient.cookie }));
  assert.equal(own.status, 200);
  const body = await own.json();
  assert.equal(body.medications.length, 1);
  assert.ok(["never_checked", "not_configured"].includes(body.medications[0].supply.state));

  const noGrant = await shortagesGet(
    jsonRequest(`/api/shortages?patient=${patient.profileId}`, { cookie: clin.cookie })
  );
  assert.equal(noGrant.status, 403);

  const patientRefresh = await shortagesRefresh(jsonRequest("/api/shortages", { method: "POST", cookie: patient.cookie }));
  assert.equal(patientRefresh.status, 403);
});

test("refresh reports honestly when the integration isn't configured", async () => {
  const db = useTestDb();
  const clin = createUserSession(db, "clinician");
  __setShortageFetchForTests(null); // no injected fetcher, no credentials

  const res = await shortagesRefresh(jsonRequest("/api/shortages", { method: "POST", cookie: clin.cookie }));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.needs_key, true);
  assert.match(body.setup, /DSC_EMAIL/);
  const run = db.prepare("SELECT outcome FROM shortage_syncs ORDER BY id DESC LIMIT 1").get() as { outcome: string };
  assert.equal(run.outcome, "not_configured", "the attempt is still recorded");
});
