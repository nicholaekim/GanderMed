"use client";

import { useEffect, useRef, useState } from "react";
import { ACTUAL_USE_LABELS, type Medication, type SearchResult } from "@/lib/types";
import { titleCase } from "@/lib/normalize";
import { fmtDate, scheduleLabel } from "@/lib/format";
import { DOSE_UNITS } from "@/components/AddMedication";

/**
 * Inline editor for the fields a patient may change: dose, schedule, PRN,
 * start date, instructions — plus the explicit Replace flow. Product identity
 * (brand/DIN/ingredients) is immutable by design; the server rejects it.
 */
function EditMedForm({ med, onDone }: { med: Medication; onDone: () => void }) {
  const [doseValue, setDoseValue] = useState(med.dose_value != null ? String(med.dose_value) : "");
  const [doseUnit, setDoseUnit] = useState(med.dose_unit ?? DOSE_UNITS[0]);
  const [isPrn, setIsPrn] = useState(med.is_prn === 1);
  const [times, setTimes] = useState<string[]>(() => {
    try {
      const t = JSON.parse(med.schedule_times) as string[];
      return t.length ? t : ["08:00"];
    } catch {
      return ["08:00"];
    }
  });
  const [startDate, setStartDate] = useState(med.start_date ?? "");
  const [instructions, setInstructions] = useState(med.instructions ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [replacing, setReplacing] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!replacing) return;
    const query = q.trim();
    if (query.length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setSearching(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: ctrl.signal });
        if (res.ok) setResults((await res.json()).results ?? []);
      } catch {
        // aborted or offline — keep previous results
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [q, replacing]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/medications/${med.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dose_value: doseValue === "" ? null : Number(doseValue),
          dose_unit: doseUnit,
          is_prn: isPrn,
          schedule_times: isPrn ? [] : times,
          start_date: startDate || null,
          instructions: instructions.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not save.");
        return;
      }
      onDone();
    } catch {
      setError("Network error — could not save.");
    } finally {
      setSaving(false);
    }
  }

  async function replaceWith(r: SearchResult) {
    if (
      !window.confirm(
        `Replace ${titleCase(med.brand_name)} with ${titleCase(r.brand_name)} (DIN ${r.din})?\n\nThe old entry is kept as stopped history, alerts re-check against the new product, and any care-team reviews re-alert. Double-check the dose afterwards — strengths can differ between products.`
      )
    )
      return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/medications/${med.id}/replace`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ drug_code: r.drug_code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not replace.");
        return;
      }
      onDone();
    } catch {
      setError("Network error — could not replace.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 space-y-2.5 border-t border-slate-100 pt-3">
      <div className="flex gap-2">
        <div className="w-20">
          <label className="text-[11px] font-medium text-slate-600">Dose</label>
          <input
            type="number"
            min="0"
            step="any"
            value={doseValue}
            onChange={(e) => setDoseValue(e.target.value)}
            className="mt-0.5 w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
          />
        </div>
        <div className="flex-1">
          <label className="text-[11px] font-medium text-slate-600">Unit</label>
          <select
            value={doseUnit}
            onChange={(e) => setDoseUnit(e.target.value)}
            className="mt-0.5 w-full rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs"
          >
            {[...new Set([doseUnit, ...DOSE_UNITS])].map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={isPrn} onChange={(e) => setIsPrn(e.target.checked)} />
        As needed (PRN) — no fixed schedule
      </label>

      {!isPrn && (
        <div>
          <label className="text-[11px] font-medium text-slate-600">Daily schedule</label>
          <div className="mt-0.5 space-y-1">
            {times.map((t, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="time"
                  value={t}
                  onChange={(e) => setTimes(times.map((x, j) => (j === i ? e.target.value : x)))}
                  className="rounded-lg border border-slate-300 px-2 py-0.5 text-xs"
                />
                {times.length > 1 && (
                  <button
                    onClick={() => setTimes(times.filter((_, j) => j !== i))}
                    className="text-xs text-slate-400 hover:text-red-500"
                    aria-label="Remove time"
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            <button onClick={() => setTimes([...times, "20:00"])} className="text-[11px] text-indigo-600 underline">
              + Add another time
            </button>
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <div className="flex-1">
          <label className="text-[11px] font-medium text-slate-600">Start date</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="mt-0.5 w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
          />
        </div>
        <div className="flex-[2]">
          <label className="text-[11px] font-medium text-slate-600">Instructions</label>
          <input
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            maxLength={500}
            placeholder="e.g. take with food"
            className="mt-0.5 w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
          />
        </div>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        <button
          onClick={() => setReplacing(!replacing)}
          className="text-[11px] text-slate-500 underline hover:text-slate-700"
        >
          {replacing ? "Hide replace" : med.verified ? "Replace product" : "Replace with a verified product"}
        </button>
      </div>

      {replacing && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
          <p className="text-[11px] text-slate-500">
            Switched brands or strengths? Pick the new product — the old entry stays in your history
            and safety checks re-run against the replacement.
          </p>
          <div className="relative mt-1.5">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search Health Canada (brand or DIN)"
              className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400"
            />
            {searching && <span className="absolute right-2 top-1.5 text-[10px] text-slate-400">searching…</span>}
          </div>
          {results.length > 0 && (
            <ul className="mt-1 max-h-44 overflow-auto rounded-lg border border-slate-200 bg-white">
              {results.map((r) => (
                <li key={r.din}>
                  <button
                    onClick={() => replaceWith(r)}
                    disabled={saving}
                    className="w-full px-2.5 py-1.5 text-left hover:bg-indigo-50 disabled:opacity-50"
                  >
                    <span className="block text-xs font-medium">{titleCase(r.brand_name)}</span>
                    <span className="block text-[10px] text-slate-500">
                      DIN {r.din} · {r.number_of_ais} ingredient{r.number_of_ais === 1 ? "" : "s"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function MedCard({
  med,
  onStop,
  onResume,
  onDelete,
  onChanged,
  readOnly,
}: {
  med: Medication;
  onStop?: (id: number) => void;
  onResume?: (id: number) => void;
  onDelete?: (id: number) => void;
  onChanged?: () => void;
  readOnly?: boolean;
}) {
  const stopped = med.status === "stopped";
  const [editing, setEditing] = useState(false);
  return (
    <div
      className={`rounded-xl border p-4 ${
        stopped ? "border-slate-200 bg-slate-50 opacity-70" : "border-slate-200 bg-white"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{titleCase(med.brand_name)}</h3>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
            {med.verified ? (
              <span className="rounded-full border border-slate-200 bg-slate-100 px-1.5 py-0.5 font-medium">
                DIN {med.din}
              </span>
            ) : (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 font-medium text-amber-800">
                Unverified — not safety-checked
              </span>
            )}
            {med.company_name && <span className="truncate">{titleCase(med.company_name)}</span>}
            {med.actual_use && med.actual_use !== "taking" && (
              <span
                className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 font-medium text-amber-800"
                title="Patient-reported — worth confirming at the next review"
              >
                {ACTUAL_USE_LABELS[med.actual_use]}
              </span>
            )}
          </div>
        </div>
        {!readOnly && (
          <div className="flex shrink-0 gap-1.5">
            {!stopped && (
              <button
                onClick={() => setEditing(!editing)}
                className={`rounded-lg border px-2 py-1 text-xs font-medium ${
                  editing
                    ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                    : "border-slate-300 bg-white hover:bg-slate-50"
                }`}
              >
                {editing ? "Close" : "Edit"}
              </button>
            )}
            {stopped ? (
              <button
                onClick={() => onResume?.(med.id)}
                className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-medium hover:bg-slate-50"
              >
                Resume
              </button>
            ) : (
              <button
                onClick={() => onStop?.(med.id)}
                className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-medium hover:bg-slate-50"
              >
                Stop
              </button>
            )}
            <button
              onClick={() => onDelete?.(med.id)}
              className="rounded-lg border border-red-200 bg-white px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
            >
              Delete
            </button>
          </div>
        )}
      </div>

      {med.ingredients.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {med.ingredients.map((ing) => (
            <span
              key={ing.id}
              className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700"
              title={`matched as "${ing.canonical_name}"`}
            >
              {titleCase(ing.ingredient_name)}
              {ing.strength ? ` ${ing.strength}${ing.strength_unit ? " " + ing.strength_unit : ""}` : ""}
            </span>
          ))}
        </div>
      )}

      <p className="mt-2 text-xs text-slate-600">
        {med.dose_value != null ? `${med.dose_value} ${med.dose_unit ?? ""} · ` : ""}
        {med.route ? `${med.route} · ` : ""}
        {scheduleLabel(med.is_prn, med.schedule_times)}
      </p>
      {med.instructions && <p className="mt-1 text-xs italic text-slate-500">{med.instructions}</p>}
      {med.patient_notes && (
        <p className="mt-1 text-xs italic text-amber-700">Patient note: {med.patient_notes}</p>
      )}
      <p className="mt-1 text-[11px] text-slate-400">
        {stopped
          ? `Stopped ${fmtDate(med.end_date)}${med.replaced_by_id != null ? " · replaced" : ""}`
          : `Started ${fmtDate(med.start_date ?? med.created_at)}`}
      </p>
      {editing && !readOnly && (
        <EditMedForm
          med={med}
          onDone={() => {
            setEditing(false);
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}

export default function MedicationList({
  meds,
  onStop,
  onResume,
  onDelete,
  onChanged,
  readOnly,
}: {
  meds: Medication[];
  onStop?: (id: number) => void;
  onResume?: (id: number) => void;
  onDelete?: (id: number) => void;
  onChanged?: () => void;
  readOnly?: boolean;
}) {
  const [showStopped, setShowStopped] = useState(false);
  const active = meds.filter((m) => m.status === "active");
  const stopped = meds.filter((m) => m.status === "stopped");

  return (
    <section>
      <h2 className="mb-2 text-base font-semibold">Medications</h2>
      {active.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
          Nothing here yet. Add your first medication to start conflict checking.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {active.map((m) => (
            <MedCard key={m.id} med={m} onStop={onStop} onResume={onResume} onDelete={onDelete} onChanged={onChanged} readOnly={readOnly} />
          ))}
        </div>
      )}

      {stopped.length > 0 && (
        <div className="mt-3">
          <button
            onClick={() => setShowStopped(!showStopped)}
            className="text-xs text-slate-500 underline hover:text-slate-700"
          >
            {showStopped ? "Hide" : "Show"} {stopped.length} stopped medication
            {stopped.length === 1 ? "" : "s"}
          </button>
          {showStopped && (
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              {stopped.map((m) => (
                <MedCard key={m.id} med={m} onStop={onStop} onResume={onResume} onDelete={onDelete} onChanged={onChanged} readOnly={readOnly} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
