"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Alert, DoseEvent, ExposureReport, Me, Medication } from "@/lib/types";
import AlertsPanel from "@/components/AlertsPanel";
import ChatPanel from "@/components/ChatPanel";
import MedicationList from "@/components/MedicationList";
import ExposurePanel from "@/components/ExposurePanel";
import HistoryList from "@/components/HistoryList";
import { titleCase } from "@/lib/normalize";

export default function ClinicPatientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [meds, setMeds] = useState<Medication[]>([]);
  const [patientName, setPatientName] = useState<string>("");
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [events, setEvents] = useState<DoseEvent[]>([]);
  const [exposure, setExposure] = useState<ExposureReport | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const meRes = await fetch("/api/auth/me");
      if (!meRes.ok) {
        router.replace("/login");
        return;
      }
      const user = (await meRes.json()).user as Me;
      if (user.role !== "clinician") {
        router.replace("/");
        return;
      }
      const qs = `?patient=${id}`;
      const [mRes, aRes, eRes, xRes] = await Promise.all([
        fetch(`/api/medications${qs}`),
        fetch(`/api/alerts${qs}`),
        fetch(`/api/dose-events${qs}&days=14`),
        fetch(`/api/exposure${qs}`),
      ]);
      if (!mRes.ok) {
        setError((await mRes.json()).error ?? "No access to this patient.");
        setLoaded(true);
        return;
      }
      const mData = await mRes.json();
      setMeds(mData.medications ?? []);
      setPatientName(mData.profile?.name ?? `Patient ${id}`);
      if (aRes.ok) setAlerts((await aRes.json()).alerts ?? []);
      if (eRes.ok) setEvents((await eRes.json()).events ?? []);
      if (xRes.ok) setExposure((await xRes.json()).exposure ?? null);
      setLoaded(true);
    })();
  }, [id, router]);

  async function refreshAlerts() {
    const res = await fetch(`/api/alerts?patient=${id}`);
    if (res.ok) setAlerts((await res.json()).alerts ?? []);
  }

  async function review(alertId: number, note: string, expiresDays: number): Promise<boolean> {
    const res = await fetch("/api/alert-reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alert_id: alertId, note, expires_days: expiresDays }),
    });
    if (res.ok) {
      await refreshAlerts();
      return true;
    }
    window.alert((await res.json()).error ?? "Could not save the review.");
    return false;
  }

  async function withdrawReview(reviewId: number) {
    if (!window.confirm("Withdraw this review? The alert will show as open again.")) return;
    const res = await fetch(`/api/alert-reviews/${reviewId}`, { method: "DELETE" });
    if (res.ok) refreshAlerts();
  }

  if (!loaded) return <p className="mt-20 text-center text-sm text-slate-400">Loading…</p>;

  if (error) {
    return (
      <div className="mx-auto max-w-lg px-4 py-20 text-center">
        <p className="text-sm text-red-600">{error}</p>
        <Link href="/clinic" className="mt-3 inline-block text-sm text-teal-700 underline">
          ← Back to patient list
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/clinic" className="text-xs text-teal-700 underline">
            ← Patient list
          </Link>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">{titleCase(patientName)}</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Record shared via care code · you can add review notes to alerts; only the patient can
            edit medications or acknowledge alerts
          </p>
        </div>
        <Link
          href={`/report?patient=${id}`}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-slate-50"
        >
          🖨 Printable report
        </Link>
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-[400px_1fr]">
        <div className="space-y-6">
          <ExposurePanel exposure={exposure} />
          <ChatPanel patientId={Number(id)} />
          <HistoryList events={events} />
        </div>
        <div className="space-y-6">
          <AlertsPanel
            alerts={alerts}
            readOnly
            clinicianMode
            onReview={review}
            onWithdrawReview={withdrawReview}
          />
          <MedicationList meds={meds} readOnly />
        </div>
      </div>

      <footer className="mt-10 border-t border-slate-200 pt-4 text-[11px] leading-relaxed text-slate-400">
        Prototype — demonstration ruleset and demo exposure windows; not for clinical
        decision-making. Data shown only with patient-shared access.
      </footer>
    </div>
  );
}
