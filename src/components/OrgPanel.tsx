"use client";

// Organization management on /clinic: create the org, manage locations and
// members, mint staff join links (shown exactly once). Every surface carries
// the unverified badge — GanderMed operates no verification process yet.

import { useCallback, useEffect, useState } from "react";
import { fmtDate } from "@/lib/format";
import type { OrgContext } from "@/lib/types";

interface OrgView {
  organization: { id: number; name: string; verification_status: string } | null;
  my_role?: "owner" | "admin" | "pharmacist" | "staff";
  locations?: { id: number; label: string; address: string | null; status: string }[];
  members?: { id: number; org_role: string; status: string; created_at: string; display_name: string }[];
  open_invites?: { id: number; org_role: string; invitee_label: string | null; expires_at: string; invited_by_name: string }[];
}

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  pharmacist: "Pharmacist",
  staff: "Staff",
};

export default function OrgPanel({ me }: { me: { clinic_name: string | null; org?: OrgContext | null } }) {
  const [view, setView] = useState<OrgView | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(me.clinic_name ?? "");
  const [locationLabel, setLocationLabel] = useState("");

  const [inviteRole, setInviteRole] = useState<"pharmacist" | "staff" | "admin">("pharmacist");
  const [inviteLabel, setInviteLabel] = useState("");
  const [freshJoinLink, setFreshJoinLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [newLocation, setNewLocation] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/org");
    if (res.ok) setView(await res.json());
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  async function createOrg(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, location_label: locationLabel }),
    });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json()).error ?? "Could not create the organization.");
      return;
    }
    load();
  }

  async function mintInvite() {
    setBusy(true);
    setError(null);
    setFreshJoinLink(null);
    setCopied(false);
    const res = await fetch("/api/org/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org_role: inviteRole, invitee_label: inviteLabel }),
    });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json()).error ?? "Could not create the invite.");
      return;
    }
    setFreshJoinLink(`${window.location.origin}${(await res.json()).join_path}`);
    setInviteLabel("");
    load();
  }

  async function memberAction(memberId: number, body: Record<string, unknown>, confirmMsg?: string) {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    const res = await fetch(`/api/org/members/${memberId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      window.alert(data.error ?? "Action failed.");
      return;
    }
    if (body.action === "deactivate" && data.open_invite_count > 0) {
      window.alert(
        `Heads up: ${data.open_invite_count} staff invite link(s) are still open. Review them below and cancel any this person shouldn't have influence over.`
      );
    }
    load();
  }

  async function addLocation() {
    if (newLocation.trim().length < 2) return;
    const res = await fetch("/api/org/locations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: newLocation.trim() }),
    });
    if (res.ok) {
      setNewLocation("");
      load();
    }
  }

  async function closeLocation(id: number, label: string) {
    if (!window.confirm(`Close ${label}? New requests can no longer name it; existing consents keep it for display.`)) return;
    const res = await fetch(`/api/org/locations/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "close" }),
    });
    if (res.ok) load();
  }

  async function cancelInvite(id: number) {
    const res = await fetch(`/api/org/invites/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel" }),
    });
    if (res.ok) load();
  }

  const management = view?.my_role === "owner" || view?.my_role === "admin";

  return (
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between text-left">
        <div>
          <h2 className="text-sm font-semibold">Organization</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {me.org
              ? `${me.org.name} · your role: ${ROLE_LABEL[me.org.org_role]}`
              : "Set up your pharmacy so your whole team can work from one patient roster."}
          </p>
        </div>
        <span className="text-xs text-slate-400 underline">{open ? "hide" : "show"}</span>
      </button>

      {open && !view && <p className="mt-3 text-xs text-slate-400">Loading…</p>}

      {open && view && view.organization === null && (
        <form onSubmit={createOrg} className="mt-4 space-y-2.5">
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Organizations are <strong>unverified</strong> until GanderMed operates a verification
            process — patients see that label whenever your organization asks for access.
          </p>
          <div>
            <label className="text-xs font-medium text-slate-600">Organization name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-teal-400"
              required
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">First location (neighbourhood or street)</label>
            <input
              value={locationLabel}
              onChange={(e) => setLocationLabel(e.target.value)}
              maxLength={120}
              placeholder="e.g. Wortley Village"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-teal-400"
              required
            />
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <button
            disabled={busy}
            className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            Create organization
          </button>
        </form>
      )}

      {open && view && view.organization && (
        <div className="mt-4 space-y-4">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            {view.organization.name}
            <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
              Unverified organization
            </span>
          </p>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Locations</p>
            <ul className="mt-1 space-y-1 text-xs">
              {view.locations?.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-2">
                  <span className={l.status === "closed" ? "text-slate-400 line-through" : ""}>
                    {l.label}
                    {l.address ? ` — ${l.address}` : ""}
                  </span>
                  {management && l.status === "active" && (
                    <button onClick={() => closeLocation(l.id, l.label)} className="text-[11px] text-slate-400 underline hover:text-red-500">
                      close
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {management && (
              <div className="mt-1.5 flex gap-2">
                <input
                  value={newLocation}
                  onChange={(e) => setNewLocation(e.target.value)}
                  maxLength={120}
                  placeholder="Add a location"
                  className="flex-1 rounded-lg border border-slate-300 px-2 py-1 text-xs"
                />
                <button onClick={addLocation} className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50">
                  Add
                </button>
              </div>
            )}
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Team</p>
            <ul className="mt-1 space-y-1.5">
              {view.members?.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className={m.status === "deactivated" ? "text-slate-400 line-through" : ""}>
                    {m.display_name}
                    <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                      {ROLE_LABEL[m.org_role]}
                    </span>
                    {m.status === "deactivated" && <span className="ml-1 text-[10px]">(deactivated)</span>}
                  </span>
                  {management && m.status === "active" && (
                    <span className="flex items-center gap-1.5">
                      <select
                        value={m.org_role}
                        onChange={(e) =>
                          memberAction(m.id, { action: "set_role", org_role: e.target.value })
                        }
                        className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px]"
                      >
                        {Object.entries(ROLE_LABEL).map(([v, label]) => (
                          <option key={v} value={v}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() =>
                          memberAction(
                            m.id,
                            { action: "deactivate" },
                            `Deactivate ${m.display_name}? They immediately lose access to every patient shared with the organization. Their own personal patient consents are unaffected.`
                          )
                        }
                        className="text-[11px] text-slate-400 underline hover:text-red-500"
                      >
                        deactivate
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {management && (
            <div className="border-t border-slate-100 pt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Invite staff</p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as typeof inviteRole)}
                  className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs"
                >
                  <option value="pharmacist">Pharmacist</option>
                  <option value="staff">Staff</option>
                  <option value="admin">Admin</option>
                </select>
                <input
                  value={inviteLabel}
                  onChange={(e) => setInviteLabel(e.target.value)}
                  maxLength={80}
                  placeholder="For your list (e.g. J. new hire)"
                  className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
                />
                <button
                  onClick={mintInvite}
                  disabled={busy}
                  className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                >
                  Create join link
                </button>
              </div>
              {error && <p className="mt-1.5 text-xs text-red-600">{error}</p>}
              {freshJoinLink && (
                <div className="mt-2 rounded-lg border border-teal-300 bg-teal-50/50 p-2.5">
                  <p className="text-[11px] font-semibold text-teal-900">Join link — copy it now (shown only once):</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <code className="min-w-0 flex-1 select-all break-all rounded bg-white px-2 py-1 text-[10px] text-slate-700">
                      {freshJoinLink}
                    </code>
                    <button
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(freshJoinLink);
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        } catch {
                          // selectable text remains
                        }
                      }}
                      className="rounded-lg bg-teal-600 px-2.5 py-1 text-[11px] font-semibold text-white"
                    >
                      {copied ? "Copied ✓" : "Copy"}
                    </button>
                  </div>
                  <p className="mt-1 text-[10px] text-slate-500">
                    Anyone with this link can join as the chosen role — hand it over directly, never
                    post it.
                  </p>
                </div>
              )}
              {view.open_invites && view.open_invites.length > 0 && (
                <ul className="mt-2 space-y-1 text-[11px] text-slate-600">
                  {view.open_invites.map((i) => (
                    <li key={i.id} className="flex items-center justify-between gap-2">
                      <span>
                        {ROLE_LABEL[i.org_role]}
                        {i.invitee_label ? ` · ${i.invitee_label}` : ""} · by {i.invited_by_name} · expires{" "}
                        {fmtDate(i.expires_at)}
                      </span>
                      <button onClick={() => cancelInvite(i.id)} className="text-slate-400 underline hover:text-red-500">
                        cancel
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
