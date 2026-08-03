"use client";

import type { DoseEvent, Medication } from "@/lib/types";
import { titleCase } from "@/lib/normalize";
import { todayStr } from "@/lib/format";

export default function TodaySchedule({
  meds,
  events,
  onLog,
}: {
  meds: Medication[];
  events: DoseEvent[];
  onLog: (medicationId: number, scheduledAt: string | null, action: "taken" | "skipped") => void;
}) {
  const today = todayStr();
  const active = meds.filter((m) => m.status === "active");
  const now = new Date();

  const eventBySlot = new Map<string, DoseEvent>();
  for (const e of events) {
    if (e.scheduled_at?.startsWith(today)) eventBySlot.set(`${e.medication_id}|${e.scheduled_at}`, e);
  }

  const scheduled = active.filter((m) => !m.is_prn);
  const prn = active.filter((m) => m.is_prn);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold">Today</h2>
      {active.length === 0 && (
        <p className="mt-2 text-sm text-slate-500">No active medications yet — add one above.</p>
      )}

      <div className="mt-3 space-y-3">
        {scheduled.map((m) => {
          let times: string[] = [];
          try {
            times = JSON.parse(m.schedule_times);
          } catch {}
          return (
            <div key={m.id}>
              <p className="text-sm font-medium">{titleCase(m.brand_name)}</p>
              {times.length === 0 ? (
                <p className="text-xs text-slate-400">No schedule set.</p>
              ) : (
                // One row per dose slot. Take/Skip are the controls this app
                // is tapped for every day, often by older users on a phone,
                // so they stay at a 44px touch target.
                <div className="mt-1.5 space-y-1.5">
                  {times.map((t) => {
                    const slot = `${today}T${t}`;
                    const ev = eventBySlot.get(`${m.id}|${slot}`);
                    const isPast = new Date(slot) < now;
                    if (ev) {
                      const style =
                        ev.status === "taken"
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : ev.status === "late"
                            ? "border-amber-200 bg-amber-50 text-amber-700"
                            : "border-slate-200 bg-slate-50 text-slate-400";
                      const label =
                        ev.status === "taken" ? "Taken ✓" : ev.status === "late" ? "Taken late ✓" : "Skipped";
                      return (
                        <div
                          key={t}
                          className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm ${style}`}
                        >
                          <span className={ev.status === "skipped" ? "line-through" : ""}>{t}</span>
                          <span className="text-xs font-medium">{label}</span>
                        </div>
                      );
                    }
                    return (
                      <div
                        key={t}
                        className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5 ${
                          isPast ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white"
                        }`}
                      >
                        <span className="text-sm text-slate-700">
                          {t}
                          {isPast && <span className="ml-1.5 text-xs font-semibold text-amber-800">due</span>}
                        </span>
                        <span className="flex gap-1.5">
                          <button
                            onClick={() => onLog(m.id, slot, "taken")}
                            className="min-h-11 rounded-lg bg-emerald-600 px-4 text-xs font-semibold text-white hover:bg-emerald-700"
                          >
                            Take
                          </button>
                          <button
                            onClick={() => onLog(m.id, slot, "skipped")}
                            className="min-h-11 rounded-lg bg-slate-100 px-4 text-xs font-semibold text-slate-600 hover:bg-slate-200"
                          >
                            Skip
                          </button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {prn.length > 0 && (
          <div className="border-t border-slate-100 pt-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">As needed</p>
            <div className="mt-1.5 space-y-1.5">
              {prn.map((m) => (
                <div key={m.id} className="flex items-center justify-between gap-2">
                  <span className="text-sm">{titleCase(m.brand_name)}</span>
                  <button
                    onClick={() => onLog(m.id, null, "taken")}
                    className="min-h-11 shrink-0 rounded-lg bg-emerald-600 px-4 text-xs font-semibold text-white hover:bg-emerald-700"
                  >
                    Log dose now
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
