"use client";

// Clinic-side invitation manager: mint intake links, hand them to patients
// (copy / print / QR — the app never emails or texts anyone), and track each
// invitation through its lifecycle. The raw link is shown exactly once.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { fmtDate } from "@/lib/format";

const PURPOSES = ["Medication review", "MedsCheck preparation", "Post-discharge reconciliation", "Other"];
const EXPIRY_DAYS = [3, 7, 14, 30];

interface InvitationView {
  id: number;
  patient_label: string | null;
  purpose: string;
  status: string;
  created_at: string;
  expires_at: string;
  opened_at: string | null;
  submitted_at: string | null;
  consented_at: string | null;
  patient_note: string | null;
  grant_id: number | null;
  profile_id: number | null;
}

const STATUS_CHIP: Record<string, { label: string; cls: string }> = {
  created: { label: "not opened yet", cls: "bg-slate-100 text-slate-600" },
  opened: { label: "opened", cls: "bg-sky-100 text-sky-800" },
  intake_started: { label: "intake in progress", cls: "bg-indigo-100 text-indigo-800" },
  intake_submitted: { label: "list submitted", cls: "bg-violet-100 text-violet-800" },
  consented: { label: "consented ✓", cls: "bg-teal-100 text-teal-800" },
  denied: { label: "declined", cls: "bg-slate-200 text-slate-600" },
  reviewed: { label: "reviewed", cls: "bg-emerald-100 text-emerald-800" },
  expired: { label: "expired", cls: "bg-amber-100 text-amber-800" },
  cancelled: { label: "cancelled", cls: "bg-slate-200 text-slate-500" },
};

const OPEN_STATES = ["created", "opened", "intake_started", "intake_submitted"];

export default function InvitationsPanel({ onRosterChanged }: { onRosterChanged: () => void }) {
  const [invitations, setInvitations] = useState<InvitationView[]>([]);
  const [label, setLabel] = useState("");
  const [purpose, setPurpose] = useState(PURPOSES[0]);
  const [expiresDays, setExpiresDays] = useState(7);
  const [freshLink, setFreshLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/invitations");
    if (res.ok) setInvitations((await res.json()).invitations ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFreshLink(null);
    setCopied(false);
    try {
      const res = await fetch("/api/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patient_label: label, purpose, expires_days: expiresDays }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not create the invitation.");
        return;
      }
      setFreshLink(`${window.location.origin}${data.intake_path}`);
      setLabel("");
      load();
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!freshLink) return;
    try {
      await navigator.clipboard.writeText(freshLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable — the link is selectable text below
    }
  }

  async function act(id: number, action: "cancel" | "mark_reviewed") {
    if (action === "cancel" && !window.confirm("Cancel this invitation? Its link stops working immediately.")) return;
    const res = await fetch(`/api/invitations/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (res.ok) {
      load();
      if (action === "mark_reviewed") onRosterChanged();
    }
  }

  const visible = showAll ? invitations : invitations.filter((i) => OPEN_STATES.includes(i.status) || i.status === "consented");

  return (
    <section className="mt-6 rounded-2xl border border-indigo-200 bg-indigo-50/50 p-5">
      <h2 className="text-sm font-semibold">Invite a patient to guided intake</h2>
      <p className="mt-0.5 text-xs text-slate-600">
        Creates a secure link you hand to the patient (in person, printed, or by phone). They build
        their own medication list and <strong>decide at the end whether to share it with you</strong>.
      </p>

      <form onSubmit={create} className="mt-3 flex flex-wrap gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={80}
          placeholder="Label for your list (e.g. J.S., Rx #4412)"
          className="w-64 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-400"
        />
        <select
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm"
        >
          {PURPOSES.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <select
          value={expiresDays}
          onChange={(e) => setExpiresDays(Number(e.target.value))}
          className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm"
        >
          {EXPIRY_DAYS.map((d) => (
            <option key={d} value={d}>
              valid {d} days
            </option>
          ))}
        </select>
        <button
          disabled={busy}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          Create link
        </button>
      </form>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      {freshLink && (
        <div className="mt-3 rounded-xl border border-indigo-300 bg-white p-3">
          <p className="text-xs font-semibold text-indigo-900">
            Invitation link — copy it now (it&apos;s shown only once):
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 select-all break-all rounded bg-slate-50 px-2 py-1.5 text-[11px] text-slate-700">
              {freshLink}
            </code>
            <button
              onClick={copyLink}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700"
            >
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-slate-400">
            Hand it to the patient directly, print it, or turn it into a QR code — GanderMed never
            emails or texts patients.
          </p>
        </div>
      )}

      {invitations.length > 0 && (
        <div className="mt-4 border-t border-indigo-200/60 pt-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Invitations {showAll ? "(all)" : "(active)"}
            </p>
            <button onClick={() => setShowAll(!showAll)} className="text-[11px] text-slate-400 underline">
              {showAll ? "show active only" : "show all"}
            </button>
          </div>
          {visible.length === 0 ? (
            <p className="mt-2 text-xs text-slate-400">No active invitations.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {visible.map((inv) => {
                const chip = STATUS_CHIP[inv.status] ?? { label: inv.status, cls: "bg-slate-100 text-slate-600" };
                return (
                  <li
                    key={inv.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2"
                  >
                    <div className="min-w-0 text-xs text-slate-600">
                      <span className="font-semibold text-slate-800">{inv.patient_label ?? `Invitation #${inv.id}`}</span>
                      {" · "}
                      {inv.purpose} · created {fmtDate(inv.created_at)}
                      {OPEN_STATES.includes(inv.status) && ` · expires ${fmtDate(inv.expires_at)}`}
                      {inv.patient_note && (inv.status === "consented" || inv.status === "reviewed") && (
                        <span className="block text-[11px] italic text-slate-500">
                          Patient note: “{inv.patient_note}”
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${chip.cls}`}>{chip.label}</span>
                      {inv.status === "consented" && inv.profile_id != null && (
                        <>
                          <Link
                            href={`/clinic/patient/${inv.profile_id}`}
                            className="rounded-lg bg-slate-800 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-slate-700"
                          >
                            Open record
                          </Link>
                          <button
                            onClick={() => act(inv.id, "mark_reviewed")}
                            className="text-[11px] text-teal-700 underline hover:text-teal-900"
                          >
                            mark reviewed
                          </button>
                        </>
                      )}
                      {OPEN_STATES.includes(inv.status) && (
                        <button
                          onClick={() => act(inv.id, "cancel")}
                          className="text-[11px] text-slate-400 underline hover:text-red-500"
                        >
                          cancel
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
