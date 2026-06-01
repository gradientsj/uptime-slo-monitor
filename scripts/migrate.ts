/**
 * Applies SQL migrations in db/migrations in lexical order.
 * Idempotent: tracks applied files in a schema_migrations table.
 *
 *   DATABASE_URL=... npm run db:migrate
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

// prepare:false so this works against a transaction-pooling endpoint
// (Neon/PgBouncer pooled URL), not just a direct connection.
const sql = postgres(DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });

async function main() {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  const dir = join(process.cwd(), "db", "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const [{ count }] = await sql`
      SELECT count(*)::int AS count FROM schema_migrations WHERE filename = ${file}
    `;
    if (count > 0) {
      console.log(`= skip ${file} (already applied)`);
      continue;
    }
    const text = await readFile(join(dir, file), "utf8");
    console.log(`+ apply ${file}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`INSERT INTO schema_migrations (filename) VALUES (${file})`;
    });
  }

  console.log("migrations complete");
  await sql.end();
}

main().catch(async (err) => {
  console.error(err);
  await sql.end();
  process.exit(1);
});
