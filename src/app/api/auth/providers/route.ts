import { NextResponse } from "next/server";
import { googleConfigured } from "@/lib/google";

// Tells the login page which optional sign-in providers are configured.
export async function GET() {
  return NextResponse.json({ google: googleConfigured() });
}
