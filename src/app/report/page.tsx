"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ACTUAL_USE_LABELS, DISPOSITION_LABELS, PROVENANCE_LABELS, type AccessGrantView, type Alert, type Disposition, type DoseEvent, type ExposureReport, type Medication, type Severity } from "@/lib/types";
import type { AdherenceReport } from "@/lib/adherence";
import type { ShortageLookup } from "@/lib/shortages";
import { EXPOSURE_VERSION } from "@/data/ingredientProfiles";
import { EVIDENCE_LABEL, SEVERITY_META, fmtDate, fmtTime, scheduleLabel } from "@/lib/format";
import { titleCase } from "@/lib/normalize";
import { pharmacistQuestions } from "@/lib/questions";
import { RULESET_VERSION } from "@/data/interactionRules";
import type { Evidence } from "@/lib/types";

/** Prints an open Health Canada supply report, if one was actually retrieved. */
function SupplyReportLine({ supply }: { supply: ShortageLookup | undefined }) {
  if (!supply || supply.state !== "checked") return null;
  const open = supply.reports.filter((r) => r.state !== "resolved");
  if (open.length === 0) return null;
  const first = open[0];
  return (
    <>
      <br />
      <span className="font-semibold text-amber-800">
        Health Canada supply report:{" "}
        {first.kind === "discontinuation" ? "discontinued by the manufacturer" : `shortage (${first.status})`}
        {first.estimated_end_date ? `, estimated end ${first.estimated_end_date}` : ""} — checked {fmtDate(supply.as_of)}
      </span>
    </>
  );
}

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
  const [adherence, setAdherence] = useState<AdherenceReport | null>(null);
  const [lastReconciled, setLastReconciled] = useState<{
    completed_at: string;
    clinician_name: string;
    clinic_name: string | null;
    disposed: number;
    meds_total: number | null;
    summary_note: string | null;
  } | null>(null);
  const [dispositions, setDispositions] = useState<
    Map<number, { disposition: Disposition; note: string | null; disposed_by_name: string | null; disposed_at: string | null }>
  >(new Map());
  const [accessGrants, setAccessGrants] = useState<AccessGrantView[]>([]);
  const [supply, setSupply] = useState<Record<number, ShortageLookup>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const qs = patientParam ? `?patient=${patientParam}` : "";
      const eventsQs = patientParam ? `?patient=${patientParam}&days=14` : "?days=14";
      const [mRes, aRes, eRes, xRes, adRes, rRes, sRes] = await Promise.all([
        fetch(`/api/medications${qs}`),
        fetch(`/api/alerts${qs}`),
        fetch(`/api/dose-events${eventsQs}`),
        fetch(`/api/exposure${qs}`),
        fetch(`/api/adherence${eventsQs}`),
        fetch(`/api/reconcile${qs}`),
        fetch(`/api/shortages${qs}`),
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
      if (adRes.ok) setAdherence((await adRes.json()).adherence ?? null);
      if (rRes.ok) {
        const rData = await rRes.json();
        setLastReconciled(rData.last_completed ?? null);
        setDispositions(
          new Map(
            (rData.last_completed_items ?? []).map(
              (i: { medication_id: number; disposition: Disposition; note: string | null; disposed_by_name: string | null; disposed_at: string | null }) => [
                i.medication_id,
                i,
              ]
            )
          )
        );
      }
      if (sRes.ok) {
        const sData = (await sRes.json()) as { medications: { medication_id: number; supply: ShortageLookup }[] };
        setSupply(Object.fromEntries(sData.medications.map((m) => [m.medication_id, m.supply])));
      }
      // Consent context is shown only on the patient's own report — a
      // clinician printing it sees the reconciliation line, not other
      // clinicians' grants.
      if (!patientParam) {
        const acRes = await fetch("/api/access");
        if (acRes.ok) setAccessGrants(((await acRes.json()).grants ?? []) as AccessGrantView[]);
      }
      setLoaded(true);
    })();
  }, [patientParam, router]);

  const active = meds.filter((m) => m.status === "active");
  const stopped = meds.filter((m) => m.status === "stopped");

  return (
    <div className="mx-auto max-w-3xl bg-white px-4 py-8 text-slate-900 sm:px-8 print:px-0">
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
      {lastReconciled && (
        <p className="mt-1 text-xs font-medium text-violet-800">
          Last pharmacist reconciliation: {fmtDate(lastReconciled.completed_at)} by{" "}
          {titleCase(lastReconciled.clinician_name)}
          {lastReconciled.clinic_name ? ` (${titleCase(lastReconciled.clinic_name)})` : ""} —{" "}
          {lastReconciled.disposed} of {lastReconciled.meds_total ?? "?"} medications reviewed
          {lastReconciled.summary_note ? ` · “${lastReconciled.summary_note}”` : ""}
        </p>
      )}

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
            // Wide tables scroll inside themselves so the page never does.
            <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[34rem] border-collapse text-xs sm:min-w-0">
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
                      <SupplyReportLine supply={supply[m.id]} />
                      {dispositions.has(m.id) && (
                        <>
                          <br />
                          <span className="font-semibold text-violet-800">
                            Reconciliation: {DISPOSITION_LABELS[dispositions.get(m.id)!.disposition]}
                            {dispositions.get(m.id)!.disposed_by_name
                              ? ` — ${dispositions.get(m.id)!.disposed_by_name}, ${fmtDate(dispositions.get(m.id)!.disposed_at)}`
                              : ""}
                          </span>
                          {dispositions.get(m.id)!.note && (
                            <span className="block italic text-violet-700">“{dispositions.get(m.id)!.note}”</span>
                          )}
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
            </div>
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

          {!patientParam && (
            <>
              <h2 className="mt-6 border-b border-slate-300 pb-1 text-sm font-bold uppercase tracking-wide">
                Access &amp; consent
              </h2>
              {accessGrants.filter((g) => g.status === "active").length === 0 ? (
                <p className="mt-2 text-sm text-slate-500">
                  No care-team members currently have access to this record.
                </p>
              ) : (
                <ul className="mt-2 space-y-1 text-xs">
                  {accessGrants
                    .filter((g) => g.status === "active")
                    .map((g) => (
                      <li key={g.id}>
                        <span className="font-semibold">{titleCase(g.clinician_name)}</span>
                        {g.clinic_name ? ` (${titleCase(g.clinic_name)})` : ""} — {g.purpose ?? "no purpose stated"} ·
                        approved {fmtDate(g.starts_at)} ·{" "}
                        {g.expires_at ? `expires ${fmtDate(g.expires_at)}` : "no expiry"}
                      </li>
                    ))}
                </ul>
              )}
              <p className="mt-1 text-[10px] text-slate-400">
                Access is patient-controlled and revocable at any time; every record view is logged in
                the in-app audit trail.
              </p>
            </>
          )}

          <h2 className="mt-6 border-b border-slate-300 pb-1 text-sm font-bold uppercase tracking-wide">
            Adherence — last {adherence?.window_days ?? 14} days
          </h2>
          {!adherence || adherence.per_med.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">
              No scheduled doses were due and no doses were logged in this window.
            </p>
          ) : (
            <>
              <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[34rem] border-collapse text-xs sm:min-w-0">
                <thead>
                  <tr className="text-left text-slate-500">
                    <th className="border-b border-slate-200 py-1 pr-2 font-semibold">Medication</th>
                    <th className="border-b border-slate-200 py-1 pr-2 font-semibold">Expected</th>
                    <th className="border-b border-slate-200 py-1 pr-2 font-semibold">On time</th>
                    <th className="border-b border-slate-200 py-1 pr-2 font-semibold">Late</th>
                    <th className="border-b border-slate-200 py-1 pr-2 font-semibold">Skipped</th>
                    <th className="border-b border-slate-200 py-1 pr-2 font-semibold">Missed</th>
                    <th className="border-b border-slate-200 py-1 font-semibold">Adherence</th>
                  </tr>
                </thead>
                <tbody>
                  {adherence.per_med.map((m) => (
                    <tr key={m.medication_id}>
                      <td className="border-b border-slate-100 py-1 pr-2 font-semibold">
                        {titleCase(m.brand_name)}
                        {m.is_prn ? " (as needed)" : ""}
                        {m.med_status === "stopped" ? " (stopped)" : ""}
                      </td>
                      {m.is_prn ? (
                        <td colSpan={5} className="border-b border-slate-100 py-1 pr-2 text-slate-500">
                          {m.unscheduled_doses} dose{m.unscheduled_doses === 1 ? "" : "s"} taken as needed — PRN
                          medications have no expected schedule
                        </td>
                      ) : (
                        <>
                          <td className="border-b border-slate-100 py-1 pr-2">{m.expected_due}</td>
                          <td className="border-b border-slate-100 py-1 pr-2">{m.counts.on_time}</td>
                          <td className="border-b border-slate-100 py-1 pr-2">{m.counts.late}</td>
                          <td className="border-b border-slate-100 py-1 pr-2">{m.counts.skipped}</td>
                          <td className={`border-b border-slate-100 py-1 pr-2 ${m.counts.missed > 0 ? "font-bold text-red-700" : ""}`}>
                            {m.counts.missed}
                          </td>
                        </>
                      )}
                      <td className="border-b border-slate-100 py-1 font-semibold">
                        {m.is_prn ? "—" : m.adherence_pct === null ? "no data" : `${m.adherence_pct}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <p className="mt-1.5 text-[10px] text-slate-400">
                Overall: {adherence.overall.adherence_pct === null ? "no data" : `${adherence.overall.adherence_pct}%`} ·
                Formula: {adherence.formula} &ldquo;Missed&rdquo; = nothing logged and more than an hour past the
                scheduled time at generation; doses logged later update the report.
              </p>
            </>
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
            licensed clinical interaction database. Exposure windows: {EXPOSURE_VERSION} (typical
            adult half-lives / effect durations).
            Generated by GanderMed, a prototype. This report is informational, may be
            incomplete, and is not medical advice. Medication decisions should only be made with a
            pharmacist or prescriber.
          </p>
        </>
      )}
    </div>
  );
}
