"use client";

import { useEffect, useRef, useState } from "react";
import type { Alert, Medication, SearchResult } from "@/lib/types";
import { titleCase } from "@/lib/normalize";
import { todayStr } from "@/lib/format";

export interface AddResult {
  medication: Medication;
  newAlerts: Alert[];
  alerts: Alert[];
}

const DOSE_UNITS = ["tablet(s)", "capsule(s)", "mg", "mL", "puff(s)", "drop(s)", "unit(s)", "patch(es)"];

export default function AddMedication({ onAdded }: { onAdded: (res: AddResult) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [manualMode, setManualMode] = useState(false);
  const [manualName, setManualName] = useState("");

  const [doseValue, setDoseValue] = useState<string>("1");
  const [doseUnit, setDoseUnit] = useState(DOSE_UNITS[0]);
  const [isPrn, setIsPrn] = useState(false);
  const [times, setTimes] = useState<string[]>(["08:00"]);
  const [startDate, setStartDate] = useState(todayStr());
  const [instructions, setInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (selected || manualMode) return;
    const query = q.trim();
    if (query.length < 2) {
      setResults([]);
      setSearchError(null);
      return;
    }
    const t = setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setSearching(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: ctrl.signal });
        const data = await res.json();
        if (!res.ok) {
          setSearchError(data.error ?? "Search failed.");
          setResults([]);
        } else {
          setSearchError(null);
          setResults(data.results ?? []);
        }
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          setSearchError("Search failed — check your connection.");
        }
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [q, selected, manualMode]);

  const readyToSave = (selected || (manualMode && manualName.trim().length > 1)) && !saving;

  async function save() {
    if (!readyToSave) return;
    setSaving(true);
    setSaveError(null);
    // Verified adds send only drug_code — the server resolves everything
    // else authoritatively from Health Canada and rejects unmarketed products.
    const payload = {
      ...(selected ? { drug_code: selected.drug_code } : { manual_name: manualName.trim() }),
      dose_value: doseValue === "" ? null : Number(doseValue),
      dose_unit: doseUnit,
      is_prn: isPrn,
      schedule_times: isPrn ? [] : times,
      start_date: startDate || null,
      instructions: instructions || null,
    };
    try {
      const res = await fetch("/api/medications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setSaveError(data.error ?? "Could not save.");
        return;
      }
      setQ("");
      setResults([]);
      setSelected(null);
      setManualMode(false);
      setManualName("");
      setDoseValue("1");
      setDoseUnit(DOSE_UNITS[0]);
      setIsPrn(false);
      setTimes(["08:00"]);
      setInstructions("");
      onAdded(data as AddResult);
    } catch {
      setSaveError("Network error — could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold">Add a medication</h2>
      <p className="mt-0.5 text-xs text-slate-500">
        Searches Health Canada&apos;s Drug Product Database (brand name or DIN).
      </p>

      {!selected && !manualMode && (
        <div className="relative mt-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. Tylenol, Advil, or a DIN like 00559407"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          />
          {searching && <div className="absolute right-3 top-2.5 text-xs text-slate-400">searching…</div>}
          {results.length > 0 && (
            <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
              {results.map((r) => (
                <li key={r.din}>
                  <button
                    onClick={() => {
                      setSelected(r);
                      setResults([]);
                    }}
                    className="w-full px-3 py-2 text-left hover:bg-indigo-50"
                  >
                    <div className="text-sm font-medium">{titleCase(r.brand_name)}</div>
                    <div className="text-xs text-slate-500">
                      DIN {r.din} · {r.number_of_ais} ingredient{r.number_of_ais === 1 ? "" : "s"} ·{" "}
                      {titleCase(r.company_name).slice(0, 40)}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {searchError && !selected && !manualMode && (
        <p className="mt-2 text-xs text-red-600">{searchError}</p>
      )}

      {!selected && !manualMode && (
        <button
          onClick={() => setManualMode(true)}
          className="mt-2 text-xs text-slate-500 underline hover:text-slate-700"
        >
          Can&apos;t find it? Add an unverified entry
        </button>
      )}

      {manualMode && !selected && (
        <div className="mt-3 space-y-2">
          <input
            value={manualName}
            onChange={(e) => setManualName(e.target.value)}
            placeholder="Medication name (free text)"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-400"
          />
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Unverified entries are <strong>excluded from conflict checking</strong> — the app only
            safety-checks products matched to Health Canada&apos;s database.
          </p>
          <button onClick={() => setManualMode(false)} className="text-xs text-slate-500 underline">
            Back to search
          </button>
        </div>
      )}

      {selected && (
        <div className="mt-3 flex items-start justify-between rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2">
          <div>
            <div className="text-sm font-medium">{titleCase(selected.brand_name)}</div>
            <div className="text-xs text-slate-500">
              DIN {selected.din} · {titleCase(selected.company_name).slice(0, 40)}
            </div>
          </div>
          <button
            onClick={() => setSelected(null)}
            className="text-xs text-indigo-600 underline hover:text-indigo-800"
          >
            change
          </button>
        </div>
      )}

      {(selected || (manualMode && manualName.trim().length > 1)) && (
        <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
          <div className="flex gap-2">
            <div className="w-24">
              <label className="text-xs font-medium text-slate-600">Dose</label>
              <input
                type="number"
                min="0"
                step="any"
                value={doseValue}
                onChange={(e) => setDoseValue(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              />
            </div>
            <div className="flex-1">
              <label className="text-xs font-medium text-slate-600">Unit</label>
              <select
                value={doseUnit}
                onChange={(e) => setDoseUnit(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
              >
                {DOSE_UNITS.map((u) => (
                  <option key={u}>{u}</option>
                ))}
              </select>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isPrn} onChange={(e) => setIsPrn(e.target.checked)} />
            As needed (PRN) — no fixed schedule
          </label>

          {!isPrn && (
            <div>
              <label className="text-xs font-medium text-slate-600">Daily schedule</label>
              <div className="mt-1 space-y-1.5">
                {times.map((t, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      type="time"
                      value={t}
                      onChange={(e) => setTimes(times.map((x, j) => (j === i ? e.target.value : x)))}
                      className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
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
                <button
                  onClick={() => setTimes([...times, "20:00"])}
                  className="text-xs text-indigo-600 underline"
                >
                  + Add another time
                </button>
              </div>
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-slate-600">Start date</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-slate-600">Instructions (optional)</label>
            <input
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="e.g. take with food"
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
            />
          </div>

          {saveError && <p className="text-xs text-red-600">{saveError}</p>}

          <button
            onClick={save}
            disabled={!readyToSave}
            className="w-full rounded-lg bg-indigo-600 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving ? "Saving & checking for conflicts…" : "Save & check for conflicts"}
          </button>
        </div>
      )}
    </section>
  );
}
