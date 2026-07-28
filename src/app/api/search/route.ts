import { NextResponse } from "next/server";
import { searchProducts } from "@/lib/dpd";
import { getDb } from "@/lib/db";
import { getUserFromRequest } from "@/lib/auth";

export async function GET(request: Request) {
  if (!getUserFromRequest(getDb(), request)) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return NextResponse.json({ results: [] });
  try {
    const results = await searchProducts(q);
    return NextResponse.json({ results });
  } catch (e) {
    console.error("DPD search failed:", e);
    return NextResponse.json(
      { error: "Could not reach the Health Canada Drug Product Database. Check your internet connection and try again." },
      { status: 502 }
    );
  }
}
