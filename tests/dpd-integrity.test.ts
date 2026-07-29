// Phase 2: the server must resolve product identity authoritatively from
// Health Canada and refuse to safety-check anything that isn't a marketed
// human product with listed ingredients. Client-sent metadata is ignored.
// All DPD responses here are mocked — no live API dependency.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __setDpdFetchForTests } from "../src/lib/dpd";
import { POST as postMedication } from "../src/app/api/medications/route";
import { createUserSession, jsonRequest, useTestDb } from "./helpers";
import type { Medication } from "../src/lib/types";

afterEach(() => __setDpdFetchForTests(null));

interface MockProduct {
  class_name?: string;
  status?: string;
  ingredients?: { ingredient_name: string; strength: string; strength_unit: string }[];
}

function mockDpd(overrides: MockProduct = {}) {
  const {
    class_name = "Human",
    status = "Marketed",
    ingredients = [
      { ingredient_name: "IBUPROFEN", strength: "200", strength_unit: "MG" },
      { ingredient_name: "DIPHENHYDRAMINE HYDROCHLORIDE", strength: "25", strength_unit: "MG" },
    ],
  } = overrides;

  __setDpdFetchForTests(async <T,>(path: string): Promise<T[]> => {
    if (path.startsWith("drugproduct/")) {
      return [
        {
          drug_code: 777,
          class_name,
          drug_identification_number: "01234567",
          brand_name: "AUTHORITATIVE BRAND",
          descriptor: "",
          number_of_ais: String(ingredients.length),
          company_name: "AUTHORITATIVE CO",
          last_update_date: "2026-01-01",
        },
      ] as T[];
    }
    if (path.startsWith("activeingredient/")) return ingredients as T[];
    if (path.startsWith("route/")) return [{ route_of_administration_name: "Oral" }] as T[];
    if (path.startsWith("form/")) return [{ pharmaceutical_form_name: "Tablet" }] as T[];
    if (path.startsWith("status/")) return [{ status }] as T[];
    return [];
  });
}

test("tampered client brand/DIN/company are ignored — authoritative values stored", async () => {
  const db = useTestDb();
  const { cookie } = createUserSession(db, "patient");
  mockDpd();

  const res = await postMedication(
    jsonRequest("/api/medications", {
      method: "POST",
      cookie,
      body: {
        drug_code: 777,
        brand_name: "EVIL BRAND",
        din: "99999999",
        company_name: "EVIL CO",
        is_prn: true,
        schedule_times: [],
      },
    })
  );
  assert.equal(res.status, 200);
  const med = (await res.json()).medication as Medication;
  assert.equal(med.brand_name, "AUTHORITATIVE BRAND");
  assert.equal(med.din, "01234567");
  assert.equal(med.company_name, "AUTHORITATIVE CO");
  assert.equal(med.verified, 1);
});

test("combination products still expand into canonicalized ingredients", async () => {
  const db = useTestDb();
  const { cookie } = createUserSession(db, "patient");
  mockDpd();

  const res = await postMedication(
    jsonRequest("/api/medications", {
      method: "POST",
      cookie,
      body: { drug_code: 777, is_prn: true, schedule_times: [] },
    })
  );
  const med = (await res.json()).medication as Medication;
  assert.equal(med.ingredients.length, 2);
  const canon = med.ingredients.map((i) => i.canonical_name).sort();
  assert.deepEqual(canon, ["diphenhydramine", "ibuprofen"]);
});

test("a non-marketed product cannot become a verified medication", async () => {
  const db = useTestDb();
  const { cookie } = createUserSession(db, "patient");
  mockDpd({ status: "Cancelled Post Market" });

  const res = await postMedication(
    jsonRequest("/api/medications", {
      method: "POST",
      cookie,
      body: { drug_code: 777, is_prn: true, schedule_times: [] },
    })
  );
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /currently marketed/i);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM medications").get() as { n: number }).n, 0);
});

test("a non-human product is rejected", async () => {
  const db = useTestDb();
  const { cookie } = createUserSession(db, "patient");
  mockDpd({ class_name: "Veterinary" });

  const res = await postMedication(
    jsonRequest("/api/medications", {
      method: "POST",
      cookie,
      body: { drug_code: 777, is_prn: true, schedule_times: [] },
    })
  );
  assert.equal(res.status, 422);
});

test("a product with no active ingredients cannot be verified", async () => {
  const db = useTestDb();
  const { cookie } = createUserSession(db, "patient");
  mockDpd({ ingredients: [] });

  const res = await postMedication(
    jsonRequest("/api/medications", {
      method: "POST",
      cookie,
      body: { drug_code: 777, is_prn: true, schedule_times: [] },
    })
  );
  assert.equal(res.status, 422);
});

test("manual entries stay unverified with no ingredients (excluded from checks)", async () => {
  const db = useTestDb();
  const { cookie } = createUserSession(db, "patient");
  mockDpd(); // present but must not be consulted for manual entries

  const res = await postMedication(
    jsonRequest("/api/medications", {
      method: "POST",
      cookie,
      body: { manual_name: "my mystery supplement", is_prn: true, schedule_times: [] },
    })
  );
  assert.equal(res.status, 200);
  const med = (await res.json()).medication as Medication;
  assert.equal(med.verified, 0);
  assert.equal(med.ingredients.length, 0);
});

test("unauthenticated requests are rejected", async () => {
  useTestDb();
  mockDpd();
  const res = await postMedication(
    jsonRequest("/api/medications", { method: "POST", body: { drug_code: 777, is_prn: true, schedule_times: [] } })
  );
  assert.equal(res.status, 401);
});
