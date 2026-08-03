"use client";

// Clinician entry of a MEDICATION PLAN — honestly labelled: this records a
// prescription created outside GanderMed; it does not send anything to a
// pharmacy and is not an e-prescription. The patient confirms receipt and
// start from their own account.

import { useEffect, useRef, useState } from "react";
import type { Medication, SearchResult } from "@/lib/types";
import { isCurrentlyTaken } from "@/lib/lifecycle";
import { titleCase } from "@/lib/normalize";
import { todayStr } from "@/lib/format";

const DOSE_UNITS = ["tablet(s)", "capsule(s)", "mg", "mL", "puff(s)", "drop(s)", "unit(s)", "patch(es)"];

export default function MedPlanForm({
  patientId,
  meds,
  onCreated,
}: {
  patientId: number;
  meds: Medication[];
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [doseValue, setDoseValue] = useState("1");
  const [doseUnit, setDoseUnit] = useState(DOSE_UNITS[0]);
  const [isPrn, setIsPrn] = useState(false);
  const [times, setTimes] = useState<string[]>(["08:00"]);
  const [instructions, setInstructions] = useState("");
  const [prescribedAt, setPrescribedAt] = useState(todayStr());
  const [prescriberName, setPrescriberName] = useState("");
  const [prescriberProfession, setPrescriberProfession] = useState("");
  const [replaces, setReplaces] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!open || selected) return;
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
        // aborted
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [q, open, selected]);

  async function create() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/medication-plans?patient=${patientId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          drug_code: selected.drug_code,
          prescribed_dose_value: doseValue === "" ? null : Number(doseValue),
          prescribed_dose_unit: doseUnit,
          prescribed_is_prn: isPrn,
          prescribed_schedule_times: isPrn ? [] : times,
          prescribed_instructions: instructions.trim() || null,
          prescribed_at: prescribedAt,
          prescriber_name: prescriberName.trim() || null,
          prescriber_profession: prescriberProfession.trim() || null,
          ...(replaces ? { replaces_medication_id: Number(replaces) } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not save the plan.");
        return;
      }
      setDone(
        `${titleCase(selected.brand_name)} recorded. The patient will be asked to confirm receiving and starting it — nothing counts as taken until they do.`
      );
      setSelected(null);
      setQ("");
      setInstructions("");
      setReplaces("");
      onCreated();
    } catch {
      setError("Network error — could not save.");
    } finally {
      setBusy(false);
    }
  }

  const currentMeds = meds.filter((m) => isCurrentlyTaken(m));

  return (
    <section className="rounded-2xl border border-teal-200 bg-teal-50/40 p-5">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between text-left">
        <div>
          <h2 className="text-sm font-semibold">Record a medication plan</h2>
          <p className="mt-0.5 text-xs text-slate-600">
            Enter a prescription written outside GanderMed. The patient confirms receipt and start —
            this does not send anything to a pharmacy.
          </p>
        </div>
        <span className="text-xs text-slate-400 underline">{open ? "hide" : "show"}</span>
      </button>

      {done && !open && <p className="mt-2 text-xs text-emerald-700">{done}</p>}

      {open && (
        <div className="mt-3 space-y-2.5">
          {!selected ? (
            <div className="relative">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search Health Canada's database (brand or DIN)"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-teal-400"
              />
              {searching && <span className="absolute right-3 top-2.5 text-xs text-slate-400">searching…</span>}
              {results.length > 0 && (
                <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
                  {results.map((r) => (
                    <li key={r.din}>
                      <button
                        onClick={() => {
                          setSelected(r);
                          setResults([]);
                        }}
                        className="w-full px-3 py-2 text-left hover:bg-teal-50"
                      >
                        <span className="block text-sm font-medium">{titleCase(r.brand_name)}</span>
                        <span className="block text-xs text-slate-500">DIN {r.din}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="flex items-start justify-between rounded-lg border border-teal-300 bg-white px-3 py-2">
              <div>
                <p className="text-sm font-medium">{titleCase(selected.brand_name)}</p>
                <p className="text-xs text-slate-500">DIN {selected.din}</p>
              </div>
              <button onClick={() => setSelected(null)} className="text-xs text-teal-700 underline">
                change
              </button>
            </div>
          )}

          {selected && (
            <>
              <div className="flex flex-wrap gap-2">
                <div className="w-24">
                  <label className="text-[11px] font-medium text-slate-600">Prescribed dose</label>
                  <input type="number" min="0" step="any" value={doseValue} onChange={(e) => setDoseValue(e.target.value)} className="mt-0.5 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs" />
                </div>
                <div className="w-32">
                  <label className="text-[11px] font-medium text-slate-600">Unit</label>
                  <select value={doseUnit} onChange={(e) => setDoseUnit(e.target.value)} className="mt-0.5 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs">
                    {DOSE_UNITS.map((u) => (
                      <option key={u}>{u}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[11px] font-medium text-slate-600">Prescribed date</label>
                  <input type="date" value={prescribedAt} max={todayStr()} onChange={(e) => setPrescribedAt(e.target.value)} className="mt-0.5 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs" />
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={isPrn} onChange={(e) => setIsPrn(e.target.checked)} />
                As needed (PRN)
              </label>
              {!isPrn && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-medium text-slate-600">Times:</span>
                  {times.map((t, i) => (
                    <span key={i} className="flex items-center gap-1">
                      <input type="time" value={t} onChange={(e) => setTimes(times.map((x, j) => (j === i ? e.target.value : x)))} className="rounded-lg border border-slate-300 px-2 py-1 text-xs" />
                      {times.length > 1 && (
                        <button onClick={() => setTimes(times.filter((_, j) => j !== i))} className="text-xs text-slate-400 hover:text-red-500">✕</button>
                      )}
                    </span>
                  ))}
                  <button onClick={() => setTimes([...times, "20:00"])} className="text-[11px] text-teal-700 underline">
                    + time
                  </button>
                </div>
              )}

              <input
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                maxLength={500}
                placeholder="Prescribed instructions (e.g. take with food for 7 days)"
                className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
              />
              <div className="flex flex-wrap gap-2">
                <input
                  value={prescriberName}
                  onChange={(e) => setPrescriberName(e.target.value)}
                  maxLength={120}
                  placeholder="Prescriber name (defaults to you)"
                  className="flex-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                />
                <input
                  value={prescriberProfession}
                  onChange={(e) => setPrescriberProfession(e.target.value)}
                  maxLength={80}
                  placeholder="Profession (e.g. Family physician)"
                  className="flex-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
              {currentMeds.length > 0 && (
                <div>
                  <label className="text-[11px] font-medium text-slate-600">Replaces an existing medication?</label>
                  <select value={replaces} onChange={(e) => setReplaces(e.target.value)} className="mt-0.5 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs">
                    <option value="">No — new therapy</option>
                    {currentMeds.map((m) => (
                      <option key={m.id} value={String(m.id)}>
                        Replaces {titleCase(m.brand_name)}
                      </option>
                    ))}
                  </select>
                  <p className="mt-0.5 text-[10px] text-slate-400">
                    The old medication stays as the patient&apos;s current truth until THEY confirm
                    stopping it — the link is recorded and reconciliation shows the gap.
                  </p>
                </div>
              )}

              {error && <p className="text-xs text-red-600">{error}</p>}
              <button
                onClick={create}
                disabled={busy}
                className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
              >
                {busy ? "Saving…" : "Record plan & check interactions"}
              </button>
              <p className="text-[10px] text-slate-400">
                Will appear to the patient as: &ldquo;Entered by [your name] based on a prescription
                created outside GanderMed.&rdquo;
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
