"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Me, RosterEntry } from "@/lib/types";
import { fmtDateTime } from "@/lib/format";
import { titleCase } from "@/lib/normalize";

export default function ClinicPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [code, setCode] = useState("");
  const [linkMsg, setLinkMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const loadRoster = useCallback(async () => {
    const res = await fetch("/api/care-links");
    if (res.ok) setRoster((await res.json()).roster ?? []);
    setLoaded(true);
  }, []);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/auth/me");
      if (!res.ok) {
        router.replace("/login");
        return;
      }
      const user = (await res.json()).user as Me;
      if (user.role !== "clinician") {
        router.replace("/");
        return;
      }
      setMe(user);
      loadRoster();
    })();
  }, [router, loadRoster]);

  async function addPatient(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setLinkMsg(null);
    try {
      const res = await fetch("/api/care-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLinkMsg({ ok: false, text: data.error ?? "Could not link patient." });
      } else {
        setLinkMsg({ ok: true, text: `${titleCase(data.patient_name)} added to your patient list.` });
        setCode("");
        loadRoster();
      }
    } finally {
      setBusy(false);
    }
  }

  async function unlink(linkId: number, name: string) {
    if (!window.confirm(`Remove ${name} from your patient list? (Their data is not deleted.)`)) return;
    const res = await fetch(`/api/care-links/${linkId}`, { method: "DELETE" });
    if (res.ok) loadRoster();
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  if (!me) return <p className="mt-20 text-center text-sm text-slate-400">Loading…</p>;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">🩺 {me.clinic_name ?? "Care team"}</h1>
          <p className="mt-1 text-sm text-slate-500">
            Care-team view · signed in as {me.display_name} · view-only access to linked patients
          </p>
        </div>
        <button
          onClick={signOut}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-slate-50"
        >
          Sign out
        </button>
      </header>

      <section className="mt-6 rounded-2xl border border-teal-200 bg-teal-50/60 p-5">
        <h2 className="text-sm font-semibold">Add a patient</h2>
        <p className="mt-0.5 text-xs text-slate-600">
          Ask the patient for the care code shown on their dashboard — entering it is their consent
          for you to view their record.
        </p>
        <form onSubmit={addPatient} className="mt-3 flex gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="e.g. MAPL-4821"
            className="w-44 rounded-lg border border-slate-300 px-3 py-2 text-sm uppercase tracking-widest outline-none focus:border-teal-400"
          />
          <button
            disabled={busy || code.trim().length < 8}
            className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            Link patient
          </button>
        </form>
        {linkMsg && (
          <p className={`mt-2 text-xs ${linkMsg.ok ? "text-emerald-700" : "text-red-600"}`}>{linkMsg.text}</p>
        )}
      </section>

      <section className="mt-6">
        <h2 className="mb-2 text-base font-semibold">Patients ({roster.length})</h2>
        {!loaded ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : roster.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500">
            No linked patients yet — add one with their care code above.
          </p>
        ) : (
          <div className="space-y-2">
            {roster.map((r) => (
              <div
                key={r.link_id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{titleCase(r.patient_name)}</p>
                  <p className="text-xs text-slate-500">
                    {r.patient_email ?? "no account email"} · {r.active_medications} active med
                    {r.active_medications === 1 ? "" : "s"} · last dose{" "}
                    {r.last_dose_at ? fmtDateTime(r.last_dose_at) : "never"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {r.alerts_major > 0 && (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-800">
                      {r.alerts_major} major
                    </span>
                  )}
                  {r.alerts_moderate > 0 && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800">
                      {r.alerts_moderate} moderate
                    </span>
                  )}
                  {r.alerts_reviewed > 0 && (
                    <span className="rounded-full bg-teal-100 px-2 py-0.5 text-xs font-bold text-teal-800">
                      {r.alerts_reviewed} reviewed
                    </span>
                  )}
                  {r.alerts_major === 0 && r.alerts_moderate === 0 && (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                      no open alerts
                    </span>
                  )}
                  <Link
                    href={`/clinic/patient/${r.profile_id}`}
                    className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700"
                  >
                    Open record
                  </Link>
                  <button
                    onClick={() => unlink(r.link_id, titleCase(r.patient_name))}
                    className="text-xs text-slate-400 underline hover:text-red-500"
                  >
                    remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <footer className="mt-10 border-t border-slate-200 pt-4 text-[11px] leading-relaxed text-slate-400">
        Prototype — conflict screening uses a demonstration ruleset, not a licensed clinical
        database. Not for clinical decision-making.
      </footer>
    </div>
  );
}
