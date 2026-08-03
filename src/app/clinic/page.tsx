"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Me, PendingRequest, RosterEntry } from "@/lib/types";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { titleCase } from "@/lib/normalize";
import InvitationsPanel from "@/components/InvitationsPanel";
import MetricsPanel from "@/components/MetricsPanel";
import OrgPanel from "@/components/OrgPanel";
import NotificationsPanel from "@/components/NotificationsPanel";

const PURPOSES = ["Medication review", "MedsCheck preparation", "Post-discharge reconciliation", "Other"];

export default function ClinicPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [pending, setPending] = useState<PendingRequest[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [code, setCode] = useState("");
  const [purpose, setPurpose] = useState(PURPOSES[0]);
  const [requestAs, setRequestAs] = useState<string>("self");
  const [linkMsg, setLinkMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [supplyBusy, setSupplyBusy] = useState(false);
  const [supplyMsg, setSupplyMsg] = useState<string | null>(null);

  const loadRoster = useCallback(async () => {
    const res = await fetch("/api/care-links");
    if (res.ok) {
      const data = await res.json();
      setRoster(data.roster ?? []);
      setPending(data.pending ?? []);
    }
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
      const asOrg = requestAs !== "self";
      const res = await fetch("/api/care-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          purpose,
          ...(asOrg ? { as_org: true, location_id: Number(requestAs) } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLinkMsg({ ok: false, text: data.error ?? "Could not send the request." });
      } else {
        setLinkMsg({
          ok: true,
          text: `Request sent to ${titleCase(data.patient_name)} — they'll see it on their dashboard and must approve it before you can view anything.`,
        });
        setCode("");
        loadRoster();
      }
    } finally {
      setBusy(false);
    }
  }

  async function unlink(grantId: number, name: string, isPending: boolean, via: "individual" | "org" = "individual") {
    const msg = isPending
      ? `Withdraw the pending request for ${name}?`
      : via === "org"
        ? `Give up the ORGANIZATION's access to ${name}? Everyone on the team loses it; the patient would have to approve a new request.`
        : `Give up your personal access to ${name}? (Their data is not deleted; they'd have to approve a new request. Any separate team access is unaffected.)`;
    if (!window.confirm(msg)) return;
    const res = await fetch(`/api/care-links/${grantId}`, { method: "DELETE" });
    if (!res.ok) window.alert((await res.json()).error ?? "Could not remove access.");
    loadRoster();
  }

  async function upgradeToTeam(profileId: number, name: string) {
    const activeLocations = me?.org?.locations.filter((l) => l.status === "active") ?? [];
    if (activeLocations.length === 0) return;
    if (
      !window.confirm(
        `Ask ${name} to share their record with ${me!.org!.name}? They'll see a new request to approve — nothing is shared until they do.`
      )
    )
      return;
    const res = await fetch("/api/care-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ upgrade_profile_id: profileId, location_id: activeLocations[0].id }),
    });
    const data = await res.json();
    if (!res.ok) window.alert(data.error ?? "Could not send the request.");
    else setLinkMsg({ ok: true, text: `Team-access request sent — ${name} must approve it before your team sees anything.` });
    loadRoster();
  }

  async function refreshSupply() {
    setSupplyBusy(true);
    setSupplyMsg(null);
    try {
      const res = await fetch("/api/shortages", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setSupplyMsg(data.needs_key ? "Shortage checking isn't set up on this instance." : (data.error ?? "Refresh failed."));
        return;
      }
      setSupplyMsg(
        `Checked ${data.dins_checked} product${data.dins_checked === 1 ? "" : "s"}${data.note ? ` — ${data.note}` : ""}`
      );
      loadRoster();
    } finally {
      setSupplyBusy(false);
    }
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
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold tracking-tight">
            🩺 {me.org?.name ?? me.clinic_name ?? "Care team"}
            {me.org && (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
                Unverified organization
              </span>
            )}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Care-team view · signed in as {me.display_name}
            {me.org ? ` (${me.org.org_role})` : ""} · view-only access to linked patients ·
            professional accounts are not identity-verified in this prototype
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
        <h2 className="text-sm font-semibold">Request access to a patient</h2>
        <p className="mt-0.5 text-xs text-slate-600">
          Ask the patient for the care code on their dashboard. Entering it sends them an access
          request — <strong>they must approve it</strong> before you can see anything.
        </p>
        <form onSubmit={addPatient} className="mt-3 flex flex-wrap gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="e.g. MAPL-4821"
            className="w-44 rounded-lg border border-slate-300 px-3 py-2 text-sm uppercase tracking-widest outline-none focus:border-teal-400"
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
          {me.org && (
            <select
              value={requestAs}
              onChange={(e) => setRequestAs(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm"
              title="Requesting for the organization shares the patient with your whole team once they approve"
            >
              <option value="self">Myself — {me.display_name}</option>
              {me.org.locations
                .filter((l) => l.status === "active")
                .map((l) => (
                  <option key={l.id} value={String(l.id)}>
                    {me.org!.name} — {l.label}
                  </option>
                ))}
            </select>
          )}
          <button
            disabled={busy || code.trim().length < 8}
            className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            Send request
          </button>
        </form>
        {linkMsg && (
          <p className={`mt-2 text-xs ${linkMsg.ok ? "text-emerald-700" : "text-red-600"}`}>{linkMsg.text}</p>
        )}
        {pending.length > 0 && (
          <div className="mt-3 border-t border-teal-200/60 pt-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Awaiting patient approval</p>
            <ul className="mt-1 space-y-1">
              {pending.map((p) => (
                <li key={p.grant_id} className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
                  <span>
                    {titleCase(p.patient_name)} · {p.purpose ?? "no purpose"} · sent {fmtDate(p.requested_at)}
                    {p.via === "org" && (
                      <span className="ml-1.5 rounded-full bg-teal-100 px-1.5 py-0.5 text-[10px] font-medium text-teal-800">
                        for {p.organization_name}
                        {p.location_label ? ` · ${p.location_label}` : ""}
                        {p.requested_by_name ? ` · by ${p.requested_by_name}` : ""}
                      </span>
                    )}
                  </span>
                  {(p.can_withdraw ?? true) && (
                    <button
                      onClick={() => unlink(p.grant_id, titleCase(p.patient_name), true)}
                      className="text-[11px] text-slate-400 underline hover:text-red-500"
                    >
                      withdraw
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <NotificationsPanel />

      <OrgPanel me={me} />

      <InvitationsPanel onRosterChanged={loadRoster} me={me} />

      <section className="mt-6">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Patients ({roster.length})</h2>
          <div className="flex items-center gap-2">
            {supplyMsg && <span className="text-xs text-slate-500">{supplyMsg}</span>}
            <button
              onClick={refreshSupply}
              disabled={supplyBusy}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium shadow-sm hover:bg-slate-50 disabled:opacity-50"
              title="Re-check your patients' medications against Health Canada's shortage database"
            >
              {supplyBusy ? "Checking supply…" : "Refresh supply data"}
            </button>
          </div>
        </div>
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
                key={r.grant_id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{titleCase(r.patient_name)}</p>
                  <p className="text-xs text-slate-500">
                    {r.patient_email ?? "no account email"} · {r.active_medications} active med
                    {r.active_medications === 1 ? "" : "s"} · last dose{" "}
                    {r.last_dose_at ? fmtDateTime(r.last_dose_at) : "never"}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                    {r.access.map((a) => (
                      <span
                        key={a.grant_id}
                        className={`rounded-full px-1.5 py-0.5 font-medium ${
                          a.via === "org" ? "bg-teal-100 text-teal-800" : "bg-indigo-100 text-indigo-800"
                        }`}
                        title={a.purpose ?? undefined}
                      >
                        {a.via === "org"
                          ? `via ${a.organization_name}${a.location_label ? ` · ${a.location_label}` : ""}`
                          : "you"}
                        {a.expires_at ? ` · until ${fmtDate(a.expires_at)}` : ""}
                        {a.via === "org" && a.requested_by_name
                          ? ` · requested by ${a.requested_by_name}${a.requested_by_active === false ? " (no longer at this pharmacy)" : ""}`
                          : ""}
                        {a.can_remove && (
                          <button
                            onClick={() => unlink(a.grant_id, titleCase(r.patient_name), false, a.via)}
                            className="ml-1 underline hover:text-red-600"
                            title={a.via === "org" ? "Remove team access" : "Remove my access"}
                          >
                            ✕
                          </button>
                        )}
                      </span>
                    ))}
                    {r.can_upgrade && (
                      <button
                        onClick={() => upgradeToTeam(r.profile_id, titleCase(r.patient_name))}
                        className="rounded-full border border-teal-300 px-1.5 py-0.5 font-medium text-teal-700 hover:bg-teal-50"
                      >
                        + Request team access
                      </button>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      r.adherence_pct === null
                        ? "bg-slate-100 text-slate-500"
                        : r.adherence_pct >= 90
                          ? "bg-emerald-100 text-emerald-700"
                          : r.adherence_pct >= 70
                            ? "bg-amber-100 text-amber-800"
                            : "bg-red-100 text-red-800"
                    }`}
                    title={
                      r.adherence_pct === null
                        ? "No scheduled doses were due in the last 14 days"
                        : `14-day adherence · ${r.missed_14d} missed`
                    }
                  >
                    {r.adherence_pct === null ? "no dose data" : `${r.adherence_pct}% adherence`}
                  </span>
                  {r.supply_alerts > 0 && (
                    <span
                      className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-900"
                      title="Health Canada has an open shortage or discontinuation report for this many of their medications"
                    >
                      {r.supply_alerts} supply
                    </span>
                  )}
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
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <MetricsPanel />

      <footer className="mt-10 border-t border-slate-200 pt-4 text-[11px] leading-relaxed text-slate-400">
        Prototype — conflict screening uses a demonstration ruleset, not a licensed clinical
        database. Not for clinical decision-making.
      </footer>
    </div>
  );
}
