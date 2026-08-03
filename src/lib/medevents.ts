// Medication lifecycle event log + in-app notifications.
//
// Events are append-only history: who did what to a medication and when.
// Meta stays structured and safe — ids, enum strings, dates, and the short
// texts the event itself is about (a stop reason); never credentials,
// tokens, or unrelated free text.
//
// Notifications are in-app only for now, but carry everything a later
// email/push channel needs (type, recipient, dedupe key).

import type { DatabaseSync } from "node:sqlite";

export function logMedEvent(
  db: DatabaseSync,
  event: {
    medicationId: number;
    profileId: number;
    type: string;
    actorUserId: number | null;
    actorRole: "patient" | "clinician" | "system";
    meta?: Record<string, string | number | null>;
  }
): void {
  db.prepare(
    `INSERT INTO medication_events (medication_id, profile_id, event_type, actor_user_id, actor_role, meta)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    event.medicationId,
    event.profileId,
    event.type,
    event.actorUserId,
    event.actorRole,
    event.meta ? JSON.stringify(event.meta) : null
  );
}

export interface MedEventView {
  event_type: string;
  actor_role: string;
  actor_name: string | null;
  at: string;
  meta: string | null;
}

export function listMedEvents(db: DatabaseSync, medicationId: number): MedEventView[] {
  return db
    .prepare(
      `SELECT e.event_type, e.actor_role, u.display_name AS actor_name, e.at, e.meta
       FROM medication_events e LEFT JOIN users u ON u.id = e.actor_user_id
       WHERE e.medication_id = ? ORDER BY e.at, e.id`
    )
    .all(medicationId) as unknown as MedEventView[];
}

/**
 * Consent gate for clinician-directed notifications: the plan's creator only
 * hears about patient actions while they STILL hold live access (an
 * unexpired individual grant, or an org grant while they are an active
 * member). Revocation cuts the flow immediately — matching the access model
 * everywhere else. Notifications already delivered are the clinician's own
 * copies and are not redacted, like the audit trail.
 */
export function clinicianHasLiveAccess(db: DatabaseSync, clinicianUserId: number, profileId: number): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM access_grants g
       WHERE g.profile_id = ? AND g.status = 'active'
         AND (g.expires_at IS NULL OR g.expires_at > ?)
         AND ((g.organization_id IS NULL AND g.clinician_user_id = ?)
           OR (g.organization_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM organization_members m
             WHERE m.organization_id = g.organization_id AND m.user_id = ? AND m.status = 'active')))
       LIMIT 1`
    )
    .get(profileId, new Date().toISOString(), clinicianUserId, clinicianUserId);
}

export function notify(
  db: DatabaseSync,
  n: {
    userId: number;
    profileId?: number | null;
    medicationId?: number | null;
    type: string;
    body: string;
    dedupeKey?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO notifications (user_id, profile_id, medication_id, type, body, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`
  ).run(n.userId, n.profileId ?? null, n.medicationId ?? null, n.type, n.body, n.dedupeKey ?? null);
}

/** Days before an unconfirmed plan nudges its creator. */
export function notReceivedAfterDays(): number {
  const n = Number(process.env.NOTIFY_NOT_RECEIVED_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

/**
 * Lazy nudge generation, run when a clinician reads their notifications:
 * plans they entered that are still unreceived (or received but unstarted)
 * after the configured window. Dedupe keys make this idempotent.
 */
export function generateClinicianNudges(db: DatabaseSync, clinicianUserId: number): void {
  const cutoff = new Date(Date.now() - notReceivedAfterDays() * 86_400_000).toISOString().replace("T", " ").slice(0, 19);
  const stale = db
    .prepare(
      `SELECT id, profile_id, brand_name, lifecycle_status FROM medications
       WHERE source_user_id = ? AND source_type = 'clinician_medication_plan'
         AND lifecycle_status IN ('prescribed','sent_to_pharmacy','dispensed','received_not_started')
         AND created_at <= ?`
    )
    .all(clinicianUserId, cutoff) as { id: number; profile_id: number; brand_name: string; lifecycle_status: string }[];
  for (const med of stale) {
    // No live grant → no nudge (consent gate; see clinicianHasLiveAccess).
    if (!clinicianHasLiveAccess(db, clinicianUserId, med.profile_id)) continue;
    const unreceived = med.lifecycle_status !== "received_not_started";
    notify(db, {
      userId: clinicianUserId,
      profileId: med.profile_id,
      medicationId: med.id,
      type: unreceived ? "plan_not_received" : "plan_not_started",
      body: unreceived
        ? `${med.brand_name}: the patient hasn't confirmed receiving this medication plan after ${notReceivedAfterDays()} days.`
        : `${med.brand_name}: received ${notReceivedAfterDays()}+ days ago but the patient hasn't confirmed starting it.`,
      dedupeKey: `${unreceived ? "plan_not_received" : "plan_not_started"}:${med.id}`,
    });
  }
}
