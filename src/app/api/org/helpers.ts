// Shared guards for the org route group. Membership is resolved fresh on
// every call — never cached in the session — so deactivation takes effect on
// the next request.

import { NextResponse } from "next/server";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "@/lib/db";
import { getUserFromRequest, type SessionUser } from "@/lib/auth";
import { activeMembership, getOrg, isManagement, type Membership, type OrgRow } from "@/lib/org";

export function requireOrgMember(
  request: Request
): { fail: NextResponse } | { db: DatabaseSync; user: SessionUser; membership: Membership; org: OrgRow } {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return { fail: NextResponse.json({ error: "Not signed in." }, { status: 401 }) };
  if (user.role !== "clinician") {
    return { fail: NextResponse.json({ error: "Care-team accounts only." }, { status: 403 }) };
  }
  const membership = activeMembership(db, user.id);
  if (!membership) {
    return { fail: NextResponse.json({ error: "You are not an active member of an organization." }, { status: 403 }) };
  }
  const org = getOrg(db, membership.organization_id)!;
  return { db, user, membership, org };
}

export function requireOrgManagement(
  request: Request
): { fail: NextResponse } | { db: DatabaseSync; user: SessionUser; membership: Membership; org: OrgRow } {
  const resolved = requireOrgMember(request);
  if ("fail" in resolved) return resolved;
  if (!isManagement(resolved.membership.org_role)) {
    return { fail: NextResponse.json({ error: "Owner or admin access required." }, { status: 403 }) };
  }
  return resolved;
}
