// PHI-free pilot metrics (Phase 11). Everything here is an aggregate —
// counts and medians scoped to the requesting clinician's own invitations,
// grants, reviews, and reconciliations. No patient names, emails, labels,
// notes, or ids ever leave this module. Metrics the app cannot yet measure
// are listed explicitly in `not_instrumented` rather than silently omitted.

import type { DatabaseSync } from "node:sqlite";

export interface PilotMetrics {
  invitations: {
    total: number;
    by_status: Record<string, number>;
    /** consented+reviewed over all that reached a terminal-or-live state except cancelled; null when no invitations. */
    completion_rate_pct: number | null;
    median_hours_invite_to_consent: number | null;
    median_hours_consent_to_review: number | null;
  };
  reconciliation: {
    sessions_completed: number;
    median_minutes_to_complete: number | null;
    avg_flags_per_reviewed_med: number | null;
    dispositions: Record<string, number>;
  };
  patients: {
    active_grants: number;
    pending_requests: number;
    revoked_grants: number;
    expired_grants: number;
  };
  safety: {
    open_duplicate_alerts: number;
    open_interaction_alerts: number;
    unverified_medications: number;
    active_reviews: number;
    total_reviews: number;
  };
  /** Honesty list: metrics from the pilot plan the app does not measure yet. */
  not_instrumented: string[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** SQLite datetime('now') strings are UTC without a zone marker. */
function utcMs(sqliteDt: string): number {
  return new Date(sqliteDt.replace(" ", "T") + (sqliteDt.endsWith("Z") ? "" : "Z")).getTime();
}

function hoursBetween(a: string, b: string): number {
  return Math.round(((utcMs(b) - utcMs(a)) / 3_600_000) * 10) / 10;
}

export function computePilotMetrics(db: DatabaseSync, clinicianUserId: number): PilotMetrics {
  // Invitation funnel — statuses as stored (lazy expiry has already run for
  // any invitation that was read; unread expired ones still say 'created',
  // which is honest: nobody ever saw them).
  const invitations = db
    .prepare("SELECT status, created_at, consented_at, reviewed_at FROM patient_invitations WHERE clinician_user_id = ?")
    .all(clinicianUserId) as unknown as {
    status: string;
    created_at: string;
    consented_at: string | null;
    reviewed_at: string | null;
  }[];

  const by_status: Record<string, number> = {};
  for (const inv of invitations) by_status[inv.status] = (by_status[inv.status] ?? 0) + 1;

  const consentedLike = invitations.filter((i) => i.status === "consented" || i.status === "reviewed");
  const eligible = invitations.filter((i) => i.status !== "cancelled").length;
  const toConsent = consentedLike
    .filter((i) => i.consented_at)
    .map((i) => hoursBetween(i.created_at, i.consented_at!));
  const toReview = invitations
    .filter((i) => i.status === "reviewed" && i.consented_at && i.reviewed_at)
    .map((i) => hoursBetween(i.consented_at!, i.reviewed_at!));

  // Reconciliation throughput + discrepancy density from flag snapshots.
  const sessions = db
    .prepare(
      "SELECT id, started_at, completed_at FROM reconciliation_sessions WHERE clinician_user_id = ? AND status = 'completed'"
    )
    .all(clinicianUserId) as unknown as { id: number; started_at: string; completed_at: string }[];
  const sessionMinutes = sessions.map((s) => Math.round((utcMs(s.completed_at) - utcMs(s.started_at)) / 60_000));

  const items = db
    .prepare(
      `SELECT ri.flags, ri.disposition FROM reconciliation_items ri
       JOIN reconciliation_sessions rs ON rs.id = ri.session_id
       WHERE rs.clinician_user_id = ?`
    )
    .all(clinicianUserId) as unknown as { flags: string; disposition: string }[];
  const dispositions: Record<string, number> = {};
  let flagTotal = 0;
  for (const item of items) {
    dispositions[item.disposition] = (dispositions[item.disposition] ?? 0) + 1;
    try {
      flagTotal += (JSON.parse(item.flags) as string[]).length;
    } catch {
      // unparseable snapshot — count as zero flags rather than guessing
    }
  }

  // Grant lifecycle counts for this clinician.
  const grantCounts = db
    .prepare("SELECT status, COUNT(*) AS n FROM access_grants WHERE clinician_user_id = ? GROUP BY status")
    .all(clinicianUserId) as unknown as { status: string; n: number }[];
  const grantOf = (s: string) => grantCounts.find((g) => g.status === s)?.n ?? 0;

  // Safety aggregates across CURRENTLY GRANTED patients only — access rules
  // apply to metrics exactly as they apply to records.
  const grantedProfiles = db
    .prepare(
      `SELECT profile_id FROM access_grants
       WHERE clinician_user_id = ? AND status = 'active'
         AND (expires_at IS NULL OR expires_at > datetime('now'))`
    )
    .all(clinicianUserId) as unknown as { profile_id: number }[];
  const pin = grantedProfiles.length ? grantedProfiles.map((g) => g.profile_id).join(",") : "-1";

  const openAlerts = db
    .prepare(
      `SELECT kind, COUNT(*) AS n FROM alerts
       WHERE profile_id IN (${pin}) AND acknowledged_at IS NULL GROUP BY kind`
    )
    .all() as unknown as { kind: string; n: number }[];
  const unverified = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM medications WHERE profile_id IN (${pin}) AND status = 'active' AND verified = 0`
      )
      .get() as { n: number }
  ).n;

  const reviews = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN revoked_at IS NULL AND expires_at > ? THEN 1 ELSE 0 END) AS active
       FROM alert_reviews WHERE reviewer_user_id = ?`
    )
    .get(new Date().toISOString(), clinicianUserId) as { total: number; active: number | null };

  return {
    invitations: {
      total: invitations.length,
      by_status,
      completion_rate_pct: eligible > 0 ? Math.round((100 * consentedLike.length) / eligible) : null,
      median_hours_invite_to_consent: median(toConsent),
      median_hours_consent_to_review: median(toReview),
    },
    reconciliation: {
      sessions_completed: sessions.length,
      median_minutes_to_complete: median(sessionMinutes),
      avg_flags_per_reviewed_med: items.length > 0 ? Math.round((10 * flagTotal) / items.length) / 10 : null,
      dispositions,
    },
    patients: {
      active_grants: grantedProfiles.length,
      pending_requests: grantOf("pending"),
      revoked_grants: grantOf("revoked"),
      expired_grants: grantOf("expired"),
    },
    safety: {
      open_duplicate_alerts: openAlerts.find((a) => a.kind === "duplicate")?.n ?? 0,
      open_interaction_alerts: openAlerts.find((a) => a.kind === "interaction")?.n ?? 0,
      unverified_medications: unverified,
      active_reviews: reviews.active ?? 0,
      total_reviews: reviews.total,
    },
    not_instrumented: [
      "reopened alerts after material rule changes (needs an event log)",
      "intake drop-off timing within the wizard (only stage counts are recorded)",
    ],
  };
}
