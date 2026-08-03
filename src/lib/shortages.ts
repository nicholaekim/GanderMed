// Drug shortage awareness (Health Canada / Drug Shortages Canada).
//
// Reports are fetched by DIN and CACHED locally; nothing here ever runs
// during a normal page read. The safety rule that shapes the whole module:
//
//   Absence of a shortage record is NOT evidence of supply.
//
// so every medication resolves to one of four honest states —
//   not_configured  the API credentials aren't set up on this instance
//   not_checkable   unverified / no DIN, so there is nothing to look up
//   never_checked   we have simply never asked about this DIN
//   checked         we asked, with an `as_of` date (and a `stale` flag)
// and only `checked` may ever render as "none reported".
//
// Shortage data is supply information, never a clinical signal: it does not
// touch alerts, severity, or the interaction engine, and the app never
// recommends a substitute — that is a pharmacist's decision.

import type { DatabaseSync } from "node:sqlite";

/** Public docs: https://www.drugshortagescanada.ca/blog/52 (site rebranded to healthproductshortages.ca). */
const DEFAULT_API_BASE = "https://www.drugshortagescanada.ca/api/v1";

/** Cached reports older than this are shown as possibly out of date. */
export const STALE_AFTER_HOURS = 24 * 7;
/** A DIN checked within this window is skipped by the next sync. */
const RECHECK_AFTER_HOURS = 12;

export type ShortageState = "active" | "anticipated" | "resolved" | "discontinued" | "unknown";
export type ShortageKind = "shortage" | "discontinuation";

export interface ShortageRow {
  report_id: string;
  kind: ShortageKind;
  din: string;
  brand_name: string | null;
  company_name: string | null;
  status: string;
  state: ShortageState;
  reason: string | null;
  actual_start_date: string | null;
  estimated_end_date: string | null;
  actual_end_date: string | null;
  source_updated_at: string | null;
  fetched_at: string;
}

export type ShortageLookup =
  | { state: "not_configured" }
  | { state: "not_checkable"; why: string }
  | { state: "never_checked" }
  | { state: "checked"; as_of: string; stale: boolean; reports: ShortageRow[] };

export function shortagesConfigured(): boolean {
  return !!(process.env.DSC_EMAIL && process.env.DSC_PASSWORD);
}

/** DPD and DSC both use 8-digit zero-padded DINs; normalize before joining. */
export function normalizeDin(din: string | null | undefined): string | null {
  if (!din) return null;
  const digits = String(din).replace(/\D/g, "");
  if (digits.length === 0 || digits.length > 8) return null;
  return digits.padStart(8, "0");
}

/**
 * Maps DSC's raw status strings onto our five states. Anything unrecognized
 * becomes 'unknown' and is still surfaced — an unreadable report is a
 * reason to look it up, not to assume everything is fine.
 */
export function normalizeState(rawStatus: string, kind: ShortageKind): ShortageState {
  const s = rawStatus.toLowerCase().replace(/[\s-]+/g, "_");
  if (kind === "discontinuation") {
    return s.includes("revers") || s.includes("cancel") ? "resolved" : "discontinued";
  }
  if (s.includes("anticipated")) return "anticipated";
  if (s.includes("avoided") || s.includes("resolved") || s.includes("averted")) return "resolved";
  if (s.includes("active") || s.includes("actual") || s.includes("confirm")) return "active";
  return "unknown";
}

/** States that warrant a flag; 'resolved' is kept for history but never flags. */
export function isOpenState(state: ShortageState): boolean {
  return state === "active" || state === "anticipated" || state === "discontinued" || state === "unknown";
}

// ---- API client (swappable so tests never touch the network) ----

export interface DscReport {
  [key: string]: unknown;
}

type DscFetcher = (din: string) => Promise<DscReport[]>;

let activeFetcher: DscFetcher | null = null;

export function __setShortageFetchForTests(fn: DscFetcher | null): void {
  activeFetcher = fn;
}

let cachedToken: string | null = null;

async function login(): Promise<string> {
  if (cachedToken) return cachedToken;
  const base = process.env.DSC_API_BASE || DEFAULT_API_BASE;
  const res = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: process.env.DSC_EMAIL!, password: process.env.DSC_PASSWORD! }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Drug Shortages Canada login failed: ${res.status}`);
  // The token comes back as a response HEADER, not in the body.
  const token = res.headers.get("auth-token");
  if (!token) throw new Error("Drug Shortages Canada login returned no auth-token header");
  cachedToken = token;
  return token;
}

async function liveFetch(din: string): Promise<DscReport[]> {
  const base = process.env.DSC_API_BASE || DEFAULT_API_BASE;
  const run = async (token: string) =>
    fetch(`${base}/search?din=${encodeURIComponent(din)}&limit=100`, {
      headers: { "auth-token": token, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });

  let res = await run(await login());
  if (res.status === 401 || res.status === 403) {
    cachedToken = null; // token expired — one retry with a fresh login
    res = await run(await login());
  }
  if (!res.ok) throw new Error(`Drug Shortages Canada search failed: ${res.status}`);
  const body = (await res.json()) as { data?: DscReport[] } | DscReport[];
  const data = Array.isArray(body) ? body : (body.data ?? []);
  return Array.isArray(data) ? data : [];
}

/** Reads a value from the first key present — DSC field names vary by report type. */
function pick(report: DscReport, keys: string[]): string | null {
  for (const key of keys) {
    const value = report[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

/** Normalizes one raw DSC report; returns null if it carries no usable id. */
export function parseReport(report: DscReport, fallbackDin: string): ShortageRow | null {
  const reportId = pick(report, ["id", "report_id", "shortage_id"]);
  if (!reportId) return null;

  const rawType = (pick(report, ["type", "report_type"]) ?? "").toLowerCase();
  const discontinuationDate = pick(report, ["discontinuation_date"]);
  const kind: ShortageKind =
    rawType.includes("discontinu") || (!rawType && discontinuationDate) ? "discontinuation" : "shortage";
  const status = pick(report, ["status", "en_status", "shortage_status"]) ?? (kind === "discontinuation" ? "discontinued" : "unknown");

  return {
    report_id: reportId,
    kind,
    din: normalizeDin(pick(report, ["din", "drug_identification_number"])) ?? fallbackDin,
    brand_name: pick(report, ["en_drug_brand_name", "drug_brand_name", "brand_name"]),
    company_name: pick(report, ["company_name", "en_company_name"]),
    status,
    state: normalizeState(status, kind),
    reason: pick(report, ["en_shortage_reason", "shortage_reason", "en_reason", "reason"]),
    actual_start_date: pick(report, ["actual_start_date", "anticipated_start_date"]),
    estimated_end_date: pick(report, ["estimated_end_date", "anticipated_end_date"]),
    actual_end_date: pick(report, ["actual_end_date", "discontinuation_date"]),
    source_updated_at: pick(report, ["updated_date", "en_updated_date", "created_date"]),
    fetched_at: new Date().toISOString(),
  };
}

// ---- Cache ----

function upsert(db: DatabaseSync, row: ShortageRow): void {
  db.prepare(
    `INSERT INTO drug_shortages
     (report_id, kind, din, brand_name, company_name, status, state, reason,
      actual_start_date, estimated_end_date, actual_end_date, source_updated_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(report_id, kind) DO UPDATE SET
       din = excluded.din, brand_name = excluded.brand_name, company_name = excluded.company_name,
       status = excluded.status, state = excluded.state, reason = excluded.reason,
       actual_start_date = excluded.actual_start_date, estimated_end_date = excluded.estimated_end_date,
       actual_end_date = excluded.actual_end_date, source_updated_at = excluded.source_updated_at,
       fetched_at = datetime('now')`
  ).run(
    row.report_id,
    row.kind,
    row.din,
    row.brand_name,
    row.company_name,
    row.status,
    row.state,
    row.reason,
    row.actual_start_date,
    row.estimated_end_date,
    row.actual_end_date,
    row.source_updated_at
  );
}

/**
 * SQL predicate for supply-checking scope (the SQL twin of lifecycle.ts
 * inSupplyChecking): verified-medication rows that are taken, planned, or
 * paused. Terminal lifecycles read as legacy status 'stopped'; planned rows
 * carry a lifecycle value, so the OR covers both vintages of data. Used by
 * the sync candidate list AND every read surface — a planned med the sync
 * checks must also be able to SHOW its result.
 */
export const SUPPLY_SCOPE_SQL = `(status = 'active' OR lifecycle_status IN
  ('prescribed','sent_to_pharmacy','dispensed','received_not_started','not_received','temporarily_paused'))`;

/**
 * Every distinct DIN worth checking. A newly prescribed product that is
 * short is exactly the case worth catching before the patient reaches the
 * counter.
 */
export function dinsInUse(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT din FROM medications
       WHERE verified = 1 AND din IS NOT NULL AND ${SUPPLY_SCOPE_SQL}`
    )
    .all() as { din: string }[];
  return [...new Set(rows.map((r) => normalizeDin(r.din)).filter((d): d is string => !!d))];
}

export interface SyncResult {
  outcome: "ok" | "partial" | "error" | "not_configured";
  dins_checked: number;
  reports_upserted: number;
  note: string | null;
}

/**
 * Refreshes the cache for the DINs currently in use. Recently-checked DINs
 * are skipped, and a per-run cap keeps one refresh from hammering the API;
 * whatever is skipped stays honestly "never checked" rather than "clear".
 */
export async function syncShortages(
  db: DatabaseSync,
  opts: { actorUserId?: number | null; limit?: number; force?: boolean } = {}
): Promise<SyncResult> {
  const record = (r: SyncResult) => {
    db.prepare(
      "INSERT INTO shortage_syncs (actor_user_id, outcome, dins_checked, reports_upserted, note) VALUES (?, ?, ?, ?, ?)"
    ).run(opts.actorUserId ?? null, r.outcome, r.dins_checked, r.reports_upserted, r.note);
    return r;
  };

  const fetcher = activeFetcher ?? (shortagesConfigured() ? liveFetch : null);
  if (!fetcher) {
    return record({
      outcome: "not_configured",
      dins_checked: 0,
      reports_upserted: 0,
      note: "DSC_EMAIL / DSC_PASSWORD are not set on this instance.",
    });
  }

  const cutoff = new Date(Date.now() - RECHECK_AFTER_HOURS * 3_600_000).toISOString();
  const all = dinsInUse(db);
  const due = opts.force
    ? all
    : all.filter((din) => {
        const seen = db.prepare("SELECT checked_at FROM shortage_checks WHERE din = ?").get(din) as
          | { checked_at: string }
          | undefined;
        return !seen || seen.checked_at.replace(" ", "T") + "Z" < cutoff;
      });
  const batch = due.slice(0, opts.limit ?? 200);

  let upserted = 0;
  let failures = 0;
  let lastError: string | null = null;
  for (const din of batch) {
    try {
      const reports = await fetcher(din);
      const parsed = reports.map((r) => parseReport(r, din)).filter((r): r is ShortageRow => !!r);
      for (const row of parsed) {
        upsert(db, row);
        upserted++;
      }
      // Stamp the DIN only on success — a failed lookup must not masquerade
      // as a clean check.
      db.prepare(
        `INSERT INTO shortage_checks (din, checked_at, reports_found) VALUES (?, datetime('now'), ?)
         ON CONFLICT(din) DO UPDATE SET checked_at = datetime('now'), reports_found = excluded.reports_found`
      ).run(din, parsed.length);
    } catch (e) {
      failures++;
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  const skipped = due.length - batch.length;
  const notes = [
    failures > 0 ? `${failures} lookup(s) failed: ${lastError}` : null,
    skipped > 0 ? `${skipped} DIN(s) left for the next run` : null,
  ].filter(Boolean);
  return record({
    outcome: failures === batch.length && batch.length > 0 ? "error" : failures > 0 || skipped > 0 ? "partial" : "ok",
    dins_checked: batch.length - failures,
    reports_upserted: upserted,
    note: notes.length ? notes.join("; ") : null,
  });
}

/** Cached reports for a set of DINs, newest first, open states first. */
export function reportsForDins(db: DatabaseSync, dins: string[]): Map<string, ShortageRow[]> {
  const out = new Map<string, ShortageRow[]>();
  if (dins.length === 0) return out;
  const stmt = db.prepare("SELECT * FROM drug_shortages WHERE din = ? ORDER BY state = 'resolved', source_updated_at DESC");
  for (const din of dins) {
    const rows = stmt.all(din) as unknown as ShortageRow[];
    if (rows.length) out.set(din, rows);
  }
  return out;
}

/** The four-state lookup used by every surface. */
export function lookupForMedication(
  db: DatabaseSync,
  med: { din: string | null; verified: number },
  cache?: { checks: Map<string, { checked_at: string }>; reports: Map<string, ShortageRow[]> }
): ShortageLookup {
  if (!shortagesConfigured() && !activeFetcher) {
    // Cached data may still exist from when it WAS configured, so only claim
    // "not configured" when we also have nothing to show.
    const hasAnyData = (db.prepare("SELECT 1 FROM shortage_checks LIMIT 1").get() as unknown) !== undefined;
    if (!hasAnyData) return { state: "not_configured" };
  }
  if (!med.verified) return { state: "not_checkable", why: "Unverified entry — no DIN to check." };
  const din = normalizeDin(med.din);
  if (!din) return { state: "not_checkable", why: "No DIN recorded for this product." };

  const check =
    cache?.checks.get(din) ??
    (db.prepare("SELECT checked_at FROM shortage_checks WHERE din = ?").get(din) as { checked_at: string } | undefined);
  if (!check) return { state: "never_checked" };

  const asOfIso = check.checked_at.replace(" ", "T") + "Z";
  const reports = cache?.reports.get(din) ?? (reportsForDins(db, [din]).get(din) ?? []);
  return {
    state: "checked",
    as_of: asOfIso,
    stale: Date.now() - new Date(asOfIso).getTime() > STALE_AFTER_HOURS * 3_600_000,
    reports,
  };
}

/** Pre-loads checks + reports so a page of medications costs two queries. */
export function loadShortageCache(
  db: DatabaseSync,
  dins: string[]
): { checks: Map<string, { checked_at: string }>; reports: Map<string, ShortageRow[]> } {
  const checks = new Map<string, { checked_at: string }>();
  for (const din of dins) {
    const row = db.prepare("SELECT checked_at FROM shortage_checks WHERE din = ?").get(din) as
      | { checked_at: string }
      | undefined;
    if (row) checks.set(din, row);
  }
  return { checks, reports: reportsForDins(db, dins) };
}

/** Supply-scoped (taken/planned/paused) verified medications of a profile that carry an open shortage report. */
export function countOpenShortages(db: DatabaseSync, profileId: number): number {
  const meds = db
    .prepare(`SELECT din FROM medications WHERE profile_id = ? AND verified = 1 AND din IS NOT NULL AND ${SUPPLY_SCOPE_SQL}`)
    .all(profileId) as { din: string }[];
  const stmt = db.prepare("SELECT COUNT(*) AS n FROM drug_shortages WHERE din = ? AND state != 'resolved'");
  let affected = 0;
  for (const med of meds) {
    const din = normalizeDin(med.din);
    if (!din) continue;
    if ((stmt.get(din) as { n: number }).n > 0) affected++;
  }
  return affected;
}

export function lastSync(db: DatabaseSync): { at: string; outcome: string; note: string | null } | null {
  return (
    (db
      .prepare("SELECT at, outcome, note FROM shortage_syncs ORDER BY id DESC LIMIT 1")
      .get() as { at: string; outcome: string; note: string | null } | undefined) ?? null
  );
}
