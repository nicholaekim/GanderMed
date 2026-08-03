// Reconciliation workspace (Phase 10) — MedsCheck preparation.
//
// The system computes deterministic DISCREPANCY FLAGS per medication and a
// pharmacist records a DISPOSITION per medication inside a session. The
// rules that keep this honest:
//   - Flags are deterministic functions of the record (actual-use status,
//     verification, alerts, adherence). No model, no thresholds, no
//     auto-resolution — the system NEVER decides which list is correct.
//   - Dispositions are human judgments, stamped with who + when, snapshotted
//     with the flags that were showing at the time.
//   - 'confirmed' is the one disposition with a side effect: the medication's
//     provenance becomes 'pharmacy-confirmed'. A later material dose/schedule
//     edit reverts it to 'patient-reported' (the confirmation described a
//     state that no longer exists).

import type { DatabaseSync } from "node:sqlite";
import { recomputeAlerts } from "@/lib/conflicts";
import { attachReviews } from "@/lib/reviews";
import { computeAdherence } from "@/lib/adherence";
import { loadShortageCache, lookupForMedication, normalizeDin } from "@/lib/shortages";
import { effectiveLifecycle, inReconWorkspace, isCurrentlyTaken, isPlanned } from "@/lib/lifecycle";
import { logAudit } from "@/lib/access";
import { DISPOSITION_LABELS, type Disposition, type Medication } from "@/lib/types";

export type { Disposition };
export const DISPOSITIONS = DISPOSITION_LABELS;

export interface DiscrepancyFlag {
  code:
    | "unverified"
    | "not_taking"
    | "taking_differently"
    | "recently_stopped"
    | "patient_unsure"
    | "missing_dose"
    | "missing_schedule"
    | "duplicate_ingredient"
    | "interaction_unreviewed"
    | "missed_doses"
    | "patient_note"
    | "supply_shortage"
    | "supply_discontinued"
    | "not_received"
    | "received_not_started"
    | "declined_to_start"
    | "plan_cancelled"
    | "paused"
    | "dose_differs_from_prescription"
    | "schedule_differs_from_prescription"
    | "prescriber_instructions_missing";
  label: string;
  detail: string | null;
}

export interface ReconcileItemView {
  medication_id: number;
  flags: DiscrepancyFlag[];
  disposition: Disposition | null;
  note: string | null;
  disposed_by_name: string | null;
  disposed_at: string | null;
}

export interface SessionRow {
  id: number;
  profile_id: number;
  clinician_user_id: number;
  clinician_name: string;
  clinic_name: string | null;
  status: "open" | "completed";
  started_at: string;
  completed_at: string | null;
  summary_note: string | null;
  meds_total: number | null;
}

/**
 * Deterministic discrepancy flags for every medication of a profile.
 * Reviewed or acknowledged alerts don't flag — they're already handled;
 * hiding them here is not suppression because the alerts themselves stay
 * visible in the alerts panel.
 */
export function computeFlags(db: DatabaseSync, profileId: number): Map<number, DiscrepancyFlag[]> {
  const meds = db
    .prepare("SELECT * FROM medications WHERE profile_id = ?")
    .all(profileId) as unknown as Medication[];

  const { all: alerts } = recomputeAlerts(db, profileId);
  attachReviews(db, profileId, alerts);
  const adherence = computeAdherence(db, profileId, 14);
  const adherenceByMed = new Map(adherence.per_med.map((m) => [m.medication_id, m]));
  const shortageCache = loadShortageCache(
    db,
    meds.map((m) => normalizeDin(m.din)).filter((d): d is string => !!d)
  );

  const flags = new Map<number, DiscrepancyFlag[]>();
  const add = (medId: number, flag: DiscrepancyFlag) => {
    if (!flags.has(medId)) flags.set(medId, []);
    flags.get(medId)!.push(flag);
  };

  for (const med of meds) {
    // Reconciliation covers everything still in play: current, paused, and
    // planned medications, plus declined/cancelled plans awaiting follow-up.
    // Quietly ended meds (stopped/completed/replaced) are history. The same
    // list drives the workspace query and the coverage snapshot.
    const lifecycle = effectiveLifecycle(med);
    if (!inReconWorkspace(med)) continue;

    // Lifecycle discrepancies — the system states facts, never decides who
    // is right.
    if (lifecycle === "prescribed" || lifecycle === "sent_to_pharmacy" || lifecycle === "dispensed") {
      add(med.id, {
        code: "not_received",
        label: "Prescribed — patient hasn't confirmed receiving it",
        detail: med.prescribed_at ? `Prescribed ${med.prescribed_at}` : null,
      });
    }
    if (lifecycle === "not_received") {
      add(med.id, { code: "not_received", label: "Patient reports not receiving it", detail: med.stop_reason });
    }
    if (lifecycle === "received_not_started") {
      add(med.id, {
        code: "received_not_started",
        label: "Received — not started",
        detail: med.patient_received_at ? `Received ${med.patient_received_at.slice(0, 10)}` : null,
      });
    }
    if (lifecycle === "declined") {
      add(med.id, { code: "declined_to_start", label: "Patient declined to start", detail: med.stop_reason });
    }
    if (lifecycle === "cancelled") {
      add(med.id, { code: "plan_cancelled", label: "Prescription cancelled or replaced", detail: med.stop_reason });
    }
    if (lifecycle === "temporarily_paused") {
      add(med.id, { code: "paused", label: "Temporarily paused", detail: med.stop_reason });
    }

    // Prescribed vs patient-reported divergence — only meaningful once the
    // patient actually started and both sides of the comparison exist.
    if (isCurrentlyTaken(med) && med.prescribed_at) {
      if (
        med.prescribed_dose_value != null &&
        (med.dose_value !== med.prescribed_dose_value || (med.dose_unit ?? "") !== (med.prescribed_dose_unit ?? ""))
      ) {
        add(med.id, {
          code: "dose_differs_from_prescription",
          label: "Patient reports a different dose than prescribed",
          detail: `Prescribed ${med.prescribed_dose_value} ${med.prescribed_dose_unit ?? ""} · patient reports ${med.dose_value ?? "?"} ${med.dose_unit ?? ""}`,
        });
      }
      const prescribedSchedule = med.prescribed_schedule_times ?? "[]";
      const prescribedPrn = med.prescribed_is_prn ?? 0;
      if (med.schedule_times !== prescribedSchedule || med.is_prn !== prescribedPrn) {
        add(med.id, {
          code: "schedule_differs_from_prescription",
          label: "Patient reports a different schedule than prescribed",
          detail: `Prescribed ${prescribedPrn ? "as needed" : JSON.parse(prescribedSchedule).join(", ") || "no times"} · patient reports ${med.is_prn ? "as needed" : JSON.parse(med.schedule_times).join(", ") || "no times"}`,
        });
      }
    }
    if (med.source_type === "clinician_medication_plan" && !med.prescribed_instructions) {
      add(med.id, { code: "prescriber_instructions_missing", label: "Prescriber instructions missing", detail: null });
    }

    // Supply status — informational only, and it applies to PLANNED meds too
    // (a shortage is worth knowing before the patient reaches the counter).
    // It never touches alerts or severity, and the app never proposes a
    // substitute; only reports we actually retrieved can produce a flag.
    const supply = lookupForMedication(db, med, shortageCache);
    if (supply.state === "checked") {
      for (const report of supply.reports.filter((r) => r.state !== "resolved")) {
        const detail = [
          report.reason,
          report.estimated_end_date ? `Estimated end ${report.estimated_end_date}` : null,
          `Reported to Health Canada${report.source_updated_at ? ` · updated ${report.source_updated_at}` : ""}`,
        ]
          .filter(Boolean)
          .join(" · ");
        if (report.kind === "discontinuation") {
          add(med.id, { code: "supply_discontinued", label: "Discontinued by the manufacturer", detail });
        } else {
          const label =
            report.state === "anticipated"
              ? "Anticipated supply shortage"
              : report.state === "unknown"
                ? `Shortage report (status: ${report.status})`
                : "Active supply shortage";
          add(med.id, { code: "supply_shortage", label, detail });
        }
      }
    }

    if (isPlanned(med)) continue; // usage-based flags below apply to taken meds

    if (!med.verified) {
      add(med.id, {
        code: "unverified",
        label: "Unverified entry",
        detail: "Free-text medication — excluded from conflict checking. Match it to a DPD product if possible.",
      });
    }
    if (med.actual_use === "not_taking") {
      add(med.id, { code: "not_taking", label: "Patient reports not taking this", detail: null });
    }
    if (med.actual_use === "taking_differently") {
      add(med.id, { code: "taking_differently", label: "Taken differently than listed", detail: med.patient_notes });
    }
    if (med.actual_use === "recently_stopped") {
      add(med.id, { code: "recently_stopped", label: "Patient reports recently stopping", detail: null });
    }
    if (med.actual_use === "unsure") {
      add(med.id, { code: "patient_unsure", label: "Patient unsure about this medication", detail: null });
    }
    if (med.dose_value == null || !med.dose_unit) {
      add(med.id, { code: "missing_dose", label: "No dose recorded", detail: null });
    }
    if (med.is_prn === 0 && med.schedule_times === "[]") {
      add(med.id, { code: "missing_schedule", label: "Scheduled medication with no times", detail: null });
    }
    if (med.actual_use !== "taking_differently" && med.patient_notes) {
      add(med.id, { code: "patient_note", label: "Patient note", detail: med.patient_notes });
    }

    const ad = adherenceByMed.get(med.id);
    if (ad && !ad.is_prn && ad.counts.missed > 0) {
      add(med.id, {
        code: "missed_doses",
        label: `${ad.counts.missed} missed dose${ad.counts.missed === 1 ? "" : "s"} (14 days)`,
        detail: ad.adherence_pct !== null ? `Adherence ${ad.adherence_pct}%` : null,
      });
    }
  }

  for (const a of alerts) {
    if (a.acknowledged_at || a.review) continue;
    const cls = a.concern_class ?? "current";
    const prefix = cls === "planned" ? "Planned " : cls === "paused" ? "Paused-med " : "";
    const clsDetail =
      cls === "planned"
        ? " — involves a medication the patient hasn't confirmed starting"
        : cls === "paused"
          ? " — involves a temporarily paused medication"
          : "";
    const flag: DiscrepancyFlag =
      a.kind === "duplicate"
        ? {
            code: "duplicate_ingredient",
            label: `${prefix ? `${prefix}duplicate` : "Duplicate ingredient"}: ${a.ingredient_a}`,
            detail: `${a.med_a_name} + ${a.med_b_name}${clsDetail}`,
          }
        : {
            code: "interaction_unreviewed",
            label: `${prefix ? `${prefix}interaction` : "Open interaction"}: ${a.ingredient_a} + ${a.ingredient_b}`,
            detail: `${a.severity} severity — ${cls === "current" ? "not yet reviewed or acknowledged" : clsDetail.slice(3)}`,
          };
    for (const medId of [a.med_a_id, a.med_b_id]) {
      // Duplicate flags list both product names already; avoid double-adding
      // the identical flag object so each med carries its own copy.
      add(medId, { ...flag });
    }
  }

  return flags;
}

export function getOpenSession(db: DatabaseSync, profileId: number, clinicianUserId: number): SessionRow | null {
  return (
    (db
      .prepare(
        "SELECT * FROM reconciliation_sessions WHERE profile_id = ? AND clinician_user_id = ? AND status = 'open'"
      )
      .get(profileId, clinicianUserId) as SessionRow | undefined) ?? null
  );
}

export function getLastCompleted(db: DatabaseSync, profileId: number): (SessionRow & { disposed: number }) | null {
  const row = db
    .prepare(
      "SELECT * FROM reconciliation_sessions WHERE profile_id = ? AND status = 'completed' ORDER BY completed_at DESC, id DESC LIMIT 1"
    )
    .get(profileId) as SessionRow | undefined;
  if (!row) return null;
  const disposed = (
    db.prepare("SELECT COUNT(*) AS n FROM reconciliation_items WHERE session_id = ?").get(row.id) as { n: number }
  ).n;
  return { ...row, disposed };
}

export function startSession(
  db: DatabaseSync,
  profileId: number,
  clinician: { id: number; display_name: string; clinic_name: string | null }
): SessionRow {
  const existing = getOpenSession(db, profileId, clinician.id);
  if (existing) return existing; // resuming is the normal path, not an error

  const info = db
    .prepare(
      `INSERT INTO reconciliation_sessions (profile_id, clinician_user_id, clinician_name, clinic_name)
       VALUES (?, ?, ?, ?)`
    )
    .run(profileId, clinician.id, clinician.display_name, clinician.clinic_name);
  const id = Number(info.lastInsertRowid);
  logAudit(db, { actor: clinician.id, action: "reconciliation_started", profileId, targetId: id });
  return db.prepare("SELECT * FROM reconciliation_sessions WHERE id = ?").get(id) as unknown as SessionRow;
}

export function disposeItem(
  db: DatabaseSync,
  session: SessionRow,
  medicationId: number,
  disposition: Disposition,
  note: string | null,
  actor: { id: number; display_name: string }
): { error?: string } {
  const med = db
    .prepare("SELECT id, provenance FROM medications WHERE id = ? AND profile_id = ?")
    .get(medicationId, session.profile_id) as { id: number; provenance: string } | undefined;
  if (!med) return { error: "not_found" };

  const currentFlags = computeFlags(db, session.profile_id).get(medicationId) ?? [];

  // Re-disposing within a session replaces the earlier judgment (who+when
  // update too); history across sessions is preserved by sessions being
  // append-only.
  db.prepare(
    `INSERT INTO reconciliation_items (session_id, medication_id, flags, disposition, note, disposed_by_user_id, disposed_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, medication_id) DO UPDATE SET
       flags = excluded.flags, disposition = excluded.disposition, note = excluded.note,
       disposed_by_user_id = excluded.disposed_by_user_id, disposed_by_name = excluded.disposed_by_name,
       disposed_at = datetime('now')`
  ).run(session.id, medicationId, JSON.stringify(currentFlags.map((f) => f.code)), disposition, note, actor.id, actor.display_name);

  // The one disposition with a side effect: confirmation attests the entry
  // is correct as listed, so its provenance becomes pharmacy-confirmed.
  // (A later material dose/schedule edit reverts it — see medications PATCH.)
  if (disposition === "confirmed") {
    db.prepare("UPDATE medications SET provenance = 'pharmacy-confirmed' WHERE id = ?").run(medicationId);
  }

  logAudit(db, {
    actor: actor.id,
    action: "reconciliation_item_disposed",
    profileId: session.profile_id,
    targetId: medicationId,
    meta: { session: session.id, disposition },
  });
  return {};
}

export function completeSession(
  db: DatabaseSync,
  session: SessionRow,
  summaryNote: string | null,
  actorUserId: number
): SessionRow {
  // Coverage snapshot counts the SAME set the workspace shows (current +
  // paused + plans + follow-up-worthy terminals) — otherwise disposing a
  // planned med yields "2 of 1 medications reviewed".
  const medsTotal = (
    db
      .prepare("SELECT id, status, lifecycle_status FROM medications WHERE profile_id = ?")
      .all(session.profile_id) as unknown as Medication[]
  ).filter((m) => inReconWorkspace(m)).length;
  db.prepare(
    `UPDATE reconciliation_sessions
     SET status = 'completed', completed_at = datetime('now'), summary_note = ?, meds_total = ?
     WHERE id = ?`
  ).run(summaryNote, medsTotal, session.id);
  logAudit(db, { actor: actorUserId, action: "reconciliation_completed", profileId: session.profile_id, targetId: session.id });
  return db.prepare("SELECT * FROM reconciliation_sessions WHERE id = ?").get(session.id) as unknown as SessionRow;
}

/** Items of a session as a medication_id-keyed map. */
export function sessionItems(db: DatabaseSync, sessionId: number): Map<number, ReconcileItemView> {
  const rows = db
    .prepare(
      "SELECT medication_id, flags, disposition, note, disposed_by_name, disposed_at FROM reconciliation_items WHERE session_id = ?"
    )
    .all(sessionId) as unknown as {
    medication_id: number;
    flags: string;
    disposition: Disposition;
    note: string | null;
    disposed_by_name: string;
    disposed_at: string;
  }[];
  return new Map(
    rows.map((r) => [
      r.medication_id,
      {
        medication_id: r.medication_id,
        flags: [], // stored codes are a snapshot; live flags come from computeFlags
        disposition: r.disposition,
        note: r.note,
        disposed_by_name: r.disposed_by_name,
        disposed_at: r.disposed_at,
      },
    ])
  );
}
