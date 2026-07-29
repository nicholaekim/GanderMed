// Close a location (owner/admin). Closed locations are refused for NEW
// requests/invitations; existing grants keep the stored location for display.

import { NextResponse } from "next/server";
import { logAudit } from "@/lib/access";
import { requireOrgManagement } from "../../helpers";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const locationId = Number(id);
  if (!Number.isInteger(locationId)) return NextResponse.json({ error: "Bad id." }, { status: 400 });

  const auth = requireOrgManagement(request);
  if ("fail" in auth) return auth.fail;
  const { db, user, org } = auth;

  let body: { action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (body.action !== "close") return NextResponse.json({ error: "action must be 'close'." }, { status: 400 });

  const info = db
    .prepare("UPDATE organization_locations SET status = 'closed' WHERE id = ? AND organization_id = ? AND status = 'active'")
    .run(locationId, org.id);
  if (Number(info.changes) === 0) return NextResponse.json({ error: "Not found." }, { status: 404 });
  logAudit(db, { actor: user.id, action: "org_location_closed", targetId: locationId, meta: { org: org.id } });
  return NextResponse.json({ ok: true });
}
