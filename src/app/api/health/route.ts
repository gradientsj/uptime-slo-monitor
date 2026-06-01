import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness/readiness for k8s probes and uptime checks. Verifies DB access. */
export async function GET(): Promise<NextResponse> {
  try {
    await sql`SELECT 1`;
    return NextResponse.json({ status: "ok" });
  } catch (err) {
    return NextResponse.json(
      { status: "degraded", detail: String(err) },
      { status: 503 }
    );
  }
}
