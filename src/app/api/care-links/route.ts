// Care-team access endpoints (path kept from the care-link era; semantics
// are now request/consent based). POST creates a PENDING access request from
// a patient's care code — the patient must approve it before any record
// becomes readable. GET returns the clinician's roster: active grants with
// safety stats, plus their pending/awaiting-approval requests.

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest } from "@/lib/auth";
import { normalizeShareCode } from "@/lib/auth";
import { recomputeAlerts } from "@/lib/conflicts";
import { attachReviews } from "@/lib/reviews";
import { computeAdherence } from "@/lib/adherence";
import { ACCESS_PURPOSES, logAudit, requestAccessByCode, sweepExpiry } from "@/lib/access";
import type { GrantRow } from "@/lib/access";
import { activeLocation, activeMembership, isManagement } from "@/lib/org";
import { countOpenShortages } from "@/lib/shortages";

export async function GET(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (user.role !== "clinician") {
    return NextResponse.json({ error: "Care-team accounts only." }, { status: 403 });
  }

  // Union of the caller's individual grants and their org's grants; a
  // clinician with no membership gets the -1 sentinel (matches nothing).
  const membership = activeMembership(db, user.id);
  const management = membership ? isManagement(membership.org_role) : false;
  const grants = db
    .prepare(
      `SELECT g.*, p.name AS patient_name, u.email AS patient_email,
              ru.display_name AS requested_by_name,
              ol.label AS location_label,
              o.name AS organization_name,
              (SELECT COUNT(*) FROM organization_members m
                WHERE m.user_id = g.requested_by_user_id AND m.organization_id = g.organization_id AND m.status = 'active') AS requester_active
       FROM access_grants g
       JOIN profiles p ON p.id = g.profile_id
       LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN users ru ON ru.id = g.requested_by_user_id
       LEFT JOIN organization_locations ol ON ol.id = g.location_id
       LEFT JOIN organizations o ON o.id = g.organization_id
       WHERE g.status IN ('pending','active')
         AND ((g.organization_id IS NULL AND g.clinician_user_id = ?)
           OR (g.organization_id IS NOT NULL AND g.organization_id = ?))
       ORDER BY p.name`
    )
    .all(user.id, membership?.organization_id ?? -1) as unknown as (GrantRow & {
    patient_name: string;
    patient_email: string | null;
    requested_by_name: string | null;
    location_label: string | null;
    organization_name: string | null;
    requester_active: number;
    requested_by_user_id: number;
  })[];

  const pending = [];
  const byProfile = new Map<number, typeof grants>();
  for (const g of grants) {
    if (sweepExpiry(db, g) !== "active") {
      if (g.status === "pending") {
        // Org pendings are visible only to the requester and management —
        // staff never see names the patient hasn't approved for the org.
        const visible =
          g.organization_id == null || g.requested_by_user_id === user.id || management;
        if (visible) {
          pending.push({
            grant_id: g.id,
            patient_name: g.patient_name,
            purpose: g.purpose,
            requested_at: g.requested_at,
            via: g.organization_id == null ? "individual" : "org",
            organization_name: g.organization_name,
            location_label: g.location_label,
            requested_by_name: g.requested_by_name,
            can_withdraw: g.organization_id == null || g.requested_by_user_id === user.id || management,
          });
        }
      }
      continue;
    }
    if (!byProfile.has(g.profile_id)) byProfile.set(g.profile_id, []);
    byProfile.get(g.profile_id)!.push(g);
  }

  const roster = [];
  for (const [profileId, profileGrants] of byProfile) {
    const first = profileGrants[0];
    const { all } = recomputeAlerts(db, profileId);
    attachReviews(db, profileId, all);
    const open = all.filter((a) => !a.acknowledged_at && !a.review);
    const activeMeds = db
      .prepare("SELECT COUNT(*) AS n FROM medications WHERE profile_id = ? AND status = 'active'")
      .get(profileId) as { n: number };
    const lastEvent = db
      .prepare(
        `SELECT MAX(de.logged_at) AS last FROM dose_events de
         JOIN medications m ON m.id = de.medication_id WHERE m.profile_id = ?`
      )
      .get(profileId) as { last: string | null };
    const adherence = computeAdherence(db, profileId, 14);
    const individual = profileGrants.find((g) => g.organization_id == null);
    roster.push({
      adherence_pct: adherence.overall.adherence_pct,
      missed_14d: adherence.overall.counts.missed,
      supply_alerts: countOpenShortages(db, profileId),
      grant_id: first.id,
      profile_id: profileId,
      patient_name: first.patient_name,
      patient_email: first.patient_email,
      purpose: first.purpose,
      expires_at: first.expires_at,
      access: profileGrants.map((g) => ({
        grant_id: g.id,
        via: g.organization_id == null ? ("individual" as const) : ("org" as const),
        purpose: g.purpose,
        expires_at: g.expires_at,
        organization_name: g.organization_name,
        location_label: g.location_label,
        requested_by_name: g.requested_by_name,
        requested_by_active: g.organization_id == null ? null : g.requester_active > 0,
        can_remove: g.organization_id == null ? g.clinician_user_id === user.id : management,
      })),
      can_upgrade: !!membership && !!individual && !profileGrants.some((g) => g.organization_id != null),
      alerts_major: open.filter((a) => a.severity === "major").length,
      alerts_moderate: open.filter((a) => a.severity === "moderate").length,
      alerts_minor: open.filter((a) => a.severity === "minor").length,
      alerts_reviewed: all.filter((a) => a.review && !a.acknowledged_at).length,
      alerts_acknowledged: all.filter((a) => a.acknowledged_at).length,
      last_dose_at: lastEvent.last,
    });
  }

  return NextResponse.json({ roster, pending });
}

export async function POST(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (user.role !== "clinician") {
    return NextResponse.json({ error: "Care-team accounts only." }, { status: 403 });
  }

  let body: {
    code?: string;
    purpose?: string;
    as_org?: boolean;
    location_id?: number;
    upgrade_profile_id?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const purpose = (ACCESS_PURPOSES as readonly string[]).includes(body.purpose ?? "")
    ? body.purpose!
    : "Medication review";

  // Org scope is DERIVED from the caller's active membership — never taken
  // from the body. A location is required and must be an active location of
  // that org.
  let org: { organizationId: number; locationId: number } | null = null;
  if (body.as_org || body.upgrade_profile_id !== undefined) {
    const membership = activeMembership(db, user.id);
    if (!membership) {
      return NextResponse.json({ error: "You are not an active member of an organization." }, { status: 403 });
    }
    const location = activeLocation(db, membership.organization_id, Number(body.location_id));
    if (!location) {
      return NextResponse.json({ error: "Pick an active location of your organization." }, { status: 400 });
    }
    org = { organizationId: membership.organization_id, locationId: location.id };
  }

  // Upgrade path: a member already holding an ACTIVE individual grant may
  // request TEAM access without re-reading the care code. Still a PENDING
  // request — the patient explicitly approves the org card; nothing widens.
  if (body.upgrade_profile_id !== undefined) {
    const profileId = Number(body.upgrade_profile_id);
    const individual = db
      .prepare(
        `SELECT id FROM access_grants
         WHERE profile_id = ? AND clinician_user_id = ? AND organization_id IS NULL AND status = 'active'
           AND (expires_at IS NULL OR expires_at > ?)`
      )
      .get(profileId, user.id, new Date().toISOString());
    if (!individual) return NextResponse.json({ error: "Not found." }, { status: 404 });

    const openOrg = db
      .prepare("SELECT 1 FROM access_grants WHERE profile_id = ? AND organization_id = ? AND status IN ('pending','active')")
      .get(profileId, org!.organizationId);
    if (openOrg) {
      return NextResponse.json({ error: "Your organization already has a pending or active request for this patient." }, { status: 409 });
    }
    const info = db
      .prepare(
        `INSERT INTO access_grants (profile_id, clinician_user_id, organization_id, location_id, status, purpose, requested_by_user_id)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(profileId, user.id, org!.organizationId, org!.locationId, purpose, user.id);
    logAudit(db, {
      actor: user.id,
      action: "access_requested",
      profileId,
      targetId: Number(info.lastInsertRowid),
      meta: { as: "organization", org: org!.organizationId, location: org!.locationId, via: "upgrade" },
    });
    return NextResponse.json({ ok: true, status: "pending", grant_id: Number(info.lastInsertRowid) });
  }

  const code = normalizeShareCode(body.code ?? "");
  if (!code) return NextResponse.json({ error: "Care codes look like ABCD-1234." }, { status: 400 });

  const result = requestAccessByCode(db, user.id, code, purpose, org);
  if ("error" in result) {
    if (result.error === "already_open") {
      return NextResponse.json(
        {
          error: org
            ? "Your organization already has a pending or active request for this patient."
            : "You already have a pending or active request for this patient.",
        },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: "No patient found with that care code." }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    status: "pending",
    patient_name: result.patient_name,
    grant_id: result.grant.id,
  });
}
