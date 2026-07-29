// Pharmacy-initiated patient invitations + guided intake (Phase 6).
//
// A clinician creates an invitation and hands the patient a link (in person,
// printed, or read over the phone — the app does NOT send email/SMS, so there
// is no 'sent' state). Only a sha256 hash of the URL token is stored; the raw
// token exists once, in the create response. Opening the link walks the
// patient through a guided intake and ends with an explicit consent decision.
// Consent here follows the same rules as care-code requests: nothing is
// shared until the patient approves, and approval creates a normal
// access_grants row that resolveProfileAccess enforces (revocable, expirable).

import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { logAudit } from "@/lib/access";

export type InvitationStatus =
  | "created"
  | "opened"
  | "intake_started"
  | "intake_submitted"
  | "consented"
  | "denied"
  | "reviewed"
  | "expired"
  | "cancelled";

/** States in which the intake link no longer works. */
export const TERMINAL_STATUSES: InvitationStatus[] = ["denied", "reviewed", "expired", "cancelled"];

export interface InvitationRow {
  id: number;
  token_hash: string;
  clinician_user_id: number;
  organization_id: number | null;
  location_id: number | null;
  patient_label: string | null;
  purpose: string;
  status: InvitationStatus;
  expires_at: string;
  created_at: string;
  opened_at: string | null;
  intake_started_at: string | null;
  submitted_at: string | null;
  consented_at: string | null;
  reviewed_at: string | null;
  patient_note: string | null;
  profile_id: number | null;
  grant_id: number | null;
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createInvitation(
  db: DatabaseSync,
  clinicianUserId: number,
  opts: {
    patientLabel: string | null;
    purpose: string;
    expiresDays: number;
    org?: { organizationId: number; locationId: number } | null;
  }
): { invitation: InvitationRow; token: string } {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + opts.expiresDays * 86_400_000).toISOString();
  const info = db
    .prepare(
      `INSERT INTO patient_invitations (token_hash, clinician_user_id, organization_id, location_id, patient_label, purpose, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      hashInvitationToken(token),
      clinicianUserId,
      opts.org?.organizationId ?? null,
      opts.org?.locationId ?? null,
      opts.patientLabel,
      opts.purpose,
      expiresAt
    );
  const invitation = getInvitation(db, Number(info.lastInsertRowid))!;
  logAudit(db, {
    actor: clinicianUserId,
    action: "invitation_created",
    targetId: invitation.id,
    meta: opts.org
      ? { expires_days: opts.expiresDays, org: opts.org.organizationId, location: opts.org.locationId }
      : { expires_days: opts.expiresDays },
  });
  return { invitation, token };
}

export function getInvitation(db: DatabaseSync, id: number): InvitationRow | null {
  const row = db.prepare("SELECT * FROM patient_invitations WHERE id = ?").get(id) as InvitationRow | undefined;
  return row ? sweepInvitationExpiry(db, row) : null;
}

/** Resolves a raw URL token to its invitation (lazily expiring it). Unknown token → null. */
export function findInvitationByToken(db: DatabaseSync, token: string): InvitationRow | null {
  if (!token || token.length > 128) return null;
  const row = db
    .prepare("SELECT * FROM patient_invitations WHERE token_hash = ?")
    .get(hashInvitationToken(token)) as InvitationRow | undefined;
  return row ? sweepInvitationExpiry(db, row) : null;
}

/**
 * Lazy sweeps at read time, like access grants: past-expiry flips to
 * 'expired'; an ORG-scoped invitation whose minter is no longer an active
 * member of that org flips to 'cancelled' — a deactivated employee's
 * outstanding links must never mint org access (fail closed).
 */
function sweepInvitationExpiry(db: DatabaseSync, row: InvitationRow): InvitationRow {
  const openStates: InvitationStatus[] = ["created", "opened", "intake_started"];
  if (openStates.includes(row.status) && row.expires_at <= new Date().toISOString()) {
    db.prepare("UPDATE patient_invitations SET status = 'expired' WHERE id = ? AND status = ?").run(row.id, row.status);
    logAudit(db, { actor: null, action: "invitation_expired", profileId: row.profile_id, targetId: row.id });
    return { ...row, status: "expired" };
  }
  const liveStates: InvitationStatus[] = [...openStates, "intake_submitted"];
  if (row.organization_id != null && liveStates.includes(row.status)) {
    const minterActive = db
      .prepare(
        "SELECT 1 FROM organization_members WHERE user_id = ? AND organization_id = ? AND status = 'active'"
      )
      .get(row.clinician_user_id, row.organization_id);
    if (!minterActive) {
      db.prepare("UPDATE patient_invitations SET status = 'cancelled' WHERE id = ? AND status = ?").run(row.id, row.status);
      logAudit(db, {
        actor: null,
        action: "invitation_cancelled",
        profileId: row.profile_id,
        targetId: row.id,
        meta: { reason: "minter_inactive" },
      });
      return { ...row, status: "cancelled" };
    }
  }
  return row;
}

/**
 * Forward-only status steps. Reopening the link mid-intake must not regress
 * the timeline (opened → intake_started stays intake_started), so each
 * transition names the exact states it may leave from.
 */
const TRANSITIONS: Record<string, { from: InvitationStatus[]; stamp?: string }> = {
  opened: { from: ["created"], stamp: "opened_at" },
  intake_started: { from: ["created", "opened"], stamp: "intake_started_at" },
  intake_submitted: { from: ["intake_started"], stamp: "submitted_at" },
  consented: { from: ["intake_submitted"], stamp: "consented_at" },
  denied: { from: ["intake_submitted"], stamp: "consented_at" },
  reviewed: { from: ["consented"], stamp: "reviewed_at" },
  cancelled: { from: ["created", "opened", "intake_started", "intake_submitted"] },
};

export function transitionInvitation(
  db: DatabaseSync,
  invitation: InvitationRow,
  to: InvitationStatus,
  actorUserId: number | null
): InvitationRow | null {
  const rule = TRANSITIONS[to];
  if (!rule || !rule.from.includes(invitation.status)) return null;
  const stampSql = rule.stamp ? `, ${rule.stamp} = datetime('now')` : "";
  db.prepare(`UPDATE patient_invitations SET status = ?${stampSql} WHERE id = ?`).run(to, invitation.id);
  logAudit(db, {
    actor: actorUserId,
    action: `invitation_${to}`,
    profileId: invitation.profile_id,
    targetId: invitation.id,
  });
  return getInvitation(db, invitation.id);
}

/**
 * Binds the invitation to the signed-in patient's profile when intake starts.
 * First claim wins; a different patient reopening the same link is refused.
 */
export function claimInvitation(
  db: DatabaseSync,
  invitation: InvitationRow,
  profileId: number
): "ok" | "claimed_by_other" {
  if (invitation.profile_id !== null && invitation.profile_id !== profileId) return "claimed_by_other";
  if (invitation.profile_id === null) {
    db.prepare("UPDATE patient_invitations SET profile_id = ? WHERE id = ?").run(profileId, invitation.id);
  }
  return "ok";
}

/**
 * The consent step of intake. Approval creates (or reuses) a normal ACTIVE
 * access grant — same table, same enforcement, same revocability as
 * care-code consent. Denial shares nothing.
 */
export function concludeIntake(
  db: DatabaseSync,
  invitation: InvitationRow,
  patientUserId: number,
  profileId: number,
  decision: { approve: boolean; expiresDays: number | null }
): InvitationRow | null {
  if (invitation.status !== "intake_submitted" || invitation.profile_id !== profileId) return null;

  if (!decision.approve) {
    db.prepare("UPDATE patient_invitations SET status = 'denied', consented_at = datetime('now') WHERE id = ?").run(
      invitation.id
    );
    logAudit(db, { actor: patientUserId, action: "invitation_denied", profileId, targetId: invitation.id });
    return getInvitation(db, invitation.id);
  }

  const now = new Date().toISOString();
  const expires = decision.expiresDays ? new Date(Date.now() + decision.expiresDays * 86_400_000).toISOString() : null;

  // Scope-aware reuse under the split unique indexes: an ORG invitation may
  // only reuse/activate the (profile, organization) grant; an individual
  // invitation may only touch the (profile, clinician, organization_id NULL)
  // grant. Without the IS NULL filter, an individual consent could grab and
  // re-stamp a coexisting org grant row — silent scope corruption.
  const open = invitation.organization_id != null
    ? (db
        .prepare(
          "SELECT id, status FROM access_grants WHERE profile_id = ? AND organization_id = ? AND status IN ('pending','active')"
        )
        .get(profileId, invitation.organization_id) as { id: number; status: string } | undefined)
    : (db
        .prepare(
          "SELECT id, status FROM access_grants WHERE profile_id = ? AND clinician_user_id = ? AND organization_id IS NULL AND status IN ('pending','active')"
        )
        .get(profileId, invitation.clinician_user_id) as { id: number; status: string } | undefined);

  let grantId: number;
  if (open?.status === "active") {
    grantId = open.id;
  } else if (open) {
    db.prepare(
      "UPDATE access_grants SET status = 'active', decided_at = ?, approved_by_user_id = ?, starts_at = ?, expires_at = ? WHERE id = ?"
    ).run(now, patientUserId, now, expires, open.id);
    grantId = open.id;
  } else {
    grantId = Number(
      db
        .prepare(
          `INSERT INTO access_grants
           (profile_id, clinician_user_id, organization_id, location_id, status, purpose, requested_by_user_id, decided_at, approved_by_user_id, starts_at, expires_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          profileId,
          invitation.clinician_user_id,
          invitation.organization_id,
          invitation.location_id,
          invitation.purpose,
          invitation.clinician_user_id,
          now,
          patientUserId,
          now,
          expires
        ).lastInsertRowid
    );
  }

  db.prepare(
    "UPDATE patient_invitations SET status = 'consented', consented_at = datetime('now'), grant_id = ? WHERE id = ?"
  ).run(grantId, invitation.id);
  logAudit(db, { actor: patientUserId, action: "invitation_consented", profileId, targetId: invitation.id });
  logAudit(db, { actor: patientUserId, action: "access_approved", profileId, targetId: grantId, meta: { via: "invitation" } });
  return getInvitation(db, invitation.id);
}

/** Clinician-facing list, with lazy expiry applied per row. */
export function listInvitations(db: DatabaseSync, clinicianUserId: number): InvitationRow[] {
  const rows = db
    .prepare("SELECT * FROM patient_invitations WHERE clinician_user_id = ? ORDER BY created_at DESC, id DESC")
    .all(clinicianUserId) as unknown as InvitationRow[];
  return rows.map((r) => sweepInvitationExpiry(db, r));
}
