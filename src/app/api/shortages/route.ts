// Supply status for a profile's medications (GET) and a cache refresh
// against Health Canada's shortage database (POST).
//
// GET follows the same access rules as the rest of the record. Every
// medication comes back with an explicit state — never a bare "no shortage"
// — so the UI can tell "checked and clear" apart from "never checked".

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest, resolveProfileAccess } from "@/lib/auth";
import { allowRequest, clientIp } from "@/lib/ratelimit";
import {
  lastSync,
  loadShortageCache,
  lookupForMedication,
  normalizeDin,
  shortagesConfigured,
  syncShortages,
} from "@/lib/shortages";

export async function GET(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const access = resolveProfileAccess(db, user, request, { write: false });
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.status });

  const meds = db
    .prepare("SELECT id, brand_name, din, verified FROM medications WHERE profile_id = ? AND status = 'active'")
    .all(access.profileId) as { id: number; brand_name: string; din: string | null; verified: number }[];

  const dins = meds.map((m) => normalizeDin(m.din)).filter((d): d is string => !!d);
  const cache = loadShortageCache(db, dins);

  return NextResponse.json({
    configured: shortagesConfigured(),
    last_sync: lastSync(db),
    medications: meds.map((m) => ({
      medication_id: m.id,
      brand_name: m.brand_name,
      supply: lookupForMedication(db, m, cache),
    })),
  });
}

export async function POST(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (user.role !== "clinician") {
    return NextResponse.json({ error: "Care-team accounts refresh supply data." }, { status: 403 });
  }
  if (!allowRequest(`shortage-sync:${clientIp(request)}`, 6, 3_600_000)) {
    return NextResponse.json({ error: "Supply data was refreshed recently — try again later." }, { status: 429 });
  }

  const result = await syncShortages(db, { actorUserId: user.id });
  if (result.outcome === "not_configured") {
    return NextResponse.json(
      {
        error: "Shortage checking isn't set up on this instance.",
        needs_key: true,
        setup: "Register free at drugshortagescanada.ca, then set DSC_EMAIL and DSC_PASSWORD in .env.local and restart.",
      },
      { status: 503 }
    );
  }
  return NextResponse.json({ ok: true, ...result });
}
