import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest } from "@/lib/auth";
import { rotateShareCode } from "@/lib/access";

// Rotating the care code invalidates the old one for NEW requests
// immediately (lookups are by current code). Existing grants are unaffected
// — revoke those individually from the access panel.
export async function POST(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (user.role !== "patient" || user.profile_id == null) {
    return NextResponse.json({ error: "Patient accounts only." }, { status: 403 });
  }

  const share_code = rotateShareCode(db, user.profile_id, user.id);
  return NextResponse.json({ share_code });
}
