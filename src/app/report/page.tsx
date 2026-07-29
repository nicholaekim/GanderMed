"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ACTUAL_USE_LABELS, PROVENANCE_LABELS, type Alert, type DoseEvent, type ExposureReport, type Medication, type Severity } from "@/lib/types";
import { EVIDENCE_LABEL, SEVERITY_META, fmtDate, fmtTime, scheduleLabel } from "@/lib/format";
import { titleCase } from "@/lib/normalize";
import { pharmacistQuestions } from "@/lib/questions";
import { RULESET_VERSION } from "@/data/interactionRules";
import type { Evidence } from "@/lib/types";

const EXPOSURE_LABEL: Record<string, string> = {
  overlap: "Recorded doses may have overlapped (estimate)",
  no_overlap:
    "No overlap identified in the available dose records — separating doses does not necessarily remove this interaction concern",
  insufficient_data: "Not enough logged doses to assess timing",
  unknown: "Timing not modelled for this pair",
};

export default function ReportPage() {
  return (
    <Suspense fallback={<p className="mt-20 text-center text-sm text-slate-400">Loading…</p>}>
      <ReportInner />
    </Suspense>
  );
}

function ReportInner() {
  const router = useRouter();
  const patientParam = useSearchParams().get("patient");
  const [meds, setMeds] = useState<Medication[]>([]);
  const [profileName, setProfileName] = useState<string>("");
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [events, setEvents] = useState<DoseEvent[]>([]);
  const [exposure, setExposure] = useState<ExposureReport | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const qs = patientParam ? `?patient=${patientParam}` : "";
      const eventsQs = patientParam ? `?patient=${patientParam}&days=14` : "?days=14";
      const [mRes, aRes, eRes, xRes] = await Promise.all([
        fetch(`/api/medications${qs}`),
        fetch(`/api/alerts${qs}`),
        fetch(`/api/dose-events${eventsQs}`),
        fetch(`/api/exposure${qs}`),
      ]);
      if (mRes.status === 401) {
        router.replace("/login");
        return;
      }
      if (mRes.ok) {
        const data = await mRes.json();
        setMeds(data.medications ?? []);
        setProfileName(data.profile?.name ?? "");
      }
      if (aRes.ok) setAlerts((await aRes.json()).alerts ?? []);
      if (eRes.ok) setEvents((await eRes.json()).events ?? []);
      if (xRes.ok) setExposure((await xRes.json()).exposure ?? null);
      setLoaded(true);
    })();
  }, [patientParam, router]);

  const active = meds.filter((m) => m.status === "active");
  const stopped = meds.filter((m) => m.status === "stopped");

  const adherence = new Map<number, { taken: number; late: number; skipped: number }>();
  for (const e of events) {
    if (!adherence.has(e.medication_id)) adherence.set(e.medication_id, { taken: 0, late: 0, skipped: 0 });
    adherence.get(e.medication_id)![e.status]++;
  }

  return (
    <div className="mx-auto max-w-3xl bg-white px-8 py-8 text-slate-900 print:px-0">
      <div className="mb-6 flex items-center justify-between print:hidden">
        <Link
          href={patientParam ? `/clinic/patient/${patientParam}` : "/"}
          className="text-sm text-indigo-600 underline"
        >
          ← Back to app
        </Link>
        <button
          onClick={() => window.print()}
          className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700"
        >
          Print / Save as PDF
        </button>
      </div>

      <h1 className="text-xl font-bold">
        Medication report — {profileName ? titleCase(profileName) : "…"}
      </h1>
      <p className="text-xs text-slate-500">
        Generated {new Date().toLocaleString()} · GanderMed (prototype) · For review with a
        pharmacist or prescriber
      </p>

      {!loaded ? (
        <p className="mt-8 text-sm text-slate-400">Loading…</p>
      ) : (
        <>
          <h2 className="mt-6 border-b border-slate-300 pb-1 text-sm font-bold uppercase tracking-wide">
            Current medications ({active.length})
          </h2>
          {active.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">None recorded.</p>
          ) : (
            <table className="mt-2 w-full border-collapse text-xs">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="border-b border-slate-200 py-1 pr-2 font-semibold">Product</th>
                  <th className="border-b border-slate-200 py-1 pr-2 font-semibold">Active ingredients</th>
                  <th className="border-b border-slate-200 py-1 pr-2 font-semibold">Dose & route</th>
                  <th className="border-b border-slate-200 py-1 pr-2 font-semibold">Schedule</th>
                  <th className="border-b border-slate-200 py-1 font-semibold">Started</th>
                </tr>
              </thead>
              <tbody>
                {active.map((m) => (
                  <tr key={m.id} className="align-top">
                    <td className="border-b border-slate-100 py-1.5 pr-2">
                      <span className="font-semibold">{titleCase(m.brand_name)}</span>
                      <br />
                      <span className="text-slate-500">
                        {m.verified ? `DIN ${m.din}` : "Unverified entry — not safety-checked"}
                        {m.provenance ? ` · ${PROVENANCE_LABELS[m.provenance]}` : ""}
                      </span>
                      {m.actual_use && m.actual_use !== "taking" && (
                        <>
                          <br />
                          <span className="font-semibold text-amber-700">
                            Patient-reported: {ACTUAL_USE_LABELS[m.actual_use]}
                          </span>
                        </>
                      )}
                      {m.patient_notes && (
                        <>
                          <br />
                          <span className="italic text-amber-700">“{m.patient_notes}”</span>
                        </>
                      )}
                    </td>
                    <td className="border-b border-slate-100 py-1.5 pr-2">
                      {m.ingredients.length
                        ? m.ingredients
                            .map(
                              (i) =>
                                `${titleCase(i.ingredient_name)}${i.strength ? ` ${i.strength} ${i.strength_unit ?? ""}` : ""}`
                            )
                            .join(", ")
                        : "—"}
                    </td>
                    <td className="border-b border-slate-100 py-1.5 pr-2">
                      {m.dose_value != null ? `${m.dose_value} ${m.dose_unit ?? ""}` : "—"}
                      {m.route ? ` · ${m.route}` : ""}
                      {m.instructions ? (
                        <>
                          <br />
                          <span className="italic text-slate-500">{m.instructions}</span>
                        </>
                      ) : null}
                    </td>
                    <td className="border-b border-slate-100 py-1.5 pr-2">
                      {scheduleLabel(m.is_prn, m.schedule_times)}
                    </td>
                    <td className="border-b border-slate-100 py-1.5">
                      {fmtDate(m.start_date ?? m.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {stopped.length > 0 && (
            <>
              <h2 className="mt-6 border-b border-slate-300 pb-1 text-sm font-bold uppercase tracking-wide">
                Recently stopped
              </h2>
              <ul className="mt-2 space-y-1 text-xs">
                {stopped.map((m) => (
                  <li key={m.id}>
                    <span className="font-semibold">{titleCase(m.brand_name)}</span>
                    {m.din ? ` (DIN ${m.din})` : ""} — stopped {fmtDate(m.end_date)}
                  </li>
                ))}
              </ul>
            </>
          )}

          <h2 className="mt-6 border-b border-slate-300 pb-1 text-sm font-bold uppercase tracking-wide">
            Safety alerts ({alerts.length})
          </h2>
          {alerts.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">
              No conflicts detected among checked medications (demonstration ruleset).
            </p>
          ) : (
            <div className="mt-2 space-y-3">
              {alerts.map((a) => {
                const meta = SEVERITY_META[a.severity as Severity] ?? SEVERITY_META.minor;
                return (
                  <div key={a.id} className="rounded-lg border border-slate-200 p-3 text-xs">
                    <p>
                      <span className={`mr-2 rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase ${meta.badge}`}>
                        {meta.label}
                      </span>
                      <span className="font-semibold">
                        {titleCase(a.med_a_name)} + {titleCase(a.med_b_name)}
                      </span>{" "}
                      <span className="text-slate-500">
                        (
                        {a.kind === "duplicate"
                          ? `both contain ${titleCase(a.ingredient_a)}`
                          : `${titleCase(a.ingredient_a)} × ${titleCase(a.ingredient_b)}`}
                        )
                      </span>
                    </p>
                    <p className="mt-1">{a.description}</p>
                    <p className="mt-1 text-slate-500">
                      Evidence: {EVIDENCE_LABEL[a.evidence as Evidence] ?? a.evidence} · Source:{" "}
                      {a.source} (v{a.source_version}) · Flagged {fmtDate(a.created_at)} ·{" "}
                      {a.acknowledged_at
                        ? `Acknowledged by user ${fmtDate(a.acknowledged_at)}`
                        : "Not yet acknowledged"}
                      {a.exposure_status ? ` · ${EXPOSURE_LABEL[a.exposure_status]}` : ""}
                    </p>
                    {a.review && (
                      <p className="mt-1 font-medium text-teal-800">
                        ✓ Reviewed by {a.review.reviewer_name}
                        {a.review.reviewer_clinic ? ` (${a.review.reviewer_clinic})` : ""} on{" "}
                        {fmtDate(a.review.created_at)}, valid until {fmtDate(a.review.expires_at)}:{" "}
                        &ldquo;{a.review.note}&rdquo;
                      </p>
                    )}
                    <ul className="mt-1.5 list-disc pl-5 text-slate-600">
                      {pharmacistQuestions(a).map((q, i) => (
                        <li key={i}>{q}</li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}

          {exposure && exposure.totals.length > 0 && (
            <>
              <h2 className="mt-6 border-b border-slate-300 pb-1 text-sm font-bold uppercase tracking-wide">
                Estimated 24-hour ingredient totals (at generation time)
              </h2>
              <ul className="mt-2 space-y-1 text-xs">
                {exposure.totals.map((t) => (
                  <li key={t.ingredient}>
                    <span className="font-semibold">{titleCase(t.ingredient)}</span>: {t.total_mg} mg
                    {t.max_daily_mg ? ` of ${t.max_daily_mg} mg usual daily maximum` : ""}
                    {t.over ? " — EXCEEDED" : ""} (
                    {t.sources
                      .map((s) => `${titleCase(s.brand_name)} ${s.mg} mg at ${fmtTime(s.at)}`)
                      .join(", ")}
                    )
                    {t.uncounted.length > 0
                      ? ` — plus uncounted doses: ${t.uncounted.map((u) => titleCase(u.brand_name)).join(", ")}`
                      : ""}
                  </li>
                ))}
              </ul>
            </>
          )}

          <h2 className="mt-6 border-b border-slate-300 pb-1 text-sm font-bold uppercase tracking-wide">
            Dose log — last 14 days
          </h2>
          {adherence.size === 0 ? (
            <p className="mt-2 text-sm text-slate-500">No doses logged.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-xs">
              {[...adherence.entries()].map(([medId, counts]) => {
                const med = meds.find((m) => m.id === medId);
                return (
                  <li key={medId}>
                    <span className="font-semibold">{titleCase(med?.brand_name ?? `#${medId}`)}</span>:{" "}
                    {counts.taken} taken on time, {counts.late} late, {counts.skipped} skipped
                  </li>
                );
              })}
            </ul>
          )}

          <h2 className="mt-6 border-b border-slate-300 pb-1 text-sm font-bold uppercase tracking-wide">
            Questions for my pharmacist
          </h2>
          <div className="mt-4 space-y-6">
            <div className="border-b border-slate-300" />
            <div className="border-b border-slate-300" />
            <div className="border-b border-slate-300" />
          </div>

          <p className="mt-8 text-[10px] leading-relaxed text-slate-400">
            Sources: product identification from Health Canada&apos;s Drug Product Database (queried
            live); conflict screening from a curated demonstration ruleset (v{RULESET_VERSION}) and
            the DDInter open-access dataset where imported (each alert cites its source) — not a
            licensed clinical interaction database.
            Generated by GanderMed, a prototype. This report is informational, may be
            incomplete, and is not medical advice. Medication decisions should only be made with a
            pharmacist or prescriber.
          </p>
        </>
      )}
    </div>
  );
}
