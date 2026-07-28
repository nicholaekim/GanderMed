import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { clearSessionCookie, deleteSession } from "@/lib/auth";

export async function POST(request: Request) {
  const db = getDb();
  deleteSession(db, request);
  return NextResponse.json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
}
