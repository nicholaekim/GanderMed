// Client-safe display helpers (no Node imports).

import type { Evidence, Severity } from "@/lib/types";

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  // Accepts ISO strings, bare dates, and SQLite's "YYYY-MM-DD HH:MM:SS".
  const normalized = iso.replace(" ", "T");
  const d = new Date(normalized.includes("T") ? normalized : `${normalized}T00:00`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Time alone when today, weekday + time otherwise ("Wed 11:20 AM"). */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;
  return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const SEVERITY_META: Record<Severity, { label: string; badge: string; card: string; bar: string }> = {
  major: {
    label: "Major",
    badge: "bg-red-100 text-red-800 border border-red-200",
    card: "border-red-200 bg-red-50/70",
    bar: "bg-red-500",
  },
  moderate: {
    label: "Moderate",
    badge: "bg-amber-100 text-amber-800 border border-amber-200",
    card: "border-amber-200 bg-amber-50/70",
    bar: "bg-amber-500",
  },
  minor: {
    label: "Minor",
    badge: "bg-slate-200 text-slate-700 border border-slate-300",
    card: "border-slate-200 bg-slate-50",
    bar: "bg-slate-400",
  },
};

export const EVIDENCE_LABEL: Record<Evidence, string> = {
  high: "High",
  moderate: "Moderate",
  low: "Low",
};

export function scheduleLabel(isPrn: number, scheduleTimes: string): string {
  if (isPrn) return "As needed (PRN)";
  try {
    const times = JSON.parse(scheduleTimes) as string[];
    if (!times.length) return "No schedule set";
    return `Daily at ${times.join(", ")}`;
  } catch {
    return "No schedule set";
  }
}
