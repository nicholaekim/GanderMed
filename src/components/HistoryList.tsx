"use client";

import type { DoseEvent } from "@/lib/types";
import { titleCase } from "@/lib/normalize";
import { fmtTime, todayStr } from "@/lib/format";

const STATUS_CHIP: Record<DoseEvent["status"], string> = {
  taken: "bg-emerald-100 text-emerald-700",
  late: "bg-amber-100 text-amber-700",
  skipped: "bg-slate-200 text-slate-500",
};

export default function HistoryList({ events }: { events: DoseEvent[] }) {
  if (events.length === 0) {
    return (
      <section>
        <h2 className="mb-2 text-base font-semibold">Dose history</h2>
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
          No doses logged yet — use the Today panel to log your first one.
        </p>
      </section>
    );
  }

  const byDay = new Map<string, DoseEvent[]>();
  for (const e of events) {
    const d = new Date(e.logged_at);
    const p = (n: number) => String(n).padStart(2, "0");
    const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(e);
  }

  const today = todayStr();
  const yesterday = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  })();

  return (
    <section>
      <h2 className="mb-2 text-base font-semibold">Dose history (14 days)</h2>
      <div className="space-y-3">
        {[...byDay.entries()].map(([day, dayEvents]) => (
          <div key={day} className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              {day === today
                ? "Today"
                : day === yesterday
                  ? "Yesterday"
                  : new Date(`${day}T00:00`).toLocaleDateString(undefined, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                    })}
            </p>
            <ul className="mt-1.5 space-y-1">
              {dayEvents.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="w-16 text-xs tabular-nums text-slate-400">{fmtTime(e.logged_at)}</span>
                  <span className="font-medium">{titleCase(e.brand_name ?? "")}</span>
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ${STATUS_CHIP[e.status]}`}>
                    {e.status}
                  </span>
                  {e.dose_value != null && (
                    <span className="text-xs text-slate-500">
                      {e.dose_value} {e.dose_unit ?? ""}
                    </span>
                  )}
                  {e.scheduled_at && (
                    <span className="text-[11px] text-slate-400">
                      scheduled {e.scheduled_at.slice(11, 16)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
