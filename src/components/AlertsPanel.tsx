"use client";

import { useState } from "react";
import type { Alert, Severity } from "@/lib/types";
import { EVIDENCE_LABEL, SEVERITY_META, fmtDate } from "@/lib/format";
import { titleCase } from "@/lib/normalize";
import { pharmacistQuestions } from "@/lib/questions";
import type { Evidence } from "@/lib/types";

interface PanelProps {
  alerts: Alert[];
  onAck?: (id: number, val: boolean) => void;
  /** Hides patient actions (acknowledge) — used for care-team views. */
  readOnly?: boolean;
  /** Enables clinician review actions. */
  clinicianMode?: boolean;
  onReview?: (alertId: number, note: string, expiresDays: number) => Promise<boolean>;
  onWithdrawReview?: (reviewId: number) => void;
}

function ExposureBadge({ status }: { status?: Alert["exposure_status"] }) {
  if (status === "overlap") {
    return (
      <span className="rounded-full border border-red-300 bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-800">
        ⏱ Recorded doses likely overlapping (estimate)
      </span>
    );
  }
  if (status === "no_overlap") {
    return (
      <span
        className="rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500"
        title="Separating doses does not necessarily remove this interaction concern."
      >
        No overlap identified in recorded doses
      </span>
    );
  }
  if (status === "insufficient_data") {
    return (
      <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800">
        Not enough logged doses to assess timing
      </span>
    );
  }
  return null;
}

function ReviewBand({
  alert,
  clinicianMode,
  onWithdrawReview,
}: {
  alert: Alert;
  clinicianMode?: boolean;
  onWithdrawReview?: (reviewId: number) => void;
}) {
  const r = alert.review;
  if (!r) return null;
  return (
    <div className="mt-2 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2">
      <p className="text-xs font-semibold text-teal-800">
        ✓ Reviewed by {r.reviewer_name}
        {r.reviewer_clinic ? ` (${r.reviewer_clinic})` : ""} · {fmtDate(r.created_at)} · valid until{" "}
        {fmtDate(r.expires_at)}
      </p>
      <p className="mt-1 text-xs italic text-teal-900">&ldquo;{r.note}&rdquo;</p>
      {r.dose_changed_at && (
        <p className="mt-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs font-medium text-amber-900">
          ⚠ Dose or schedule changed {fmtDate(r.dose_changed_at)} — after this review was written. The
          review still applies to the product combination, but the change is worth re-confirming with
          your care team.
        </p>
      )}
      <p className="mt-1 text-[10px] text-teal-700/80">
        Re-alerts automatically if the products change, the ruleset updates, or this review expires.
      </p>
      {clinicianMode && onWithdrawReview && (
        <button
          onClick={() => onWithdrawReview(r.id)}
          className="mt-1 text-[11px] text-teal-700 underline hover:text-teal-900"
        >
          Withdraw review
        </button>
      )}
    </div>
  );
}

function ReviewForm({
  alertId,
  onReview,
}: {
  alertId: number;
  onReview: (alertId: number, note: string, expiresDays: number) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [days, setDays] = useState(90);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg border border-teal-300 bg-teal-50 px-3 py-1 text-xs font-medium text-teal-800 hover:bg-teal-100"
      >
        Mark as reviewed
      </button>
    );
  }
  return (
    <div className="mt-2 w-full rounded-lg border border-teal-200 bg-teal-50/60 p-3">
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="e.g. Combination intentional — INR monitored monthly. Patient counselled."
        className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs outline-none focus:border-teal-400"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs"
        >
          <option value={30}>Valid 30 days</option>
          <option value={90}>Valid 90 days</option>
          <option value={180}>Valid 180 days</option>
        </select>
        <button
          disabled={busy || note.trim().length < 5}
          onClick={async () => {
            setBusy(true);
            const ok = await onReview(alertId, note.trim(), days);
            setBusy(false);
            if (ok) setOpen(false);
          }}
          className="rounded-lg bg-teal-600 px-3 py-1 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save review"}
        </button>
        <button onClick={() => setOpen(false)} className="text-xs text-slate-500 underline">
          cancel
        </button>
      </div>
    </div>
  );
}

function AlertCard({
  alert,
  onAck,
  readOnly,
  clinicianMode,
  onReview,
  onWithdrawReview,
}: { alert: Alert } & Omit<PanelProps, "alerts">) {
  const meta = SEVERITY_META[alert.severity as Severity] ?? SEVERITY_META.minor;
  return (
    <div className={`relative overflow-hidden rounded-xl border p-4 ${meta.card}`}>
      <div className={`absolute inset-y-0 left-0 w-1.5 ${meta.bar}`} />
      <div className="pl-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${meta.badge}`}>
            {meta.label}
          </span>
          <span className="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600">
            {alert.kind === "duplicate" ? "Duplicate ingredient" : "Interaction"}
          </span>
          <span className="text-[11px] text-slate-500">
            Evidence: {EVIDENCE_LABEL[alert.evidence as Evidence] ?? alert.evidence}
          </span>
          {alert.concern_class === "planned" ? (
            <span className="rounded-full border border-violet-300 bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-800">
              Planned medication — not started
            </span>
          ) : alert.concern_class === "paused" ? (
            <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
              Involves a paused medication
            </span>
          ) : (
            <ExposureBadge status={alert.exposure_status} />
          )}
        </div>

        <h3 className="mt-2 text-sm font-semibold">
          {titleCase(alert.med_a_name)} <span className="text-slate-400">+</span>{" "}
          {titleCase(alert.med_b_name)}
        </h3>
        {alert.concern_class === "planned" && (
          <p className="mt-1 rounded-md border border-violet-200 bg-violet-50 px-2 py-1.5 text-xs text-violet-900">
            Potential concern involving a newly prescribed medication. The patient has not confirmed
            starting it, so this is not recorded active exposure — worth discussing before the first
            dose.
          </p>
        )}
        {alert.concern_class === "paused" && (
          <p className="mt-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
            One of these medications is temporarily paused, so this is not current co-use — but the
            combination becomes relevant again the moment it resumes.
          </p>
        )}
        <p className="text-xs text-slate-500">
          {alert.kind === "duplicate"
            ? `Both contain ${titleCase(alert.ingredient_a)}`
            : `${titleCase(alert.ingredient_a)} × ${titleCase(alert.ingredient_b)}`}
        </p>

        <p className="mt-2 text-sm leading-relaxed">{alert.description}</p>
        <p className="mt-2 text-sm">
          <span className="font-semibold">What to do: </span>
          {alert.recommended_action}
        </p>

        <ReviewBand alert={alert} clinicianMode={clinicianMode} onWithdrawReview={onWithdrawReview} />

        <details className="mt-2">
          <summary className="cursor-pointer text-xs font-medium text-indigo-700 hover:text-indigo-900">
            Questions to ask your pharmacist
          </summary>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-slate-700">
            {pharmacistQuestions(alert).map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </details>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-slate-400">
            {alert.source} · v{alert.source_version} · flagged {fmtDate(alert.created_at)}
          </p>
          <div className="flex items-center gap-2">
            {clinicianMode && onReview && !alert.review && (
              <ReviewForm alertId={alert.id} onReview={onReview} />
            )}
            {!readOnly && onAck && !alert.acknowledged_at && (
              <button
                onClick={() => onAck(alert.id, true)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Acknowledge
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AlertsPanel({
  alerts,
  onAck,
  readOnly,
  clinicianMode,
  onReview,
  onWithdrawReview,
}: PanelProps) {
  const [showAcked, setShowAcked] = useState(false);
  const open = alerts.filter((a) => !a.acknowledged_at && !a.review);
  const reviewed = alerts.filter((a) => a.review && !a.acknowledged_at);
  const acked = alerts.filter((a) => a.acknowledged_at);

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-base font-semibold">Safety alerts</h2>
        {open.length > 0 && (
          <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold text-white">
            {open.length}
          </span>
        )}
        {reviewed.length > 0 && (
          <span className="rounded-full bg-teal-600 px-2 py-0.5 text-xs font-bold text-white">
            {reviewed.length} reviewed
          </span>
        )}
      </div>

      {alerts.length === 0 ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-sm font-medium text-emerald-800">
            No conflicts detected among your checked medications.
          </p>
          <p className="mt-1 text-xs text-emerald-700/80">
            Only active medications matched to Health Canada&apos;s database are checked, against
            curated demo rules plus the DDInter dataset where imported — absence of an alert is not
            proof of safety.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {open.map((a) => (
            <AlertCard
              key={a.id}
              alert={a}
              onAck={onAck}
              readOnly={readOnly}
              clinicianMode={clinicianMode}
              onReview={onReview}
              onWithdrawReview={onWithdrawReview}
            />
          ))}

          {reviewed.length > 0 && (
            <div>
              <p className="mb-2 mt-1 text-xs font-semibold uppercase tracking-wide text-teal-700">
                Reviewed by {clinicianMode ? "care team" : "your care team"}
              </p>
              <div className="space-y-3 opacity-90">
                {reviewed.map((a) => (
                  <AlertCard
                    key={a.id}
                    alert={a}
                    onAck={onAck}
                    readOnly={readOnly}
                    clinicianMode={clinicianMode}
                    onReview={onReview}
                    onWithdrawReview={onWithdrawReview}
                  />
                ))}
              </div>
            </div>
          )}

          {acked.length > 0 && (
            <div>
              <button
                onClick={() => setShowAcked(!showAcked)}
                className="text-xs text-slate-500 underline hover:text-slate-700"
              >
                {showAcked ? "Hide" : "Show"} {acked.length} acknowledged alert
                {acked.length === 1 ? "" : "s"}
              </button>
              {showAcked && (
                <ul className="mt-2 space-y-1.5">
                  {acked.map((a) => {
                    const meta = SEVERITY_META[a.severity as Severity] ?? SEVERITY_META.minor;
                    return (
                      <li
                        key={a.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2"
                      >
                        <div className="flex items-center gap-2 text-xs text-slate-600">
                          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase ${meta.badge}`}>
                            {meta.label}
                          </span>
                          <span>
                            {titleCase(a.med_a_name)} + {titleCase(a.med_b_name)}
                          </span>
                          <span className="text-slate-400">ack. {fmtDate(a.acknowledged_at!)}</span>
                        </div>
                        {!readOnly && onAck && (
                          <button
                            onClick={() => onAck(a.id, false)}
                            className="text-[11px] text-slate-400 underline hover:text-slate-600"
                          >
                            Un-acknowledge
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
