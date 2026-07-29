// Pharmacy organizations (Phase 5) — leaf module: imports only node:sqlite
// types and node:crypto, so auth.ts, access.ts, and every route can import
// from it without cycles.
//
// The consent rules this module serves (decided in the design blueprint):
//   - Org access exists ONLY via a grant whose organization_id is set, and a
//     grant like that is exercised ONLY by users whose membership in that org
//     is ACTIVE at the moment of the request. Membership is looked up per
//     request, never cached — deactivation bites on the very next read.
//   - Individual grants (organization_id NULL) are personal consents; the
//     org never inherits them and never controls them.
//   - Staff invites follow the patient-invitation pattern: sha256 hash
//     stored, raw token shown exactly once, lazy expiry — plus a staleness
//     rule: an invite minted by someone who lost owner/admin standing dies.

import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type OrgRole = "owner" | "admin" | "pharmacist" | "staff";

export const ORG_ROLES: OrgRole[] = ["owner", "admin", "pharmacist", "staff"];
/** Roles a staff invite may carry — ownership is never minted, only created or promoted. */
export const INVITABLE_ROLES: OrgRole[] = ["admin", "pharmacist", "staff"];

export const isManagement = (r: OrgRole): boolean => r === "owner" || r === "admin";
/** Alert reviews are clinical judgments: pharmacists and (pharmacist-)owners only. */
export const canReview = (r: OrgRole): boolean => r === "owner" || r === "pharmacist";

export interface Membership {
  member_id: number;
  organization_id: number;
  org_role: OrgRole;
}

export interface OrgRow {
  id: number;
  name: string;
  verification_status: "unverified" | "verified";
  created_by_user_id: number;
  created_at: string;
}

export function activeMembership(db: DatabaseSync, userId: number): Membership | null {
  const row = db
    .prepare(
      "SELECT id AS member_id, organization_id, org_role FROM organization_members WHERE user_id = ? AND status = 'active'"
    )
    .get(userId) as Membership | undefined;
  return row ?? null;
}

export function getOrg(db: DatabaseSync, orgId: number): OrgRow | null {
  return ((db.prepare("SELECT * FROM organizations WHERE id = ?").get(orgId) as OrgRow | undefined) ?? null);
}

export function activeLocation(
  db: DatabaseSync,
  orgId: number,
  locationId: number
): { id: number; label: string } | null {
  const row = db
    .prepare("SELECT id, label FROM organization_locations WHERE id = ? AND organization_id = ? AND status = 'active'")
    .get(locationId, orgId) as { id: number; label: string } | undefined;
  return row ?? null;
}

export function countActiveOwners(db: DatabaseSync, orgId: number): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ? AND org_role = 'owner' AND status = 'active'"
      )
      .get(orgId) as { n: number }
  ).n;
}

// ---- Staff invitations ----

export interface StaffInviteRow {
  id: number;
  token_hash: string;
  organization_id: number;
  invited_by_user_id: number;
  org_role: OrgRole;
  invitee_label: string | null;
  status: "created" | "redeemed" | "expired" | "cancelled";
  expires_at: string;
  created_at: string;
  redeemed_at: string | null;
  redeemed_by_user_id: number | null;
  cancelled_at: string | null;
}

export function hashStaffToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function mintStaffInvite(
  db: DatabaseSync,
  orgId: number,
  invitedByUserId: number,
  orgRole: OrgRole,
  inviteeLabel: string | null,
  expiresDays: number
): { invite: StaffInviteRow; token: string } {
  const token = randomBytes(32).toString("base64url");
  const info = db
    .prepare(
      `INSERT INTO staff_invitations (token_hash, organization_id, invited_by_user_id, org_role, invitee_label, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      hashStaffToken(token),
      orgId,
      invitedByUserId,
      orgRole,
      inviteeLabel,
      new Date(Date.now() + expiresDays * 86_400_000).toISOString()
    );
  const invite = db
    .prepare("SELECT * FROM staff_invitations WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as unknown as StaffInviteRow;
  return { invite, token };
}

/**
 * Resolves a raw join token, applying the two lazy sweeps in order:
 * past-expiry → 'expired'; minter no longer an active owner/admin of the org
 * → 'cancelled' (minted authority dies with revoked authority).
 */
export function findStaffInviteByToken(db: DatabaseSync, token: string): StaffInviteRow | null {
  if (!token || token.length > 128) return null;
  const row = db
    .prepare("SELECT * FROM staff_invitations WHERE token_hash = ?")
    .get(hashStaffToken(token)) as StaffInviteRow | undefined;
  if (!row) return null;
  return sweepStaffInvite(db, row);
}

export function sweepStaffInvite(db: DatabaseSync, row: StaffInviteRow): StaffInviteRow {
  if (row.status !== "created") return row;
  if (row.expires_at <= new Date().toISOString()) {
    db.prepare("UPDATE staff_invitations SET status = 'expired' WHERE id = ? AND status = 'created'").run(row.id);
    return { ...row, status: "expired" };
  }
  const minter = db
    .prepare(
      `SELECT 1 FROM organization_members
       WHERE user_id = ? AND organization_id = ? AND status = 'active' AND org_role IN ('owner','admin')`
    )
    .get(row.invited_by_user_id, row.organization_id);
  if (!minter) {
    db.prepare(
      "UPDATE staff_invitations SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ? AND status = 'created'"
    ).run(row.id);
    return { ...row, status: "cancelled" };
  }
  return row;
}

export type RedeemResult = "ok" | "not_found" | "gone" | "patient" | "already_member" | "other_org";

/** Membership + redemption in one transaction; races fail closed on the partial unique index. */
export function redeemStaffInvite(
  db: DatabaseSync,
  invite: StaffInviteRow,
  user: { id: number; role: string }
): RedeemResult {
  if (invite.status !== "created") return "gone";
  if (user.role !== "clinician") return "patient";
  const existing = activeMembership(db, user.id);
  if (existing?.organization_id === invite.organization_id) return "already_member";
  if (existing) return "other_org";

  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO organization_members (organization_id, user_id, org_role, status, invited_by_user_id)
       VALUES (?, ?, ?, 'active', ?)`
    ).run(invite.organization_id, user.id, invite.org_role, invite.invited_by_user_id);
    db.prepare(
      "UPDATE staff_invitations SET status = 'redeemed', redeemed_at = datetime('now'), redeemed_by_user_id = ? WHERE id = ? AND status = 'created'"
    ).run(user.id, invite.id);
    db.exec("COMMIT");
    return "ok";
  } catch {
    db.exec("ROLLBACK");
    // ux_org_members_single_active tripped in a race — fail closed.
    return "other_org";
  }
}
