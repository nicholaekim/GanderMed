"use client";

// PHI-free pilot metrics for the clinician's own practice. Counts and
// medians only — and an explicit list of what isn't instrumented yet, so
// absence of a number is never mistaken for a zero.

import { useEffect, useState } from "react";
import type { PilotMetrics } from "@/lib/metrics";

const FUNNEL_ORDER = [
  "created",
  "opened",
  "intake_started",
  "intake_submitted",
  "consented",
  "reviewed",
  "denied",
  "expired",
  "cancelled",
];

const FUNNEL_LABEL: Record<string, string> = {
  created: "not opened",
  opened: "opened",
  intake_started: "intake started",
  intake_submitted: "list submitted",
  consented: "consented",
  reviewed: "reviewed",
  denied: "declined",
  expired: "expired",
  cancelled: "cancelled",
};

function Stat({ label, value, unit }: { label: string; value: number | string | null; unit?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
      <div className="text-lg font-bold text-slate-800">
        {value === null ? <span className="text-sm font-medium text-slate-400">no data</span> : value}
        {value !== null && unit ? <span className="ml-0.5 text-xs font-medium text-slate-400">{unit}</span> : null}
      </div>
      <div className="text-[11px] text-slate-500">{label}</div>
    </div>
  );
}

export default function MetricsPanel() {
  const [metrics, setMetrics] = useState<PilotMetrics | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || metrics) return;
    fetch("/api/metrics").then(async (r) => {
      if (r.ok) setMetrics((await r.json()).metrics ?? null);
    });
  }, [open, metrics]);

  return (
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between text-left">
        <div>
          <h2 className="text-sm font-semibold">Pilot metrics</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Your practice&apos;s numbers — aggregates only, no patient information. Computed live.
          </p>
        </div>
        <span className="text-xs text-slate-400 underline">{open ? "hide" : "show"}</span>
      </button>

      {open && !metrics && <p className="mt-3 text-xs text-slate-400">Loading…</p>}
      {open && metrics && (
        <div className="mt-4 space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Intake funnel</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {FUNNEL_ORDER.filter((s) => metrics.invitations.by_status[s]).map((s) => (
                <span key={s} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                  {metrics.invitations.by_status[s]} {FUNNEL_LABEL[s] ?? s}
                </span>
              ))}
              {metrics.invitations.total === 0 && (
                <span className="text-xs text-slate-400">No invitations yet.</span>
              )}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="invitations" value={metrics.invitations.total} />
              <Stat label="completion rate" value={metrics.invitations.completion_rate_pct} unit="%" />
              <Stat label="median invite → consent" value={metrics.invitations.median_hours_invite_to_consent} unit="h" />
              <Stat label="median consent → review" value={metrics.invitations.median_hours_consent_to_review} unit="h" />
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Reconciliation</p>
            <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="sessions completed" value={metrics.reconciliation.sessions_completed} />
              <Stat label="median time to complete" value={metrics.reconciliation.median_minutes_to_complete} unit="min" />
              <Stat label="avg discrepancy flags per med" value={metrics.reconciliation.avg_flags_per_reviewed_med} />
              <Stat
                label="follow-ups + referrals"
                value={(metrics.reconciliation.dispositions.follow_up ?? 0) + (metrics.reconciliation.dispositions.referred ?? 0)}
              />
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Patients &amp; safety</p>
            <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="active patient grants" value={metrics.patients.active_grants} />
              <Stat label="revoked / expired" value={`${metrics.patients.revoked_grants} / ${metrics.patients.expired_grants}`} />
              <Stat label="open interaction alerts" value={metrics.safety.open_interaction_alerts} />
              <Stat label="open duplicate alerts" value={metrics.safety.open_duplicate_alerts} />
              <Stat label="unverified medications" value={metrics.safety.unverified_medications} />
              <Stat label="active alert reviews" value={metrics.safety.active_reviews} />
            </div>
          </div>

          <p className="border-t border-slate-100 pt-2 text-[10px] leading-relaxed text-slate-400">
            Not instrumented yet (shown so a missing number is never read as zero):{" "}
            {metrics.not_instrumented.join("; ")}.
          </p>
        </div>
      )}
    </section>
  );
}
