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
  reconciliation_started: "started a medication reconciliation",
  reconciliation_item_disposed: "reviewed a medication in reconciliation",
  reconciliation_completed: "completed a medication reconciliation",
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

  async function decide(id: number, action: "approve" | "deny" | "revoke", orgName?: string | null) {
    if (
      action === "revoke" &&
      !window.confirm(
        orgName
          ? `Revoke access for ${titleCase(orgName)}? Everyone at this organization immediately loses the ability to view your record.`
          : "Revoke this access? They will immediately lose the ability to view your record."
      )
    ) {
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
              <div
                key={g.id}
                className={`rounded-lg border p-3 ${
                  g.organization_name ? "border-teal-300 bg-teal-50" : "border-amber-200 bg-amber-50"
                }`}
              >
                {g.organization_name ? (
                  <>
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                      {titleCase(g.organization_name)}
                      {g.location_label ? ` — ${g.location_label}` : ""}
                      <span className="rounded-full border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                        Unverified organization
                      </span>
                    </p>
                    <p className="text-xs text-slate-600">
                      Requested by {titleCase(g.requested_by_name ?? g.clinician_name)} · Purpose:{" "}
                      {g.purpose ?? "not stated"} · {fmtDate(g.requested_at)}
                    </p>
                    <p className="mt-1.5 rounded-md border border-teal-200 bg-white px-2 py-1.5 text-xs text-slate-700">
                      Approving shares your record, view-only, with <strong>everyone at{" "}
                      {titleCase(g.organization_name)}</strong> — including staff at other locations and
                      staff who join later. You can revoke at any time.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-medium">
                      {titleCase(g.clinician_name)}
                      {g.clinic_name ? ` · ${titleCase(g.clinic_name)}` : ""}
                    </p>
                    <p className="text-xs text-slate-600">
                      Purpose: {g.purpose ?? "not stated"} · requested {fmtDate(g.requested_at)}
                    </p>
                  </>
                )}
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
                {g.overlap ? (
                  <p className="mt-1.5 text-[10px] text-slate-500">
                    Note: this professional also has separate personal access — approving or denying
                    this does not change that.
                  </p>
                ) : null}
                <p className="mt-1.5 text-[10px] text-slate-400">
                  GanderMed has not verified this professional&apos;s or organization&apos;s credentials.
                </p>
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
                  {g.organization_name ? (
                    <>
                      <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                        {titleCase(g.organization_name)}
                        {g.location_label
                          ? ` — ${g.location_label}${g.location_status === "closed" ? " (location closed)" : ""}`
                          : ""}
                        <span className="rounded-full bg-teal-100 px-1.5 py-0.5 text-[10px] font-semibold text-teal-800">
                          Pharmacy team access
                        </span>
                        <span className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                          Unverified
                        </span>
                      </p>
                      <p className="text-slate-500">
                        Everyone at this organization can view your record · requested by{" "}
                        {titleCase(g.requested_by_name ?? g.clinician_name)}
                        {g.requester_active === 0 ? " (no longer there)" : ""} · since {fmtDate(g.starts_at)}
                        {g.expires_at ? ` · expires ${fmtDate(g.expires_at)}` : " · no expiry"}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm font-medium">
                        {titleCase(g.clinician_name)}
                        {g.clinic_name ? ` · ${titleCase(g.clinic_name)}` : ""}
                      </p>
                      <p className="text-slate-500">
                        {g.purpose ?? "No purpose stated"} · since {fmtDate(g.starts_at)}
                        {g.expires_at ? ` · expires ${fmtDate(g.expires_at)}` : " · no expiry"}
                      </p>
                    </>
                  )}
                  {g.overlap ? (
                    <p className="mt-0.5 text-[10px] text-slate-400">
                      {g.organization_name
                        ? "A team member also has separate personal access — revoking this does not remove that."
                        : "This professional's organization also has team access — revoking this does not remove that."}
                    </p>
                  ) : null}
                </div>
                <button
                  onClick={() => decide(g.id, "revoke", g.organization_name)}
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
                {a.via_org ? ` via ${a.via_org}` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
