"use client";

// Guided intake for a pharmacy invitation. The wizard walks the patient
// through: who's asking → build/confirm the medication list (with "how I
// actually take it") → submit → an explicit consent decision. Nothing is
// visible to the clinic until the final Approve.

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AddMedication from "@/components/AddMedication";
import { ACTUAL_USE_LABELS, type ActualUse, type Medication } from "@/lib/types";
import { titleCase } from "@/lib/normalize";
import { fmtDate } from "@/lib/format";

interface IntakeMeta {
  status: string;
  purpose: string;
  expires_at: string;
  clinician_name: string;
  clinic_name: string | null;
  organization_name?: string;
  org_verification_status?: string;
  location_label?: string | null;
  viewer: "anonymous" | "patient" | "clinician";
  claimed: boolean;
  claimed_by_you: boolean;
}

type Step = "loading" | "invalid" | "closed" | "wrong_account" | "clinician_view" | "intro" | "meds" | "consent" | "done";

const CLOSED_COPY: Record<string, string> = {
  expired: "This intake link has expired. Ask your pharmacy for a new one.",
  cancelled: "This intake link was cancelled by the pharmacy. Ask them for a new one if needed.",
};

export default function IntakePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const [meta, setMeta] = useState<IntakeMeta | null>(null);
  const [step, setStep] = useState<Step>("loading");
  const [outcome, setOutcome] = useState<"approved" | "declined" | null>(null);
  const [meds, setMeds] = useState<Medication[]>([]);
  const [note, setNote] = useState("");
  const [expiry, setExpiry] = useState<number | null>(90);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMeds = useCallback(async () => {
    const res = await fetch("/api/medications");
    if (res.ok) setMeds(((await res.json()).medications as Medication[]).filter((m) => m.status === "active"));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/intake/${token}`);
        if (res.status === 404) {
          setStep("invalid");
          return;
        }
        const data = (await res.json()) as IntakeMeta;
        setMeta(data);

        if (data.status === "expired" || data.status === "cancelled") {
          setStep("closed");
        } else if (data.status === "consented" || data.status === "reviewed") {
          setOutcome("approved");
          setStep("done");
        } else if (data.status === "denied") {
          setOutcome("declined");
          setStep("done");
        } else if (data.viewer === "anonymous") {
          setStep("intro"); // intro shows the sign-in button
        } else if (data.viewer === "clinician") {
          setStep("clinician_view");
        } else if (data.claimed && !data.claimed_by_you) {
          setStep("wrong_account");
        } else if (data.status === "intake_started") {
          await loadMeds();
          setStep("meds");
        } else if (data.status === "intake_submitted") {
          await loadMeds();
          setStep("consent");
        } else {
          setStep("intro");
        }
      } catch {
        setError("Couldn't load this invitation — is the server running?");
        setStep("invalid");
      }
    })();
  }, [token, loadMeds]);

  async function post(path: string, body?: unknown): Promise<{ ok: boolean; data: { error?: string; status?: string } }> {
    const res = await fetch(`/api/intake/${token}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return { ok: res.ok, data: await res.json() };
  }

  async function begin() {
    if (meta?.viewer === "anonymous") {
      router.push(`/login?next=${encodeURIComponent(`/intake/${token}`)}`);
      return;
    }
    setBusy(true);
    setError(null);
    const { ok, data } = await post("/start");
    setBusy(false);
    if (!ok) {
      setError(data.error ?? "Couldn't start the intake.");
      return;
    }
    await loadMeds();
    setStep("meds");
  }

  async function submitList() {
    setBusy(true);
    setError(null);
    const { ok, data } = await post("/submit", { patient_note: note });
    setBusy(false);
    if (!ok) {
      setError(data.error ?? "Couldn't submit your list.");
      return;
    }
    setStep("consent");
  }

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    const { ok, data } = await post("/consent", { approve, expires_days: approve ? expiry : null });
    setBusy(false);
    if (!ok) {
      setError(data.error ?? "Couldn't record your decision.");
      return;
    }
    setOutcome(approve ? "approved" : "declined");
    setStep("done");
  }

  const who = meta
    ? meta.organization_name
      ? `${meta.organization_name}${meta.location_label ? ` — ${meta.location_label}` : ""} (requested by ${meta.clinician_name})`
      : `${meta.clinician_name}${meta.clinic_name ? ` · ${meta.clinic_name}` : ""}`
    : "";
  const isOrg = !!meta?.organization_name;

  function shell(children: React.ReactNode) {
    return (
      <div className="mx-auto min-h-screen max-w-xl px-4 py-10">
        <h1 className="text-center text-2xl font-bold tracking-tight">🪿 GanderMed</h1>
        <p className="mt-1 text-center text-sm text-slate-500">Pharmacy medication intake</p>
        <div className="mt-6">{children}</div>
      </div>
    );
  }

  if (step === "loading") return shell(<p className="text-center text-sm text-slate-400">Loading your invitation…</p>);

  if (step === "invalid") {
    return shell(
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <div className="text-3xl">🔗</div>
        <h2 className="mt-2 text-base font-semibold">This intake link isn&apos;t valid</h2>
        <p className="mt-1 text-sm text-slate-500">
          {error ?? "Check that you copied the whole link, or ask your pharmacy for a new one."}
        </p>
      </div>
    );
  }

  if (step === "closed") {
    return shell(
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <div className="text-3xl">⌛</div>
        <h2 className="mt-2 text-base font-semibold">This link is no longer active</h2>
        <p className="mt-1 text-sm text-slate-500">{CLOSED_COPY[meta?.status ?? ""] ?? "Ask your pharmacy for a new link."}</p>
      </div>
    );
  }

  if (step === "wrong_account") {
    return shell(
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-center shadow-sm">
        <div className="text-3xl">👤</div>
        <h2 className="mt-2 text-base font-semibold text-amber-900">Started under a different account</h2>
        <p className="mt-1 text-sm text-amber-800">
          This invitation was already opened by another patient account. If that was you, sign in with
          that account and reopen this link.
        </p>
      </div>
    );
  }

  if (step === "clinician_view") {
    return shell(
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <div className="text-3xl">🩺</div>
        <h2 className="mt-2 text-base font-semibold">This link is for your patient</h2>
        <p className="mt-1 text-sm text-slate-500">
          You&apos;re signed in as a care-team member. Share this link with the patient — they complete
          the intake and decide whether to share their record with you.
        </p>
      </div>
    );
  }

  if (step === "intro" && meta) {
    return shell(
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Your pharmacy invited you</h2>
        <div className="mt-3 rounded-xl bg-slate-50 p-4 text-sm">
          <div className="flex justify-between gap-4">
            <span className="text-slate-500">Who&apos;s asking</span>
            <span className="text-right font-medium">
              {who}
              {isOrg && (
                <span className="ml-1.5 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 align-middle text-[10px] font-medium text-amber-800">
                  Unverified organization
                </span>
              )}
            </span>
          </div>
          <div className="mt-2 flex justify-between gap-4">
            <span className="text-slate-500">Why</span>
            <span className="text-right font-medium">{meta.purpose}</span>
          </div>
          <div className="mt-2 flex justify-between gap-4">
            <span className="text-slate-500">Link valid until</span>
            <span className="text-right font-medium">{fmtDate(meta.expires_at)}</span>
          </div>
        </div>
        <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-sm text-slate-600">
          <li>Build your medication list (search Health Canada&apos;s database).</li>
          <li>Tell us how you <em>actually</em> take each one — honesty helps your pharmacist help you.</li>
          <li>Decide whether to share your list with {meta.clinician_name}. Nothing is shared until you approve.</li>
        </ol>
        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
        <button
          onClick={begin}
          disabled={busy}
          className="mt-5 w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
        >
          {meta.viewer === "anonymous" ? "Sign in to get started" : busy ? "Starting…" : "Get started"}
        </button>
        {meta.viewer === "anonymous" && (
          <p className="mt-2 text-center text-xs text-slate-400">
            You&apos;ll sign in (or create a free patient account) and come right back here.
          </p>
        )}
      </div>
    );
  }

  if (step === "meds") {
    return shell(
      <div className="space-y-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wide text-indigo-500">Step 1 of 2</div>
          <h2 className="mt-1 text-lg font-semibold">Your medication list</h2>
          <p className="mt-1 text-sm text-slate-500">
            Add everything you take — prescriptions, over-the-counter, and supplements. For each one,
            tell us how you actually take it.
          </p>
        </div>

        {meds.length > 0 && (
          <div className="space-y-3">
            {meds.map((m) => (
              <IntakeMedCard key={m.id} med={m} onChanged={loadMeds} />
            ))}
          </div>
        )}

        <AddMedication onAdded={() => loadMeds()} />

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <label className="text-xs font-medium text-slate-600">
            Anything else your pharmacist should know? (optional)
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            rows={2}
            placeholder="e.g. I sometimes skip the evening dose because it keeps me up"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-400"
          />
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
          <button
            onClick={submitList}
            disabled={busy || meds.length === 0}
            className="mt-3 w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy ? "Submitting…" : "My list is complete →"}
          </button>
          {meds.length === 0 && (
            <p className="mt-2 text-center text-xs text-slate-400">Add at least one medication to continue.</p>
          )}
        </div>
      </div>
    );
  }

  if (step === "consent" && meta) {
    return shell(
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-xs font-semibold uppercase tracking-wide text-indigo-500">Step 2 of 2</div>
        <h2 className="mt-1 text-lg font-semibold">Share your record?</h2>
        <p className="mt-2 text-sm text-slate-600">
          <strong>{who}</strong> is asking to view your medication list, safety alerts, and dose
          history for: <strong>{meta.purpose}</strong>. Access is view-only, and you can revoke it any
          time from your dashboard.
        </p>
        {isOrg && (
          <p className="mt-2 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-xs text-slate-700">
            <strong>This is a team request:</strong> approving shares your record with{" "}
            <strong>everyone at {meta.organization_name}</strong> — including staff at other locations
            and staff who join later. GanderMed has not verified this organization&apos;s credentials.
          </p>
        )}

        <div className="mt-4">
          <div className="text-xs font-medium text-slate-600">How long should access last?</div>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {[
              { v: 30, label: "30 days" },
              { v: 90, label: "90 days" },
              { v: 180, label: "180 days" },
              { v: null, label: "Until I revoke it" },
            ].map((o) => (
              <button
                key={String(o.v)}
                onClick={() => setExpiry(o.v)}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${
                  expiry === o.v
                    ? "border-indigo-400 bg-indigo-50 text-indigo-700"
                    : "border-slate-200 bg-white text-slate-500 hover:border-slate-300"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

        <div className="mt-5 flex gap-3">
          <button
            onClick={() => decide(false)}
            disabled={busy}
            className="flex-1 rounded-lg border border-slate-300 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            Don&apos;t share
          </button>
          <button
            onClick={() => decide(true)}
            disabled={busy}
            className="flex-1 rounded-lg bg-teal-600 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-teal-700 disabled:opacity-50"
          >
            {busy ? "Saving…" : isOrg ? `Share with ${meta.organization_name}` : "Approve sharing"}
          </button>
        </div>
        <p className="mt-3 text-center text-xs text-slate-400">
          Declining keeps your list private — it stays in your own GanderMed account either way.
        </p>
      </div>
    );
  }

  if (step === "done") {
    return shell(
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <div className="text-3xl">{outcome === "approved" ? "✅" : "🔒"}</div>
        <h2 className="mt-2 text-base font-semibold">
          {outcome === "approved" ? "You're all set" : "Nothing was shared"}
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          {outcome === "approved"
            ? `${who} can now view your medication record. You can revoke access any time from your dashboard.`
            : "You declined sharing. Your medication list stays private in your own account."}
        </p>
        <button
          onClick={() => router.push("/")}
          className="mt-4 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700"
        >
          Go to my dashboard
        </button>
      </div>
    );
  }

  return shell(<p className="text-center text-sm text-slate-400">Loading…</p>);
}

/** One medication row with the "how I actually take this" editor. */
function IntakeMedCard({ med, onChanged }: { med: Medication; onChanged: () => void }) {
  const [use, setUse] = useState<ActualUse>(med.actual_use);
  const [medNote, setMedNote] = useState(med.patient_notes ?? "");
  const [saving, setSaving] = useState(false);

  async function patch(fields: { actual_use?: ActualUse; patient_notes?: string }) {
    setSaving(true);
    await fetch(`/api/medications/${med.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    setSaving(false);
    onChanged();
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">{titleCase(med.brand_name)}</div>
          <div className="text-xs text-slate-500">
            {med.verified ? `DIN ${med.din}` : "Unverified entry"}
            {med.dose_value != null && ` · ${med.dose_value} ${med.dose_unit ?? ""}`}
          </div>
        </div>
        {saving && <span className="text-[10px] text-slate-400">saving…</span>}
      </div>
      <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
        <select
          value={use}
          onChange={(e) => {
            const v = e.target.value as ActualUse;
            setUse(v);
            patch({ actual_use: v });
          }}
          className={`rounded-lg border px-2 py-1.5 text-xs ${
            use === "taking" ? "border-slate-300 bg-white" : "border-amber-300 bg-amber-50 text-amber-900"
          }`}
        >
          {(Object.keys(ACTUAL_USE_LABELS) as ActualUse[]).map((k) => (
            <option key={k} value={k}>
              {ACTUAL_USE_LABELS[k]}
            </option>
          ))}
        </select>
        <input
          value={medNote}
          onChange={(e) => setMedNote(e.target.value)}
          onBlur={() => patch({ patient_notes: medNote })}
          maxLength={500}
          placeholder="Note (e.g. only half a tablet)"
          className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs outline-none focus:border-indigo-400"
        />
      </div>
    </div>
  );
}
