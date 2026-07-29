import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest } from "@/lib/auth";
import { decideGrant, revokeGrant } from "@/lib/access";

type Ctx = { params: Promise<{ id: string }> };

const VALID_EXPIRY_DAYS = new Set([30, 90, 180]);

// Patient decisions about an access grant: approve, deny, or revoke.
export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const grantId = Number(id);
  if (!Number.isInteger(grantId)) return NextResponse.json({ error: "Bad id." }, { status: 400 });

  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (user.role !== "patient" || user.profile_id == null) {
    return NextResponse.json({ error: "Patient accounts only." }, { status: 403 });
  }

  let body: { action?: string; expires_days?: number | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (body.action === "approve" || body.action === "deny") {
    const expires =
      body.action === "approve" && typeof body.expires_days === "number" && VALID_EXPIRY_DAYS.has(body.expires_days)
        ? body.expires_days
        : null;
    const grant = decideGrant(db, user.id, user.profile_id, grantId, body.action === "approve", expires);
    if (!grant) return NextResponse.json({ error: "No pending request with that id." }, { status: 404 });
    return NextResponse.json({ grant });
  }

  if (body.action === "revoke") {
    const ok = revokeGrant(db, user.id, grantId, { patientProfileId: user.profile_id });
    if (!ok) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "action must be approve, deny, or revoke." }, { status: 400 });
}
