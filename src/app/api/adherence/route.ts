// Adherence report (Phase 8). Read-only, same access rules as the rest of
// the record: patients see their own; clinicians need an active grant.
// Everything is computed at read time from expected slots vs logged events —
// see src/lib/adherence.ts for the definitions and the formula.

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest, resolveProfileAccess } from "@/lib/auth";
import { computeAdherence } from "@/lib/adherence";

export async function GET(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const access = resolveProfileAccess(db, user, request, { write: false });
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.status });

  const daysParam = Number(new URL(request.url).searchParams.get("days"));
  const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(Math.floor(daysParam), 90) : 14;

  return NextResponse.json({ adherence: computeAdherence(db, access.profileId, days) });
}
