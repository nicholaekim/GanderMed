import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { computeExposure } from "@/lib/exposure";
import { getUserFromRequest, resolveProfileAccess } from "@/lib/auth";

export async function GET(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const access = resolveProfileAccess(db, user, request, { write: false });
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.status });

  const { report } = computeExposure(db, access.profileId);
  return NextResponse.json({ exposure: report });
}
