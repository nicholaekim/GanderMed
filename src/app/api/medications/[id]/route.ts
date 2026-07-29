import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { recomputeAlerts } from "@/lib/conflicts";
import { annotateAlertsWithExposure, computeExposure } from "@/lib/exposure";
import { attachReviews } from "@/lib/reviews";
import { getUserFromRequest, resolveProfileAccess } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

function authorize(
  request: Request
): { fail: NextResponse } | { db: ReturnType<typeof getDb>; profileId: number } {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return { fail: NextResponse.json({ error: "Not signed in." }, { status: 401 }) };
  const access = resolveProfileAccess(db, user, request, { write: true });
  if ("error" in access) return { fail: NextResponse.json({ error: access.error }, { status: access.status }) };
  return { db, profileId: access.profileId };
}

export async function PATCH(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const medId = Number(id);
  if (!Number.isInteger(medId)) return NextResponse.json({ error: "Bad id." }, { status: 400 });

  const auth = authorize(request);
  if ("fail" in auth) return auth.fail;
  const { db, profileId } = auth;

  let body: { status?: "active" | "stopped"; actual_use?: string; patient_notes?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const sets: string[] = [];
  const args: (string | null)[] = [];
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "stopped") {
      return NextResponse.json({ error: "status must be 'active' or 'stopped'." }, { status: 400 });
    }
    sets.push("status = ?", "end_date = ?");
    args.push(body.status, body.status === "stopped" ? new Date().toISOString().slice(0, 10) : null);
  }
  if (body.actual_use !== undefined) {
    const allowed = ["taking", "not_taking", "taking_differently", "recently_stopped", "unsure"];
    if (!allowed.includes(body.actual_use)) {
      return NextResponse.json({ error: `actual_use must be one of: ${allowed.join(", ")}.` }, { status: 400 });
    }
    sets.push("actual_use = ?");
    args.push(body.actual_use);
  }
  if (body.patient_notes !== undefined) {
    const note = (body.patient_notes ?? "").trim().slice(0, 500) || null;
    sets.push("patient_notes = ?");
    args.push(note);
  }
  if (sets.length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  const info = db
    .prepare(`UPDATE medications SET ${sets.join(", ")} WHERE id = ? AND profile_id = ?`)
    .run(...args, medId, profileId);
  if (Number(info.changes) === 0) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const { all } = recomputeAlerts(db, profileId);
  return NextResponse.json({
    ok: true,
    alerts: attachReviews(db, profileId, annotateAlertsWithExposure(all, computeExposure(db, profileId))),
  });
}

export async function DELETE(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const medId = Number(id);
  if (!Number.isInteger(medId)) return NextResponse.json({ error: "Bad id." }, { status: 400 });

  const auth = authorize(request);
  if ("fail" in auth) return auth.fail;
  const { db, profileId } = auth;

  const info = db.prepare("DELETE FROM medications WHERE id = ? AND profile_id = ?").run(medId, profileId);
  if (Number(info.changes) === 0) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const { all } = recomputeAlerts(db, profileId);
  return NextResponse.json({
    ok: true,
    alerts: attachReviews(db, profileId, annotateAlertsWithExposure(all, computeExposure(db, profileId))),
  });
}
