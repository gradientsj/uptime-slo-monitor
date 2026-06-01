import { NextResponse } from "next/server";
import { getDashboard } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** JSON dashboard model. Polled by the status page for near-real-time updates. */
export async function GET(): Promise<NextResponse> {
  try {
    const data = await getDashboard();
    return NextResponse.json(data, {
      headers: { "cache-control": "no-store" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to load dashboard", detail: String(err) },
      { status: 500 }
    );
  }
}
