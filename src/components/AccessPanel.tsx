"use client";

import { useCallback, useEffect, useState } from "react";
import type { AccessGrantView, AuditEventView } from "@/lib/types";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { titleCase } from "@/lib/normalize";

const AUDIT_LABELS: Record<string, string> = {
  access_requested: "requested access",
  access_approved: "access approved",
  access_denied: "request denied",
  access_revoked: "access revoked",
  access_expired: "access expired",
  care_code_rotated: "care code rotated",
  record_opened: "viewed your record",
  review_created: "added an alert review",
  review_revoked: "withdrew an alert review",
};

export default function AccessPanel({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState(initialCode);
  const [grants, setGrants] = useState<AccessGrantView[]>([]);
  const [audit, setAudit] = useState<AuditEventView[]>([]);
  const [showPast, setShowPast] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [expiry, setExpiry] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    const res = await fetch("/api/access");
    if (res.ok) {
      const data = await res.json();
      setGrants(data.grants ?? []);
      setAudit(data.audit ?? []);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(id: number, action: "approve" | "deny" | "revoke") {
    if (action === "revoke" && !window.confirm("Revoke this access? They will immediately lose the ability to view your record.")) {
      return;
    }
    const days = Number(expiry[id]);
    const res = await fetch(`/api/access/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, expires_days: Number.isFinite(days) && days > 0 ? days : null }),
    });
    if (res.ok) load();
  }

  async function rotate() {
    if (!window.confirm("Rotate your care code? The old code stops working for new requests. Existing access is unaffected."))
      return;
    const res = await fetch("/api/profile/rotate-code", { method: "POST" });
    if (res.ok) setCode((await res.json()).share_code);
  }

  const pending = grants.filter((g) => g.status === "pending");
  const active = grants.filter((g) => g.status === "active");
  const past = grants.filter((g) => ["denied", "revoked", "expired"].includes(g.status));

  return (
    <section className="rounded-2xl border border-teal-200 bg-teal-50/60 p-5">
      <h2 className="text-sm font-semibold">Access &amp; privacy</h2>
      <p className="mt-1 text-xs text-slate-600">
        Give this care code to your pharmacy or clinic. Entering it lets them <strong>request</strong> access —
        nothing is shared until you approve it here.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <p className="flex-1 rounded-lg border border-teal-300 bg-white px-3 py-2 text-center font-mono text-lg font-bold tracking-widest text-teal-800">
          {code}
        </p>
        <button
          onClick={rotate}
          className="rounded-lg border border-teal-300 bg-white px-2.5 py-2 text-xs font-medium text-teal-800 hover:bg-teal-100"
          title="Invalidate the old code for new requests"
        >
          Rotate
        </button>
      </div>

      {pending.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Waiting for your approval</p>
          <div className="mt-1.5 space-y-2">
            {pending.map((g) => (
              <div key={g.id} className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                <p className="text-sm font-medium">
                  {titleCase(g.clinician_name)}
                  {g.clinic_name ? ` · ${titleCase(g.clinic_name)}` : ""}
                </p>
                <p className="text-xs text-slate-600">
                  Purpose: {g.purpose ?? "not stated"} · requested {fmtDate(g.requested_at)}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <select
                    value={expiry[g.id] ?? ""}
                    onChange={(e) => setExpiry({ ...expiry, [g.id]: e.target.value })}
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs"
                  >
                    <option value="">No expiry</option>
                    <option value="30">Expires in 30 days</option>
                    <option value="90">Expires in 90 days</option>
                    <option value="180">Expires in 180 days</option>
                  </select>
                  <button
                    onClick={() => decide(g.id, "approve")}
                    className="rounded-lg bg-teal-600 px-3 py-1 text-xs font-semibold text-white hover:bg-teal-700"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => decide(g.id, "deny")}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                  >
                    Deny
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Who has access</p>
        {active.length === 0 ? (
          <p className="mt-1 text-xs text-slate-500">No one — approvals you grant will show here.</p>
        ) : (
          <ul className="mt-1.5 space-y-1.5">
            {active.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-teal-200 bg-white px-3 py-2">
                <div className="text-xs">
                  <p className="text-sm font-medium">
                    {titleCase(g.clinician_name)}
                    {g.clinic_name ? ` · ${titleCase(g.clinic_name)}` : ""}
                  </p>
                  <p className="text-slate-500">
                    {g.purpose ?? "No purpose stated"} · since {fmtDate(g.starts_at)}
                    {g.expires_at ? ` · expires ${fmtDate(g.expires_at)}` : " · no expiry"}
                  </p>
                </div>
                <button
                  onClick={() => decide(g.id, "revoke")}
                  className="rounded-lg border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {past.length > 0 && (
        <button onClick={() => setShowPast(!showPast)} className="mt-3 text-xs text-slate-500 underline">
          {showPast ? "Hide" : "Show"} {past.length} past request{past.length === 1 ? "" : "s"}
        </button>
      )}
      {showPast && (
        <ul className="mt-1.5 space-y-1 text-xs text-slate-500">
          {past.map((g) => (
            <li key={g.id}>
              {titleCase(g.clinician_name)} — {g.status} {fmtDate(g.revoked_at ?? g.decided_at ?? g.requested_at)}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 border-t border-teal-200/60 pt-2">
        <button onClick={() => setShowActivity(!showActivity)} className="text-xs text-slate-500 underline">
          {showActivity ? "Hide" : "Show"} recent access activity
        </button>
        {showActivity && (
          <ul className="mt-1.5 space-y-0.5 text-[11px] text-slate-500">
            {audit.length === 0 && <li>No activity yet.</li>}
            {audit.map((a, i) => (
              <li key={i}>
                {fmtDateTime(a.at)} — {a.actor_name ? titleCase(a.actor_name) : "System"}
                {a.actor_clinic ? ` (${titleCase(a.actor_clinic)})` : ""} {AUDIT_LABELS[a.action] ?? a.action}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
