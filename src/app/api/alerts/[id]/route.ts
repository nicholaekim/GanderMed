import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest, resolveProfileAccess } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

// Acknowledgment belongs to the patient — care-team accounts are view-only.
export async function PATCH(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const alertId = Number(id);
  if (!Number.isInteger(alertId)) return NextResponse.json({ error: "Bad id." }, { status: 400 });

  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const access = resolveProfileAccess(db, user, request, { write: true });
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.status });

  let body: { acknowledged?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const info = db
    .prepare("UPDATE alerts SET acknowledged_at = ? WHERE id = ? AND profile_id = ?")
    .run(body.acknowledged ? new Date().toISOString() : null, alertId, access.profileId);
  if (Number(info.changes) === 0) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const alert = db.prepare("SELECT * FROM alerts WHERE id = ?").get(alertId);
  return NextResponse.json({ alert });
}
