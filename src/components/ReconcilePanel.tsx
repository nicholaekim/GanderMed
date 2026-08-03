"use client";

// The pharmacist's reconciliation workspace (MedsCheck prep). Flags are
// computed by the server and only inform; every judgment is a human
// disposition. Completing a session freezes it into the record's history.

import { useCallback, useEffect, useState } from "react";
import type { Medication } from "@/lib/types";
import type { DiscrepancyFlag, Disposition, SessionRow } from "@/lib/reconcile";
import { inReconWorkspace } from "@/lib/lifecycle";
import { titleCase } from "@/lib/normalize";
import { fmtDate, fmtDateTime, scheduleLabel } from "@/lib/format";

const DISPOSITION_OPTIONS: { value: Disposition; label: string }[] = [
  { value: "confirmed", label: "Confirmed correct as listed" },
  { value: "resolved", label: "Discrepancy resolved" },
  { value: "follow_up", label: "Needs follow-up" },
  { value: "patient_unsure", label: "Patient unsure — recheck" },
  { value: "referred", label: "Referred to prescriber" },
];

const FLAG_STYLE: Record<string, string> = {
  unverified: "border-amber-300 bg-amber-50 text-amber-900",
  not_taking: "border-red-300 bg-red-50 text-red-800",
  taking_differently: "border-amber-300 bg-amber-50 text-amber-900",
  recently_stopped: "border-amber-300 bg-amber-50 text-amber-900",
  patient_unsure: "border-amber-300 bg-amber-50 text-amber-900",
  missing_dose: "border-slate-300 bg-slate-100 text-slate-700",
  missing_schedule: "border-slate-300 bg-slate-100 text-slate-700",
  duplicate_ingredient: "border-red-300 bg-red-50 text-red-800",
  interaction_unreviewed: "border-red-300 bg-red-50 text-red-800",
  missed_doses: "border-amber-300 bg-amber-50 text-amber-900",
  patient_note: "border-sky-300 bg-sky-50 text-sky-900",
  supply_shortage: "border-amber-400 bg-amber-100 text-amber-900",
  supply_discontinued: "border-red-300 bg-red-50 text-red-800",
  not_received: "border-violet-300 bg-violet-50 text-violet-900",
  received_not_started: "border-violet-300 bg-violet-50 text-violet-900",
  declined_to_start: "border-red-300 bg-red-50 text-red-800",
  plan_cancelled: "border-slate-300 bg-slate-100 text-slate-700",
  paused: "border-amber-300 bg-amber-50 text-amber-900",
  dose_differs_from_prescription: "border-amber-400 bg-amber-100 text-amber-900",
  schedule_differs_from_prescription: "border-amber-400 bg-amber-100 text-amber-900",
  prescriber_instructions_missing: "border-slate-300 bg-slate-100 text-slate-700",
};

interface ItemView {
  medication_id: number;
  flags: DiscrepancyFlag[];
  disposition: Disposition | null;
  note: string | null;
  disposed_by_name: string | null;
  disposed_at: string | null;
}

export default function ReconcilePanel({ patientId, meds }: { patientId: number; meds: Medication[] }) {
  const [session, setSession] = useState<SessionRow | null>(null);
  const [items, setItems] = useState<ItemView[]>([]);
  const [lastCompleted, setLastCompleted] = useState<(SessionRow & { disposed: number }) | null>(null);
  const [drafts, setDrafts] = useState<Record<number, { disposition: Disposition | ""; note: string }>>({});
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/reconcile?patient=${patientId}`);
    if (!res.ok) return;
    const data = await res.json();
    setSession(data.session ?? null);
    setItems(data.items ?? []);
    setLastCompleted(data.last_completed ?? null);
  }, [patientId]);

  useEffect(() => {
    load();
  }, [load]);

  async function start() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/reconcile?patient=${patientId}`, { method: "POST" });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json()).error ?? "Could not start.");
      return;
    }
    load();
  }

  async function dispose(medId: number) {
    const draft = drafts[medId];
    if (!session || !draft?.disposition) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/reconcile/${session.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "dispose", medication_id: medId, disposition: draft.disposition, note: draft.note }),
    });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json()).error ?? "Could not save the disposition.");
      return;
    }
    setDrafts((d) => ({ ...d, [medId]: { disposition: "", note: "" } }));
    load();
  }

  async function complete() {
    if (!session) return;
    const undisposed = items.filter((i) => !i.disposition).length;
    const msg =
      undisposed > 0
        ? `Complete this reconciliation with ${undisposed} medication(s) not yet reviewed? The record will show partial coverage.`
        : "Complete this reconciliation?";
    if (!window.confirm(msg)) return;
    setBusy(true);
    const res = await fetch(`/api/reconcile/${session.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "complete", summary_note: summary }),
    });
    setBusy(false);
    if (res.ok) {
      setSummary("");
      load();
    }
  }

  // The workspace item list comes from the API (current + planned + plans
  // needing follow-up); resolve details from the full med set. The start
  // gate uses the SAME eligibility as the server's item list — a patient
  // whose only meds are unconfirmed plans still needs reconciling.
  const workspaceMeds = meds.filter((m) => inReconWorkspace(m));
  const medById = new Map(meds.map((m) => [m.id, m]));
  const disposedCount = items.filter((i) => i.disposition).length;

  return (
    <section className="rounded-2xl border border-violet-200 bg-violet-50/40 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Reconciliation (MedsCheck prep)</h2>
          <p className="mt-0.5 text-xs text-slate-600">
            Deterministic discrepancy flags per medication — the system never decides which list is
            correct; you record a disposition for each.
          </p>
        </div>
        {!session && (
          <button
            onClick={start}
            disabled={busy || workspaceMeds.length === 0}
            className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {lastCompleted ? "Start new reconciliation" : "Start reconciliation"}
          </button>
        )}
      </div>

      {lastCompleted && !session && (
        <p className="mt-2 rounded-lg border border-violet-200 bg-white px-3 py-2 text-xs text-slate-600">
          Last reconciled {fmtDateTime(lastCompleted.completed_at!)} by {lastCompleted.clinician_name}
          {lastCompleted.clinic_name ? ` (${lastCompleted.clinic_name})` : ""} — {lastCompleted.disposed} of{" "}
          {lastCompleted.meds_total} medication{lastCompleted.meds_total === 1 ? "" : "s"} reviewed
          {lastCompleted.summary_note ? ` · “${lastCompleted.summary_note}”` : ""}
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      {session && (
        <>
          <p className="mt-2 text-xs font-medium text-violet-800">
            Session open since {fmtDateTime(session.started_at)} · {disposedCount}/{items.length} reviewed
          </p>
          <div className="mt-3 space-y-3">
            {items.map((item) => {
              const med = medById.get(item.medication_id);
              if (!med) return null;
              const draft = drafts[item.medication_id] ?? { disposition: "" as const, note: "" };
              return (
                <div key={item.medication_id} className="rounded-xl border border-slate-200 bg-white p-3.5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">{titleCase(med.brand_name)}</p>
                      <p className="text-[11px] text-slate-500">
                        {med.verified ? `DIN ${med.din}` : "Unverified"} ·{" "}
                        {med.dose_value != null ? `${med.dose_value} ${med.dose_unit ?? ""} · ` : ""}
                        {scheduleLabel(med.is_prn, med.schedule_times)} · {med.provenance}
                      </p>
                      {med.ingredients.length > 0 && (
                        <p className="text-[11px] text-slate-400">
                          {med.ingredients.map((i) => titleCase(i.ingredient_name)).join(", ")}
                        </p>
                      )}
                    </div>
                    {item.disposition && (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">
                        {DISPOSITION_OPTIONS.find((o) => o.value === item.disposition)?.label} ·{" "}
                        {item.disposed_by_name} · {fmtDate(item.disposed_at!)}
                      </span>
                    )}
                  </div>

                  {item.flags.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {item.flags.map((f, i) => (
                        <span
                          key={`${f.code}-${i}`}
                          title={f.detail ?? undefined}
                          className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${FLAG_STYLE[f.code] ?? "border-slate-300 bg-slate-100 text-slate-700"}`}
                        >
                          {f.label}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-[11px] text-emerald-700">No discrepancies flagged.</p>
                  )}
                  {item.note && <p className="mt-1.5 text-[11px] italic text-slate-500">Note: {item.note}</p>}

                  <MedHistory medId={item.medication_id} patientId={patientId} />

                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <select
                      value={draft.disposition}
                      onChange={(e) =>
                        setDrafts((d) => ({
                          ...d,
                          [item.medication_id]: { ...draft, disposition: e.target.value as Disposition | "" },
                        }))
                      }
                      className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs"
                    >
                      <option value="">{item.disposition ? "Change disposition…" : "Choose disposition…"}</option>
                      {DISPOSITION_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <input
                      value={draft.note}
                      onChange={(e) =>
                        setDrafts((d) => ({ ...d, [item.medication_id]: { ...draft, note: e.target.value } }))
                      }
                      maxLength={500}
                      placeholder="Note (optional)"
                      className="min-w-40 flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
                    />
                    <button
                      onClick={() => dispose(item.medication_id)}
                      disabled={busy || !draft.disposition}
                      className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
                    >
                      Save
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-violet-200/70 pt-3">
            <input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              maxLength={1000}
              placeholder="Session summary (optional) — e.g. 2 discrepancies resolved, 1 referral"
              className="min-w-60 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-xs"
            />
            <button
              onClick={complete}
              disabled={busy}
              className="rounded-lg bg-slate-800 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
            >
              Complete reconciliation
            </button>
          </div>
          <p className="mt-1.5 text-[10px] text-slate-500">
            “Confirmed correct as listed” marks that medication as <strong>pharmacy-confirmed</strong> on
            the record; if the patient later changes its dose or schedule, it honestly reverts to
            patient-reported.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * Per-medication lifecycle timeline (who did what, when), fetched lazily on
 * expand from GET /api/medications/[id]/lifecycle.
 */
function MedHistory({ medId, patientId }: { medId: number; patientId: number }) {
  const [events, setEvents] = useState<
    { event_type: string; actor_role: string; actor_name: string | null; at: string }[] | null
  >(null);
  const [failed, setFailed] = useState(false);

  async function loadEvents() {
    if (events !== null || failed) return;
    const res = await fetch(`/api/medications/${medId}/lifecycle?patient=${patientId}`);
    if (!res.ok) {
      setFailed(true);
      return;
    }
    setEvents((await res.json()).events ?? []);
  }

  return (
    <details className="mt-1.5" onToggle={(e) => (e.target as HTMLDetailsElement).open && loadEvents()}>
      <summary className="cursor-pointer text-[11px] font-medium text-violet-700 hover:text-violet-900">
        Lifecycle history
      </summary>
      {failed ? (
        <p className="mt-1 text-[11px] text-slate-400">Could not load the timeline.</p>
      ) : events === null ? (
        <p className="mt-1 text-[11px] text-slate-400">Loading…</p>
      ) : events.length === 0 ? (
        <p className="mt-1 text-[11px] text-slate-400">No lifecycle events recorded (pre-lifecycle entry).</p>
      ) : (
        <ul className="mt-1 space-y-0.5 text-[11px] text-slate-600">
          {events.map((e, i) => (
            <li key={i}>
              <span className="text-slate-400">{fmtDateTime(e.at)}</span> — {e.event_type.replace(/_/g, " ")}{" "}
              <span className="text-slate-400">
                ({e.actor_name ?? e.actor_role}
                {e.actor_name ? `, ${e.actor_role}` : ""})
              </span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
