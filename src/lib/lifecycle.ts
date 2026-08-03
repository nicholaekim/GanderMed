// Medication lifecycle (dependency-free — safe for client and server).
//
// GanderMed preserves three separate truths about every medication:
//   1. what was PRESCRIBED        (prescribed_* columns, immutable)
//   2. what the patient RECEIVED  (patient_received_at / dispensed_at)
//   3. what the patient reports ACTUALLY TAKING (the operative dose/schedule
//      columns + actual_use + dose logs)
// The lifecycle status tracks where a medication sits between those truths.
// Nothing here is an e-prescription: clinician-entered rows are medication
// PLANS recorded after a prescription was written outside GanderMed.
//
// Every calculation-eligibility question is answered by a helper below —
// never by comparing status strings at call sites.

export const LIFECYCLE_STATUSES = [
  "prescribed",
  "sent_to_pharmacy",
  "dispensed",
  "received_not_started",
  "currently_taking",
  "taking_differently",
  "temporarily_paused",
  "not_received",
  "declined",
  "cancelled",
  "replaced",
  "stopped",
  "completed",
] as const;

export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

export const LIFECYCLE_LABELS: Record<LifecycleStatus, string> = {
  prescribed: "Prescribed — not yet received",
  // "Reported" prefix: GanderMed never transmits prescriptions, so these two
  // states (schema-ready, not yet writable by any route) must not read as if
  // it did.
  sent_to_pharmacy: "Reported sent to pharmacy",
  dispensed: "Reported dispensed — not yet picked up",
  received_not_started: "Received — not yet started",
  currently_taking: "Patient reports currently taking",
  taking_differently: "Patient reports taking differently",
  temporarily_paused: "Temporarily paused",
  not_received: "Not received",
  declined: "Declined",
  cancelled: "Cancelled",
  replaced: "Replaced",
  stopped: "Stopped",
  completed: "Completed",
};

/** Where the medication record came from (immutable at creation). */
export const SOURCE_TYPES = [
  "patient_reported",
  "clinician_medication_plan",
  "pharmacy_dispensing_record",
  "prescriber_record",
  "hospital_discharge_record",
  "imported_record",
  "manual_unverified",
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

export const SOURCE_LABELS: Record<SourceType, string> = {
  patient_reported: "Entered by the patient",
  clinician_medication_plan: "Medication plan entered by a care-team member",
  pharmacy_dispensing_record: "Pharmacy dispensing record",
  prescriber_record: "Prescriber record",
  hospital_discharge_record: "Hospital discharge record",
  imported_record: "Imported record",
  manual_unverified: "Manual entry (unverified)",
};

/** The minimal shape the helpers need — every medications row satisfies it. */
export interface LifecycleCarrier {
  lifecycle_status?: LifecycleStatus | null;
  status: "active" | "stopped";
}

/**
 * Rows created before the lifecycle migration (and bare test fixtures) may
 * carry a NULL lifecycle_status; the legacy status column is then the best
 * available statement of reality.
 */
export function effectiveLifecycle(med: LifecycleCarrier): LifecycleStatus {
  if (med.lifecycle_status && (LIFECYCLE_STATUSES as readonly string[]).includes(med.lifecycle_status)) {
    return med.lifecycle_status;
  }
  return med.status === "active" ? "currently_taking" : "stopped";
}

const PLANNED: ReadonlySet<LifecycleStatus> = new Set([
  "prescribed",
  "sent_to_pharmacy",
  "dispensed",
  "received_not_started",
  "not_received",
]);

const CURRENTLY_TAKEN: ReadonlySet<LifecycleStatus> = new Set(["currently_taking", "taking_differently"]);

const TERMINAL: ReadonlySet<LifecycleStatus> = new Set(["declined", "cancelled", "replaced", "stopped", "completed"]);

/**
 * Terminal states that were never taken: nothing was received or started, so
 * there is no adherence history to keep (unlike stopped/completed/replaced,
 * which clamp to their real start/end dates).
 */
const NEVER_TAKEN: ReadonlySet<LifecycleStatus> = new Set(["declined", "cancelled", "not_received"]);

/** A plan the patient has not confirmed starting (includes not-yet-received problems). */
export function isPlanned(med: LifecycleCarrier): boolean {
  return PLANNED.has(effectiveLifecycle(med));
}

/** The patient reports actually taking it right now (as listed or differently). */
export function isCurrentlyTaken(med: LifecycleCarrier): boolean {
  return CURRENTLY_TAKEN.has(effectiveLifecycle(med));
}

export function isPaused(med: LifecycleCarrier): boolean {
  return effectiveLifecycle(med) === "temporarily_paused";
}

/** Ended one way or another; history only. */
export function isTerminal(med: LifecycleCarrier): boolean {
  return TERMINAL.has(effectiveLifecycle(med));
}

/** Today's dose schedule + expected adherence slots: confirmed current use only. */
export function inDoseSchedule(med: LifecycleCarrier): boolean {
  return isCurrentlyTaken(med);
}

/**
 * Adherence slot generation. Planned meds have no expectations yet; paused
 * meds have their expectations suspended (documented simplification: a
 * paused med's past slots leave the window rather than being split at the
 * pause date). Declined/cancelled plans were never taken — including them
 * would fabricate "missed" doses for a medication the patient refused.
 * Stopped/completed/replaced meds keep their history via the existing
 * start/end-date clamps.
 */
export function inAdherence(med: LifecycleCarrier): boolean {
  return !isPlanned(med) && !isPaused(med) && !NEVER_TAKEN.has(effectiveLifecycle(med));
}

/** Estimated active-window modeling: only what the patient is actually taking. */
export function inExposureWindows(med: LifecycleCarrier): boolean {
  return isCurrentlyTaken(med);
}

/**
 * Deterministic interaction checking. Current medications produce
 * current-use concerns; planned and paused ones still deserve checking, but
 * their alerts are classified 'planned' (see alertConcernClass) — severity
 * is NEVER reduced by lifecycle state.
 */
export function inConflictChecking(med: LifecycleCarrier): boolean {
  return isCurrentlyTaken(med) || isPlanned(med) || isPaused(med);
}

/** Supply/shortage lookups: anything the patient takes or is about to take. */
export function inSupplyChecking(med: LifecycleCarrier): boolean {
  return !isTerminal(med);
}

/**
 * An alert's concern class: 'current' only when BOTH sides are confirmed
 * current use; a pair involving an unstarted plan is 'planned'; otherwise a
 * pair involving a paused medication is 'paused' (it is NOT newly prescribed
 * and NOT current exposure — saying "not started" about a med taken for
 * months would be false). The class is computed at read time, so confirming
 * a start flips the same alert row (acknowledgments and reviews survive).
 * Severity is never touched by any of this.
 */
export function alertConcernClass(medA: LifecycleCarrier, medB: LifecycleCarrier): "current" | "planned" | "paused" {
  if (isPlanned(medA) || isPlanned(medB)) return "planned";
  if (isPaused(medA) || isPaused(medB)) return "paused";
  return "current";
}

/**
 * The reconciliation workspace covers everything still in play: current and
 * paused meds, every unconfirmed plan, and declined/cancelled/not-received
 * plans awaiting follow-up. Only stopped/completed/replaced are history.
 * Used by the workspace query, the coverage snapshot (meds_total), and the
 * UI gate — one list, so they can never disagree.
 */
export const RECON_WORKSPACE_STATUSES: readonly LifecycleStatus[] = LIFECYCLE_STATUSES.filter(
  (s) => s !== "stopped" && s !== "completed" && s !== "replaced"
);

export function inReconWorkspace(med: LifecycleCarrier): boolean {
  return (RECON_WORKSPACE_STATUSES as readonly string[]).includes(effectiveLifecycle(med));
}

/** Legacy status mirror: anything not current-ish reads 'stopped', so code paths not yet lifecycle-aware fail SAFE (planned meds excluded, never included). */
export function legacyStatusFor(lifecycle: LifecycleStatus): "active" | "stopped" {
  return CURRENTLY_TAKEN.has(lifecycle) || lifecycle === "temporarily_paused" ? "active" : "stopped";
}
