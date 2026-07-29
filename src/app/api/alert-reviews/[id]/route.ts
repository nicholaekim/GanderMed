import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest } from "@/lib/auth";
import { logAudit } from "@/lib/access";

type Ctx = { params: Promise<{ id: string }> };

// Withdraw (soft-revoke) a review you wrote — the row stays as history.
export async function DELETE(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const reviewId = Number(id);
  if (!Number.isInteger(reviewId)) return NextResponse.json({ error: "Bad id." }, { status: 400 });

  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (user.role !== "clinician") {
    return NextResponse.json({ error: "Only care-team accounts can withdraw reviews." }, { status: 403 });
  }

  const info = db
    .prepare("UPDATE alert_reviews SET revoked_at = ? WHERE id = ? AND reviewer_user_id = ? AND revoked_at IS NULL")
    .run(new Date().toISOString(), reviewId, user.id);
  if (Number(info.changes) === 0) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const review = db.prepare("SELECT profile_id FROM alert_reviews WHERE id = ?").get(reviewId) as { profile_id: number };
  logAudit(db, { actor: user.id, action: "review_revoked", profileId: review.profile_id, targetId: reviewId });
  return NextResponse.json({ ok: true });
}
