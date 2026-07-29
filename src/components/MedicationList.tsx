"use client";

import { useState } from "react";
import { ACTUAL_USE_LABELS, type Medication } from "@/lib/types";
import { titleCase } from "@/lib/normalize";
import { fmtDate, scheduleLabel } from "@/lib/format";

function MedCard({
  med,
  onStop,
  onResume,
  onDelete,
  readOnly,
}: {
  med: Medication;
  onStop?: (id: number) => void;
  onResume?: (id: number) => void;
  onDelete?: (id: number) => void;
  readOnly?: boolean;
}) {
  const stopped = med.status === "stopped";
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
          ? `Stopped ${fmtDate(med.end_date)}`
          : `Started ${fmtDate(med.start_date ?? med.created_at)}`}
      </p>
    </div>
  );
}

export default function MedicationList({
  meds,
  onStop,
  onResume,
  onDelete,
  readOnly,
}: {
  meds: Medication[];
  onStop?: (id: number) => void;
  onResume?: (id: number) => void;
  onDelete?: (id: number) => void;
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
            <MedCard key={m.id} med={m} onStop={onStop} onResume={onResume} onDelete={onDelete} readOnly={readOnly} />
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
                <MedCard key={m.id} med={m} onStop={onStop} onResume={onResume} onDelete={onDelete} readOnly={readOnly} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
