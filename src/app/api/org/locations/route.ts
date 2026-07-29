// Add a location (owner/admin).

import { NextResponse } from "next/server";
import { logAudit } from "@/lib/access";
import { requireOrgManagement } from "../helpers";

export async function POST(request: Request) {
  const auth = requireOrgManagement(request);
  if ("fail" in auth) return auth.fail;
  const { db, user, org } = auth;

  let body: { label?: string; address?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const label = (body.label ?? "").trim().slice(0, 120);
  if (label.length < 2) return NextResponse.json({ error: "Give the location a label." }, { status: 400 });

  const info = db
    .prepare("INSERT INTO organization_locations (organization_id, label, address) VALUES (?, ?, ?)")
    .run(org.id, label, (body.address ?? "").trim().slice(0, 200) || null);
  logAudit(db, { actor: user.id, action: "org_location_added", targetId: Number(info.lastInsertRowid), meta: { org: org.id } });
  return NextResponse.json({ ok: true, location_id: Number(info.lastInsertRowid) });
}
