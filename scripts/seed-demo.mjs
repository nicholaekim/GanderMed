// Seeds demo patients through the REAL APIs (register → live Health Canada
// search → add meds → log doses → care-code link → one clinician review), so
// every record went through the actual normalization + conflict pipeline.
//
// Usage: start the dev server, then  node scripts/seed-demo.mjs
// Idempotent-ish: re-running logs in instead of registering, and skips
// medications/doses for patients that already have medications.

const BASE = "http://localhost:3000";
const PASSWORD = "DemoPass123";

async function api(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = setCookie.match(/dcai_session=[a-f0-9]{64}/);
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, ok: res.ok, data, cookie: m ? m[0] : null };
}

async function auth(email, name, role, clinic = undefined) {
  let r = await api("/api/auth/register", {
    method: "POST",
    body: { email, password: PASSWORD, display_name: name, role, clinic_name: clinic },
  });
  if (r.status === 409) {
    r = await api("/api/auth/login", { method: "POST", body: { email, password: PASSWORD } });
  }
  if (!r.ok || !r.cookie) throw new Error(`auth failed for ${email}: ${JSON.stringify(r.data)}`);
  return { cookie: r.cookie, user: r.data.user };
}

const p2 = (n) => String(n).padStart(2, "0");
function slot(dayOffset, hhmm) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${hhmm}`;
}
function iso(dayOffset, h, m) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

// med: { q, dose, unit, times } (scheduled) or { q, dose, unit, prn: true }
// dose event: { med: index, slot: [dayOffset, "HH:mm"]|null, at: [dayOffset, h, m], action? }
const PATIENTS = [
  {
    email: "margaret@demo.test",
    name: "Margaret Thompson",
    meds: [
      { q: "apo-warfarin", dose: 1, unit: "tablet(s)", times: ["18:00"] },
      { q: "synthroid", dose: 1, unit: "tablet(s)", times: ["07:00"] },
      // Calcium supplements are NHPs (not in the DPD) — Tums is a DIN'd drug
      // containing calcium carbonate, so it exercises the same interaction.
      { q: "tums", dose: 1, unit: "tablet(s)", times: ["08:00", "20:00"] },
      { q: "advil", dose: 1, unit: "tablet(s)", prn: true },
    ],
    doses: [
      { med: 0, slot: [-1, "18:00"], at: [-1, 18, 10] },
      { med: 1, slot: [-1, "07:00"], at: [-1, 7, 2] },
      { med: 1, slot: [0, "07:00"], at: [0, 7, 6] },
      { med: 2, slot: [0, "08:00"], at: [0, 8, 15] },
      { med: 3, slot: null, at: [-1, 14, 0] },
      { med: 3, slot: null, at: [0, 9, 30] },
    ],
  },
  {
    email: "raj@demo.test",
    name: "Raj Patel",
    meds: [
      { q: "ramipril", dose: 1, unit: "capsule(s)", times: ["08:00"] },
      { q: "spironolactone", dose: 1, unit: "tablet(s)", times: ["08:00"] },
      { q: "tiazac", dose: 1, unit: "capsule(s)", times: ["08:00"] },
      { q: "metoprolol", dose: 1, unit: "tablet(s)", times: ["08:00", "20:00"] },
    ],
    doses: [
      { med: 0, slot: [-1, "08:00"], at: [-1, 8, 5] },
      { med: 0, slot: [0, "08:00"], at: [0, 8, 2] },
      { med: 1, slot: [0, "08:00"], at: [0, 8, 3] },
      { med: 2, slot: [0, "08:00"], at: [0, 8, 4] },
      { med: 3, slot: [-1, "20:00"], at: [-1, 20, 6] },
      { med: 3, slot: [0, "08:00"], at: [0, 9, 45] }, // late
    ],
  },
  {
    email: "emily@demo.test",
    name: "Emily Nguyen",
    meds: [
      { q: "sertraline", dose: 1, unit: "capsule(s)", times: ["09:00"] },
      { q: "tylenol extra strength", dose: 2, unit: "tablet(s)", prn: true },
      { q: "nyquil", dose: 30, unit: "mL", prn: true },
      { q: "advil", dose: 1, unit: "tablet(s)", prn: true },
    ],
    doses: [
      { med: 0, slot: [-1, "09:00"], at: [-1, 9, 30], action: "skipped" },
      { med: 0, slot: [0, "09:00"], at: [0, 9, 5] },
      { med: 1, slot: null, at: [0, 8, 0] },
      { med: 1, slot: null, at: [0, 12, 30] },
      { med: 2, slot: null, at: [-1, 22, 30] },
      { med: 2, slot: null, at: [0, 6, 30] },
      { med: 3, slot: null, at: [0, 10, 0] },
    ],
  },
  {
    email: "david@demo.test",
    name: "David Okafor",
    meds: [
      { q: "lipitor", dose: 1, unit: "tablet(s)", times: ["21:00"] },
      { q: "norvasc", dose: 1, unit: "tablet(s)", times: ["08:00"] },
    ],
    doses: [
      { med: 0, slot: [-1, "21:00"], at: [-1, 21, 2] },
      { med: 1, slot: [-1, "08:00"], at: [-1, 8, 4] },
      { med: 1, slot: [0, "08:00"], at: [0, 8, 1] },
    ],
  },
];

async function seedPatient(spec) {
  const { cookie, user } = await auth(spec.email, spec.name, "patient");
  console.log(`\n${spec.name} — care code ${user.share_code}`);

  const existing = await api("/api/medications", { cookie });
  if ((existing.data?.medications ?? []).length > 0) {
    console.log("  already seeded, skipping meds/doses");
    return { user };
  }

  const medIds = [];
  for (const med of spec.meds) {
    const search = await api(`/api/search?q=${encodeURIComponent(med.q)}`, { cookie });
    const pick = search.data?.results?.[0];
    if (!pick) {
      console.log(`  !! no DPD result for "${med.q}" — skipped`);
      medIds.push(null);
      continue;
    }
    const add = await api("/api/medications", {
      method: "POST",
      cookie,
      body: {
        drug_code: pick.drug_code,
        din: pick.din,
        brand_name: pick.brand_name,
        company_name: pick.company_name,
        dose_value: med.dose,
        dose_unit: med.unit,
        is_prn: !!med.prn,
        schedule_times: med.times ?? [],
        start_date: slot(-7, "00:00").slice(0, 10),
      },
    });
    if (!add.ok) {
      console.log(`  !! add failed for ${pick.brand_name}: ${add.data?.error}`);
      medIds.push(null);
      continue;
    }
    medIds.push(add.data.medication.id);
    const alerts = add.data.newAlerts?.length ?? 0;
    console.log(`  + ${pick.brand_name} (DIN ${pick.din})${alerts ? ` → ${alerts} new alert(s)` : ""}`);
  }

  for (const d of spec.doses) {
    const medId = medIds[d.med];
    if (medId == null) continue;
    await api("/api/dose-events", {
      method: "POST",
      cookie,
      body: {
        medication_id: medId,
        scheduled_at: d.slot ? slot(d.slot[0], d.slot[1]) : null,
        action: d.action ?? "taken",
        logged_at: iso(d.at[0], d.at[1], d.at[2]),
      },
    });
  }
  console.log(`  logged ${spec.doses.length} dose events`);
  return { user };
}

async function main() {
  console.log("Seeding demo data via", BASE);
  const patients = [];
  for (const spec of PATIENTS) {
    patients.push({ spec, ...(await seedPatient(spec)) });
  }

  const clinician = await auth("clinician@demo.test", "Dr. Sarah Osei", "clinician", "Maple Health Clinic");
  console.log("\nRequesting access + patient approvals (consent flow)…");
  for (const p of patients) {
    const req = await api("/api/care-links", {
      method: "POST",
      cookie: clinician.cookie,
      body: { code: p.user.share_code, purpose: "MedsCheck preparation" },
    });
    if (!req.ok && req.status !== 409) {
      console.log(`  !! request failed for ${p.spec.name}: ${req.data?.error}`);
      continue;
    }
    // Patient approves their pending request — consent is explicit now.
    const patientCookie = (await auth(p.spec.email, p.spec.name, "patient")).cookie;
    const grants = await api("/api/access", { cookie: patientCookie });
    const pendingGrant = (grants.data?.grants ?? []).find((g) => g.status === "pending");
    if (pendingGrant) {
      await api(`/api/access/${pendingGrant.id}`, {
        method: "POST",
        cookie: patientCookie,
        body: { action: "approve", expires_days: null },
      });
      console.log(`  ${p.spec.name} approved access`);
    } else {
      console.log(`  ${p.spec.name}: no pending request (already approved?)`);
    }
  }

  const rosterRes = await api("/api/care-links", { cookie: clinician.cookie });
  const profileIds = {};
  for (const r of rosterRes.data?.roster ?? []) {
    const match = patients.find((p) => p.spec.name.toLowerCase() === r.patient_name.toLowerCase());
    if (match) profileIds[match.spec.email] = r.profile_id;
  }

  // Seed one clinician review: Margaret's warfarin × ibuprofen major alert.
  const margaretId = profileIds["margaret@demo.test"];
  if (margaretId != null) {
    const alerts = await api(`/api/alerts?patient=${margaretId}`, { cookie: clinician.cookie });
    const target = (alerts.data?.alerts ?? []).find(
      (a) =>
        a.kind === "interaction" &&
        [a.ingredient_a, a.ingredient_b].includes("warfarin") &&
        [a.ingredient_a, a.ingredient_b].includes("ibuprofen") &&
        !a.review
    );
    if (target) {
      const r = await api("/api/alert-reviews", {
        method: "POST",
        cookie: clinician.cookie,
        body: {
          alert_id: target.id,
          note: "Short-term ibuprofen use discussed with patient. INR monitored weekly — recheck if use extends beyond 10 days.",
          expires_days: 90,
        },
      });
      console.log(r.ok ? "  reviewed Margaret's warfarin × ibuprofen alert" : `  !! review failed: ${r.data?.error}`);
    } else {
      console.log("  (warfarin × ibuprofen alert not found or already reviewed)");
    }
  }

  console.log("\nDone. Sign in as clinician@demo.test / DemoPass123 to see the roster.");
}

main().catch((e) => {
  console.error("Seed failed:", e.message);
  process.exit(1);
});
