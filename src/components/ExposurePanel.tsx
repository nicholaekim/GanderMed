"use client";

import type { ExposureReport } from "@/lib/types";
import { titleCase } from "@/lib/normalize";
import { fmtTime, fmtWhen } from "@/lib/format";

export default function ExposurePanel({ exposure }: { exposure: ExposureReport | null }) {
  if (!exposure) return null;
  const { active_now, totals } = exposure;
  if (active_now.length === 0 && totals.length === 0) return null;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold">Right now</h2>
      <p className="mt-0.5 text-xs text-slate-500">
        Estimated from the doses you actually logged — not a concentration model.
      </p>

      {active_now.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Estimated active ingredients
          </p>
          <ul className="mt-1.5 space-y-1">
            {active_now.map((a) => (
              <li key={a.ingredient} className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">{titleCase(a.ingredient)}</span>
                <span className="text-xs text-slate-500">
                  active until ~{fmtWhen(a.until)}
                  {a.sources.length > 1 ? ` · ${a.sources.length} products` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {totals.length > 0 && (
        <div className="mt-4 border-t border-slate-100 pt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Rolling 24-hour totals
          </p>
          <div className="mt-2 space-y-3">
            {totals.map((t) => {
              const pct = t.max_daily_mg ? Math.min(100, (t.total_mg / t.max_daily_mg) * 100) : 0;
              return (
                <div key={t.ingredient}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="font-medium">{titleCase(t.ingredient)}</span>
                    <span className={`text-xs font-semibold ${t.over ? "text-red-600" : "text-slate-600"}`}>
                      {t.total_mg} / {t.max_daily_mg} mg
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full rounded-full ${t.over ? "bg-red-500" : pct > 75 ? "bg-amber-500" : "bg-emerald-500"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  {t.over && (
                    <p className="mt-1.5 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-800">
                      <strong>Over the usual daily maximum.</strong> Don&apos;t take more{" "}
                      {titleCase(t.ingredient)} today, and contact your pharmacist — or urgent care if
                      you feel unwell.
                    </p>
                  )}
                  <p className="mt-1 text-[11px] text-slate-400">
                    {t.sources
                      .map((s) => `${titleCase(s.brand_name)} ${s.mg} mg at ${fmtTime(s.at)}`)
                      .join(" · ")}
                  </p>
                  {t.uncounted.length > 0 && (
                    <p className="mt-1 text-[11px] text-amber-700">
                      Not counted: {t.uncounted.map((u) => `${titleCase(u.brand_name)} (${u.reason})`).join("; ")} — total may be
                      higher than shown.
                    </p>
                  )}
                  {t.note && <p className="mt-1 text-[11px] text-slate-400">{t.note}</p>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <p className="mt-3 border-t border-slate-100 pt-2 text-[10px] leading-relaxed text-slate-400">
        Demo exposure windows ({exposure.version}); duration varies by person and formulation.
        Extended-release products aren&apos;t window-modeled. Totals only include doses logged in this
        app.
      </p>
    </section>
  );
}
