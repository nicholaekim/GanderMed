// Cancel an open staff invite (owner/admin of the owning org; existence not
// revealed to anyone else).

import { NextResponse } from "next/server";
import { logAudit } from "@/lib/access";
import { requireOrgManagement } from "../../helpers";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const inviteId = Number(id);
  if (!Number.isInteger(inviteId)) return NextResponse.json({ error: "Bad id." }, { status: 400 });

  const auth = requireOrgManagement(request);
  if ("fail" in auth) return auth.fail;
  const { db, user, org } = auth;

  let body: { action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (body.action !== "cancel") return NextResponse.json({ error: "action must be 'cancel'." }, { status: 400 });

  const info = db
    .prepare(
      "UPDATE staff_invitations SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ? AND organization_id = ? AND status = 'created'"
    )
    .run(inviteId, org.id);
  if (Number(info.changes) === 0) return NextResponse.json({ error: "Not found." }, { status: 404 });
  logAudit(db, { actor: user.id, action: "org_staff_invite_cancelled", targetId: inviteId, meta: { org: org.id } });
  return NextResponse.json({ ok: true });
}
