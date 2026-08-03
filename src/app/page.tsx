"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Alert, DoseEvent, ExposureReport, Me, Medication } from "@/lib/types";
import AccessPanel from "@/components/AccessPanel";
import AddMedication, { type AddResult } from "@/components/AddMedication";
import AlertsPanel from "@/components/AlertsPanel";
import ChatPanel from "@/components/ChatPanel";
import ExposurePanel from "@/components/ExposurePanel";
import TodaySchedule from "@/components/TodaySchedule";
import MedicationList from "@/components/MedicationList";
import HistoryList from "@/components/HistoryList";
import { pctBadgeClass } from "@/components/AdherenceCard";
import { RULESET_VERSION } from "@/data/interactionRules";
import type { AdherenceReport } from "@/lib/adherence";
import type { ShortageLookup } from "@/lib/shortages";

type Banner = { tone: "warn" | "ok"; text: string } | null;

export default function Dashboard() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [meds, setMeds] = useState<Medication[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [events, setEvents] = useState<DoseEvent[]>([]);
  const [exposure, setExposure] = useState<ExposureReport | null>(null);
  const [adherence, setAdherence] = useState<AdherenceReport | null>(null);
  const [supply, setSupply] = useState<Record<number, ShortageLookup>>({});
  const [loaded, setLoaded] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);

  const loadAll = useCallback(async () => {
    const [mRes, aRes, eRes, xRes, adRes, sRes] = await Promise.all([
      fetch("/api/medications"),
      fetch("/api/alerts"),
      fetch("/api/dose-events?days=14"),
      fetch("/api/exposure"),
      fetch("/api/adherence?days=14"),
      fetch("/api/shortages"),
    ]);
    if (mRes.ok) setMeds((await mRes.json()).medications ?? []);
    if (aRes.ok) setAlerts((await aRes.json()).alerts ?? []);
    if (eRes.ok) setEvents((await eRes.json()).events ?? []);
    if (xRes.ok) setExposure((await xRes.json()).exposure ?? null);
    if (adRes.ok) setAdherence((await adRes.json()).adherence ?? null);
    if (sRes.ok) {
      const data = (await sRes.json()) as { medications: { medication_id: number; supply: ShortageLookup }[] };
      setSupply(Object.fromEntries(data.medications.map((m) => [m.medication_id, m.supply])));
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
      if (user.role === "clinician") {
        router.replace("/clinic");
        return;
      }
      setMe(user);
      loadAll();
    })();
  }, [loadAll, router]);

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  // Dose logs change events AND time-derived state (exposure, alert overlap
  // tags, adherence).
  const refreshEvents = useCallback(async () => {
    const [eRes, xRes, aRes, adRes] = await Promise.all([
      fetch("/api/dose-events?days=14"),
      fetch("/api/exposure"),
      fetch("/api/alerts"),
      fetch("/api/adherence?days=14"),
    ]);
    if (eRes.ok) setEvents((await eRes.json()).events ?? []);
    if (xRes.ok) setExposure((await xRes.json()).exposure ?? null);
    if (aRes.ok) setAlerts((await aRes.json()).alerts ?? []);
    if (adRes.ok) setAdherence((await adRes.json()).adherence ?? null);
  }, []);

  function handleAdded(res: AddResult) {
    setAlerts(res.alerts);
    setMeds((prev) => [res.medication, ...prev]);
    fetch("/api/exposure").then(async (r) => {
      if (r.ok) setExposure((await r.json()).exposure ?? null);
    });
    const majors = res.newAlerts.filter((a) => a.severity === "major").length;
    if (res.newAlerts.length > 0) {
      setBanner({
        tone: "warn",
        text: `${res.newAlerts.length} new safety alert${res.newAlerts.length === 1 ? "" : "s"}${
          majors ? ` (${majors} major)` : ""
        } — review below before taking this medication.`,
      });
    } else if (res.medication.verified) {
      setBanner({
        tone: "ok",
        text: "Saved. No conflicts detected with your current checked medications.",
      });
    } else {
      setBanner({
        tone: "warn",
        text: "Saved as unverified — this entry is excluded from conflict checking.",
      });
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function ack(id: number, val: boolean) {
    const res = await fetch(`/api/alerts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acknowledged: val }),
    });
    if (res.ok) {
      const { alert } = await res.json();
      setAlerts((prev) => prev.map((a) => (a.id === id ? alert : a)));
    }
  }

  async function logDose(medicationId: number, scheduledAt: string | null, action: "taken" | "skipped") {
    const res = await fetch("/api/dose-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ medication_id: medicationId, scheduled_at: scheduledAt, action }),
    });
    if (res.ok) refreshEvents();
  }

  async function setStatus(id: number, status: "active" | "stopped") {
    const res = await fetch(`/api/medications/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (res.ok) {
      const { alerts: fresh } = await res.json();
      setAlerts(fresh);
      setMeds((prev) =>
        prev.map((m) =>
          m.id === id
            ? { ...m, status, end_date: status === "stopped" ? new Date().toISOString().slice(0, 10) : null }
            : m
        )
      );
    }
  }

  async function deleteMed(id: number) {
    const med = meds.find((m) => m.id === id);
    if (
      !window.confirm(
        `Delete ${med?.brand_name ?? "this medication"} and its dose history? This cannot be undone. ` +
          "(Use Stop instead if you just finished taking it.)"
      )
    )
      return;
    const res = await fetch(`/api/medications/${id}`, { method: "DELETE" });
    if (res.ok) {
      const { alerts: fresh } = await res.json();
      setAlerts(fresh);
      setMeds((prev) => prev.filter((m) => m.id !== id));
      refreshEvents();
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            🪿 GanderMed
            <span className="ml-2 align-middle rounded-full border border-red-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-red-700">
              🇨🇦 Canada
            </span>
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Log what you take. Get warned about combinations that don&apos;t mix — powered by Health
            Canada&apos;s Drug Product Database.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/report"
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-slate-50"
          >
            🖨 Pharmacist report
          </Link>
          <button
            onClick={signOut}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-slate-50"
            title={me?.email ?? undefined}
          >
            Sign out{me ? ` (${me.display_name})` : ""}
          </button>
        </div>
      </header>

      <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        <strong>Prototype — informational only.</strong> Conflict checks use a demonstration ruleset,
        not a licensed clinical database, and can miss real interactions. Never start, stop, or change
        a medication based on this app alone — talk to your pharmacist or prescriber.
      </p>

      {banner && (
        <div
          className={`mt-3 flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${
            banner.tone === "warn"
              ? "border-red-200 bg-red-50 text-red-800"
              : "border-emerald-200 bg-emerald-50 text-emerald-800"
          }`}
        >
          <span>{banner.text}</span>
          <button onClick={() => setBanner(null)} className="text-xs underline opacity-70">
            dismiss
          </button>
        </div>
      )}

      {!loaded ? (
        <p className="mt-10 text-center text-sm text-slate-400">Loading…</p>
      ) : (
        <div className="mt-6 grid gap-6 lg:grid-cols-[400px_1fr]">
          <div className="space-y-6">
            <AddMedication onAdded={handleAdded} />
            <TodaySchedule meds={meds} events={events} onLog={logDose} />
            <ExposurePanel exposure={exposure} />
            {me?.share_code && <AccessPanel initialCode={me.share_code} />}
          </div>
          <div className="space-y-6">
            <AlertsPanel alerts={alerts} onAck={ack} />
            <ChatPanel />
            <MedicationList
              meds={meds}
              onStop={(id) => setStatus(id, "stopped")}
              onResume={(id) => setStatus(id, "active")}
              onDelete={deleteMed}
              onChanged={loadAll}
              supply={supply}
            />
            {adherence && adherence.overall.expected_due > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs text-slate-600">
                <span className={`rounded-full px-2 py-0.5 font-bold ${pctBadgeClass(adherence.overall.adherence_pct)}`}>
                  {adherence.overall.adherence_pct}%
                </span>
                <span>
                  14-day adherence · {adherence.overall.counts.on_time} on time · {adherence.overall.counts.late} late
                  {adherence.overall.counts.skipped > 0 && ` · ${adherence.overall.counts.skipped} skipped`}
                  {adherence.overall.counts.missed > 0 && (
                    <span className="font-semibold text-red-600"> · {adherence.overall.counts.missed} missed</span>
                  )}
                  {" · "}
                  <a href="/report" className="underline hover:text-slate-800">
                    details
                  </a>
                </span>
              </div>
            )}
            <HistoryList events={events} />
          </div>
        </div>
      )}

      <footer className="mt-10 border-t border-slate-200 pt-4 text-[11px] leading-relaxed text-slate-400">
        Product data: Health Canada Drug Product Database (nightly-updated, queried live). Conflict
        rules: curated demonstration ruleset v{RULESET_VERSION} plus the DDInter open-access dataset
        where imported — still not a licensed clinical database, and pending pharmacist validation
        before any public release. This tool does not provide medical advice.
      </footer>
    </div>
  );
}
