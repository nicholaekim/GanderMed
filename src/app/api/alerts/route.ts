import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { recomputeAlerts } from "@/lib/conflicts";
import { annotateAlertsWithExposure, computeExposure } from "@/lib/exposure";
import { attachReviews } from "@/lib/reviews";
import { getUserFromRequest, resolveProfileAccess } from "@/lib/auth";

// Recomputing on read keeps alerts consistent with the current medication
// list and ruleset version — cheap at personal-medication-list scale.
// Exposure status is computed fresh each read (it decays with time).
export async function GET(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const access = resolveProfileAccess(db, user, request, { write: false });
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.status });

  const { all } = recomputeAlerts(db, access.profileId);
  const exposure = computeExposure(db, access.profileId);
  return NextResponse.json({
    alerts: attachReviews(db, access.profileId, annotateAlertsWithExposure(all, exposure)),
  });
}
