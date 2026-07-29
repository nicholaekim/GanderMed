// Pilot metrics for the signed-in clinician's own practice. Aggregates only
// — see src/lib/metrics.ts for the PHI-free guarantee.

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest } from "@/lib/auth";
import { computePilotMetrics } from "@/lib/metrics";

export async function GET(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (user.role !== "clinician") {
    return NextResponse.json({ error: "Care-team accounts only." }, { status: 403 });
  }
  return NextResponse.json({ metrics: computePilotMetrics(db, user.id) });
}
