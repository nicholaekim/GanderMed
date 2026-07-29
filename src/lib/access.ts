// Patient-controlled access: consent grants and the audit trail.
//
// Entering a care code no longer grants access — it creates a PENDING
// request that the patient must approve. Grants can carry an expiry, are
// revocable by the patient at any time (and withdrawable by the clinician),
// and every lifecycle step lands in audit_events. Enforcement lives in
// resolveProfileAccess (src/lib/auth.ts), which honours only 'active',
// unexpired grants.

import type { DatabaseSync } from "node:sqlite";
import { generateShareCode } from "@/lib/auth";

export type GrantStatus = "pending" | "active" | "denied" | "revoked" | "expired";

export interface GrantRow {
  id: number;
  profile_id: number;
  clinician_user_id: number;
  status: GrantStatus;
  purpose: string | null;
  requested_at: string;
  decided_at: string | null;
  starts_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export const ACCESS_PURPOSES = [
  "Medication review",
  "MedsCheck preparation",
  "Post-discharge reconciliation",
  "Other",
] as const;

// Audit metadata must stay PHI-free: ids and category strings only.
export function logAudit(
  db: DatabaseSync,
  event: { actor: number | null; action: string; profileId?: number | null; targetId?: number | null; meta?: Record<string, string | number> }
): void {
  db.prepare(
    "INSERT INTO audit_events (actor_user_id, action, profile_id, target_id, meta) VALUES (?, ?, ?, ?, ?)"
  ).run(
    event.actor,
    event.action,
    event.profileId ?? null,
    event.targetId ?? null,
    event.meta ? JSON.stringify(event.meta) : null
  );
}

/** Lazily expires an active grant whose expiry has passed. Returns the current status. */
export function sweepExpiry(db: DatabaseSync, grant: Pick<GrantRow, "id" | "status" | "expires_at" | "profile_id">): GrantStatus {
  if (grant.status === "active" && grant.expires_at && grant.expires_at <= new Date().toISOString()) {
    db.prepare("UPDATE access_grants SET status = 'expired' WHERE id = ? AND status = 'active'").run(grant.id);
    logAudit(db, { actor: null, action: "access_expired", profileId: grant.profile_id, targetId: grant.id });
    return "expired";
  }
  return grant.status;
}

export function requestAccessByCode(
  db: DatabaseSync,
  clinicianUserId: number,
  code: string,
  purpose: string
): { grant: GrantRow; patient_name: string } | { error: "not_found" | "already_open" } {
  const profile = db
    .prepare("SELECT id, name FROM profiles WHERE share_code = ?")
    .get(code) as { id: number; name: string } | undefined;
  if (!profile) return { error: "not_found" };

  const open = db
    .prepare(
      "SELECT * FROM access_grants WHERE profile_id = ? AND clinician_user_id = ? AND status IN ('pending','active')"
    )
    .get(profile.id, clinicianUserId) as GrantRow | undefined;
  if (open) return { error: "already_open" };

  const info = db
    .prepare(
      `INSERT INTO access_grants (profile_id, clinician_user_id, status, purpose, requested_by_user_id)
       VALUES (?, ?, 'pending', ?, ?)`
    )
    .run(profile.id, clinicianUserId, purpose, clinicianUserId);
  const grant = db.prepare("SELECT * FROM access_grants WHERE id = ?").get(Number(info.lastInsertRowid)) as unknown as GrantRow;
  logAudit(db, { actor: clinicianUserId, action: "access_requested", profileId: profile.id, targetId: grant.id });
  return { grant, patient_name: profile.name };
}

export function decideGrant(
  db: DatabaseSync,
  patientUserId: number,
  patientProfileId: number,
  grantId: number,
  approve: boolean,
  expiresDays: number | null
): GrantRow | null {
  const grant = db
    .prepare("SELECT * FROM access_grants WHERE id = ? AND profile_id = ? AND status = 'pending'")
    .get(grantId, patientProfileId) as GrantRow | undefined;
  if (!grant) return null;

  const now = new Date().toISOString();
  if (approve) {
    const expires = expiresDays ? new Date(Date.now() + expiresDays * 86_400_000).toISOString() : null;
    db.prepare(
      "UPDATE access_grants SET status = 'active', decided_at = ?, approved_by_user_id = ?, starts_at = ?, expires_at = ? WHERE id = ?"
    ).run(now, patientUserId, now, expires, grantId);
    logAudit(db, { actor: patientUserId, action: "access_approved", profileId: patientProfileId, targetId: grantId });
  } else {
    db.prepare("UPDATE access_grants SET status = 'denied', decided_at = ? WHERE id = ?").run(now, grantId);
    logAudit(db, { actor: patientUserId, action: "access_denied", profileId: patientProfileId, targetId: grantId });
  }
  return db.prepare("SELECT * FROM access_grants WHERE id = ?").get(grantId) as unknown as GrantRow;
}

export function revokeGrant(
  db: DatabaseSync,
  actorUserId: number,
  grantId: number,
  scope: { patientProfileId?: number; clinicianUserId?: number }
): boolean {
  const grant = db.prepare("SELECT * FROM access_grants WHERE id = ?").get(grantId) as GrantRow | undefined;
  if (!grant || !["pending", "active"].includes(grant.status)) return false;
  if (scope.patientProfileId !== undefined && grant.profile_id !== scope.patientProfileId) return false;
  if (scope.clinicianUserId !== undefined && grant.clinician_user_id !== scope.clinicianUserId) return false;

  db.prepare("UPDATE access_grants SET status = 'revoked', revoked_at = datetime('now') WHERE id = ?").run(grantId);
  logAudit(db, {
    actor: actorUserId,
    action: "access_revoked",
    profileId: grant.profile_id,
    targetId: grantId,
    meta: { by: scope.patientProfileId !== undefined ? "patient" : "clinician" },
  });
  return true;
}

export function rotateShareCode(db: DatabaseSync, profileId: number, actorUserId: number): string {
  const code = generateShareCode(db);
  db.prepare("UPDATE profiles SET share_code = ? WHERE id = ?").run(code, profileId);
  logAudit(db, { actor: actorUserId, action: "care_code_rotated", profileId });
  return code;
}
