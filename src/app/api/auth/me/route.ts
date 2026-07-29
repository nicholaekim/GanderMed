import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest } from "@/lib/auth";
import { activeMembership, getOrg } from "@/lib/org";

export async function GET(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  // Org context is computed fresh per call — never cached in the session —
  // so deactivation is reflected on the next page load.
  let org = null;
  if (user.role === "clinician") {
    const membership = activeMembership(db, user.id);
    if (membership) {
      const o = getOrg(db, membership.organization_id)!;
      const locations = db
        .prepare("SELECT id, label, status FROM organization_locations WHERE organization_id = ? ORDER BY id")
        .all(membership.organization_id);
      org = { id: o.id, name: o.name, org_role: membership.org_role, verification_status: o.verification_status, locations };
    }
  }
  return NextResponse.json({ user: { ...user, org } });
}
