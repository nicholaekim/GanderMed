"use client";

// Adherence display shared by the clinic record and (inline) the dashboard.
// Golden rule mirrored from the engine: "no data" is rendered as exactly
// that — a missing percentage is never shown as 0%.

import type { AdherenceReport } from "@/lib/adherence";
import { titleCase } from "@/lib/normalize";

export function pctBadgeClass(pct: number | null): string {
  if (pct === null) return "bg-slate-100 text-slate-500";
  if (pct >= 90) return "bg-emerald-100 text-emerald-800";
  if (pct >= 70) return "bg-amber-100 text-amber-800";
  return "bg-red-100 text-red-800";
}

export default function AdherenceCard({ adherence }: { adherence: AdherenceReport | null }) {
  if (!adherence) return null;
  const { overall, per_med, window_days } = adherence;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">Adherence — last {window_days} days</h2>
        <span className={`rounded-full px-2.5 py-0.5 text-sm font-bold ${pctBadgeClass(overall.adherence_pct)}`}>
          {overall.adherence_pct === null ? "no data" : `${overall.adherence_pct}%`}
        </span>
      </div>
      {overall.expected_due > 0 ? (
        <p className="mt-0.5 text-xs text-slate-500">
          {overall.counts.on_time} on time · {overall.counts.late} late · {overall.counts.skipped} skipped ·{" "}
          <span className={overall.counts.missed > 0 ? "font-semibold text-red-600" : ""}>
            {overall.counts.missed} missed
          </span>
          {overall.unscheduled_doses > 0 ? ` · ${overall.unscheduled_doses} as-needed/unscheduled` : ""}
        </p>
      ) : (
        <p className="mt-0.5 text-xs text-slate-500">
          No scheduled doses were due in this window
          {overall.unscheduled_doses > 0 ? ` — ${overall.unscheduled_doses} as-needed dose(s) logged` : ""}.
        </p>
      )}

      {per_med.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {per_med.map((m) => (
            <li key={m.medication_id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className={m.med_status === "stopped" ? "text-slate-400 line-through" : "font-medium"}>
                {titleCase(m.brand_name)}
                {m.is_prn && <span className="ml-1 rounded bg-slate-100 px-1 py-0.5 text-[10px] text-slate-500">PRN</span>}
              </span>
              <span className="text-slate-500">
                {m.is_prn ? (
                  `${m.unscheduled_doses} dose${m.unscheduled_doses === 1 ? "" : "s"} taken as needed`
                ) : m.expected_due === 0 ? (
                  "no doses due yet"
                ) : (
                  <>
                    {m.counts.on_time + m.counts.late}/{m.expected_due} taken
                    {m.counts.missed > 0 && <span className="text-red-600"> · {m.counts.missed} missed</span>}
                    <span className={`ml-1.5 rounded-full px-1.5 py-0.5 font-semibold ${pctBadgeClass(m.adherence_pct)}`}>
                      {m.adherence_pct === null ? "–" : `${m.adherence_pct}%`}
                    </span>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 border-t border-slate-100 pt-2 text-[10px] leading-relaxed text-slate-400">
        Formula: {adherence.formula} Missed = nothing logged and more than an hour past the scheduled
        time; a later log updates the numbers. As-needed (PRN) medications are never counted as missed.
      </p>
    </section>
  );
}
