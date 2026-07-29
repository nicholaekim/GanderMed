import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest } from "@/lib/auth";
import { revokeGrant } from "@/lib/access";

type Ctx = { params: Promise<{ id: string }> };

// A clinician withdrawing their own request, or relinquishing granted access.
export async function DELETE(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const grantId = Number(id);
  if (!Number.isInteger(grantId)) return NextResponse.json({ error: "Bad id." }, { status: 400 });

  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (user.role !== "clinician") {
    return NextResponse.json({ error: "Care-team accounts only." }, { status: 403 });
  }

  const ok = revokeGrant(db, user.id, grantId, { clinicianUserId: user.id });
  if (!ok) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
