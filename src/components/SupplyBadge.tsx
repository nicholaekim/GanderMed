"use client";

// Renders a medication's supply status. The point of this component is the
// distinction most apps get wrong: "we checked and nothing is reported" and
// "we never checked" must never look the same.

import type { ShortageLookup } from "@/lib/shortages";
import { fmtDate } from "@/lib/format";

export default function SupplyBadge({ supply, compact }: { supply: ShortageLookup | undefined; compact?: boolean }) {
  if (!supply) return null;

  if (supply.state === "not_configured") {
    return (
      <span className="rounded-full border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500">
        Supply not checked
      </span>
    );
  }
  if (supply.state === "not_checkable") {
    return (
      <span
        title={supply.why}
        className="rounded-full border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500"
      >
        Supply can&apos;t be checked
      </span>
    );
  }
  if (supply.state === "never_checked") {
    return (
      <span
        title="Nobody has looked this product up in Health Canada's shortage database yet."
        className="rounded-full border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500"
      >
        Supply not checked yet
      </span>
    );
  }

  const open = supply.reports.filter((r) => r.state !== "resolved");
  if (open.length === 0) {
    return (
      <span
        title={`Health Canada listed no open shortage or discontinuation report when this was checked on ${fmtDate(supply.as_of)}.`}
        className={`rounded-full border px-1.5 py-0.5 text-[11px] font-medium ${
          supply.stale
            ? "border-slate-200 bg-slate-100 text-slate-500"
            : "border-emerald-200 bg-emerald-50 text-emerald-700"
        }`}
      >
        No shortage reported{supply.stale ? ` (as of ${fmtDate(supply.as_of)})` : ""}
      </span>
    );
  }

  const discontinued = open.some((r) => r.kind === "discontinuation");
  const anticipated = !discontinued && open.every((r) => r.state === "anticipated");
  const label = discontinued ? "Discontinued" : anticipated ? "Shortage anticipated" : "Supply shortage";
  const detail = open[0];

  return (
    <span
      title={[
        detail.reason,
        detail.estimated_end_date ? `Estimated end ${detail.estimated_end_date}` : null,
        `Reported to Health Canada · checked ${fmtDate(supply.as_of)}`,
      ]
        .filter(Boolean)
        .join(" · ")}
      className={`rounded-full border px-1.5 py-0.5 text-[11px] font-semibold ${
        discontinued ? "border-red-300 bg-red-50 text-red-800" : "border-amber-300 bg-amber-50 text-amber-900"
      }`}
    >
      {label}
      {!compact && supply.stale ? " (data may be out of date)" : ""}
    </span>
  );
}
