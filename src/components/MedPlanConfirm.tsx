"use client";

// New medication plans awaiting the patient's confirmation. The wizard walks
// receipt → start → actual use; every answer is the patient's own statement
// and none of it can be entered by the clinician. Honest labelling: a plan
// records a prescription created OUTSIDE GanderMed — this is not an
// e-prescription.

import { useState } from "react";
import { LIFECYCLE_LABELS, effectiveLifecycle, isPlanned } from "@/lib/lifecycle";
import type { Medication } from "@/lib/types";
import { titleCase } from "@/lib/normalize";
import { fmtDate, todayStr } from "@/lib/format";

function PlanCard({ med, onChanged }: { med: Medication; onChanged: () => void }) {
  const lifecycle = effectiveLifecycle(med);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickDate, setPickDate] = useState(false);
  const [startDate, setStartDate] = useState(todayStr());
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState("");
  const [justStarted, setJustStarted] = useState(false);

  async function act(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/medications/${med.id}/lifecycle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError((await res.json()).error ?? "Something went wrong.");
        return false;
      }
      return true;
    } catch {
      setError("Network error — try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function start(date: string) {
    if (await act({ action: "start", date })) setJustStarted(true);
  }

  async function reportUse(exactly: boolean | "unsure") {
    if (exactly === true) {
      setJustStarted(false);
      onChanged();
      return;
    }
    if (exactly === "unsure") {
      await fetch(`/api/medications/${med.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actual_use: "unsure" }),
      });
    } else {
      await act({ action: "taking_differently" });
    }
    setJustStarted(false);
    onChanged();
  }

  const prescribedSchedule = med.prescribed_is_prn
    ? "as needed"
    : (JSON.parse(med.prescribed_schedule_times ?? "[]") as string[]).join(", ") || "no set times";

  const btn = "min-h-11 rounded-lg px-3 text-xs font-semibold disabled:opacity-50";

  return (
    <div className="rounded-xl border border-violet-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{titleCase(med.brand_name)}</p>
          <p className="text-[11px] text-slate-500">
            DIN {med.din} ·{" "}
            {med.ingredients.map((i) => titleCase(i.ingredient_name)).join(", ")}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Prescribed {med.prescribed_at ? fmtDate(med.prescribed_at) : "—"}:{" "}
            {med.prescribed_dose_value != null ? `${med.prescribed_dose_value} ${med.prescribed_dose_unit ?? ""}, ` : ""}
            {prescribedSchedule}
            {med.prescribed_instructions ? ` · ${med.prescribed_instructions}` : ""}
          </p>
          <p className="mt-0.5 text-[11px] italic text-slate-400">
            Entered by {med.source_user_name ?? "your care team"} based on a prescription created outside
            GanderMed.
            {med.prescriber_name && med.prescriber_name !== med.source_user_name
              ? ` Prescriber: ${med.prescriber_name}${med.prescriber_profession ? ` (${med.prescriber_profession})` : ""}.`
              : ""}
          </p>
        </div>
        <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold text-violet-800">
          {LIFECYCLE_LABELS[lifecycle]}
        </span>
      </div>

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      {justStarted ? (
        <div className="mt-3">
          <p className="text-xs font-medium text-slate-700">Are you taking it exactly as prescribed?</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <button onClick={() => reportUse(true)} disabled={busy} className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700`}>
              Yes, exactly
            </button>
            <button onClick={() => reportUse(false)} disabled={busy} className={`${btn} bg-amber-100 text-amber-900 hover:bg-amber-200`}>
              I&apos;m taking it differently
            </button>
            <button onClick={() => reportUse("unsure")} disabled={busy} className={`${btn} bg-slate-100 text-slate-600 hover:bg-slate-200`}>
              I&apos;m not sure
            </button>
          </div>
          <p className="mt-1.5 text-[10px] text-slate-400">
            &ldquo;Differently&rdquo; keeps the prescription on record and lets you set your real dose and
            schedule from the medication card — your pharmacist sees both.
          </p>
        </div>
      ) : asking ? (
        <div className="mt-3 space-y-1.5">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={500}
            rows={2}
            placeholder="e.g. Can I take this with my blood thinner?"
            className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
          />
          <div className="flex gap-1.5">
            <button
              onClick={async () => {
                if (await act({ action: "question", question })) {
                  setAsking(false);
                  setQuestion("");
                  onChanged();
                }
              }}
              disabled={busy || question.trim().length < 3}
              className={`${btn} bg-violet-600 text-white hover:bg-violet-700`}
            >
              Send to my care team
            </button>
            <button onClick={() => setAsking(false)} className={`${btn} bg-slate-100 text-slate-600`}>
              Back
            </button>
          </div>
        </div>
      ) : lifecycle === "received_not_started" ? (
        <div className="mt-3">
          <p className="text-xs font-medium text-slate-700">Have you started taking it?</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <button onClick={() => start(todayStr())} disabled={busy} className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700`}>
              Yes, today
            </button>
            {pickDate ? (
              <span className="flex items-center gap-1.5">
                <input type="date" value={startDate} max={todayStr()} onChange={(e) => setStartDate(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs" />
                <button onClick={() => start(startDate)} disabled={busy} className={`${btn} bg-emerald-600 text-white`}>
                  Confirm
                </button>
              </span>
            ) : (
              <button onClick={() => setPickDate(true)} className={`${btn} bg-emerald-50 text-emerald-800 hover:bg-emerald-100`}>
                Yes, on another date
              </button>
            )}
            <button
              onClick={async () => (await act({ action: "decline" })) && onChanged()}
              disabled={busy}
              className={`${btn} bg-slate-100 text-slate-600 hover:bg-slate-200`}
            >
              I decided not to start it
            </button>
            <button onClick={() => setAsking(true)} className={`${btn} bg-violet-50 text-violet-800 hover:bg-violet-100`}>
              I need to ask a question
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <p className="text-xs font-medium text-slate-700">Have you received or picked up this medication?</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <button
              onClick={async () => (await act({ action: "received" })) && onChanged()}
              disabled={busy}
              className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700`}
            >
              Yes, I have it
            </button>
            <button onClick={() => start(todayStr())} disabled={busy} className={`${btn} bg-emerald-50 text-emerald-800 hover:bg-emerald-100`}>
              I already started taking it
            </button>
            <button
              onClick={async () => (await act({ action: "not_received", reason: "Pharmacy could not fill it or not picked up yet" })) && onChanged()}
              disabled={busy}
              className={`${btn} bg-amber-100 text-amber-900 hover:bg-amber-200`}
            >
              Not yet / couldn&apos;t be filled
            </button>
            <button
              onClick={async () => (await act({ action: "cancelled_externally" })) && onChanged()}
              disabled={busy}
              className={`${btn} bg-slate-100 text-slate-600 hover:bg-slate-200`}
            >
              It was cancelled or replaced
            </button>
            <button onClick={() => setAsking(true)} className={`${btn} bg-violet-50 text-violet-800 hover:bg-violet-100`}>
              I need to ask a question
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function MedPlanConfirm({ meds, onChanged }: { meds: Medication[]; onChanged: () => void }) {
  const plans = meds.filter((m) => isPlanned(m));
  if (plans.length === 0) return null;
  return (
    <section className="rounded-2xl border border-violet-300 bg-violet-50/60 p-5 shadow-sm">
      <h2 className="text-base font-semibold">New medication plans — please confirm</h2>
      <p className="mt-0.5 text-xs text-slate-600">
        Your care team recorded these. Nothing counts as &ldquo;taken&rdquo; — no schedules, exposure
        estimates, or adherence — until you confirm you&apos;ve actually started.
      </p>
      <div className="mt-3 space-y-3">
        {plans.map((m) => (
          <PlanCard key={m.id} med={m} onChanged={onChanged} />
        ))}
      </div>
    </section>
  );
}
