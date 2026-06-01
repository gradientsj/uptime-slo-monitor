import { sql } from "./db";

/** Deletes probe results and resolved alert events older than `days`. */
export async function pruneOldData(days: number): Promise<number> {
  const probes = await sql`
    DELETE FROM probe_results
    WHERE ts < now() - make_interval(days => ${days})
  `;
  await sql`
    DELETE FROM alert_events
    WHERE state = 'resolved' AND ts < now() - make_interval(days => ${days})
  `;
  return probes.count ?? 0;
}
