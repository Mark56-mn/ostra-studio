// scripts/apply-migration.mjs
// Apply a SQL migration file from supabase/migrations to the live Postgres database.
//
//   node scripts/apply-migration.mjs supabase/migrations/004_model_controls.sql
//
// Uses the same connection path as scripts/verify-supabase.mjs (DATABASE_URL ||
// SUPABASE_CONNECTION_STRING, ssl rejectUnauthorized:false). The migration file is
// executed in a single transaction so a failure leaves the database untouched.
// Every migration in this repo is idempotent (IF NOT EXISTS / additive), so re-running
// this script is safe.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const { Client } = pg;

function getConn() {
  return process.env.DATABASE_URL || process.env.SUPABASE_CONNECTION_STRING || "";
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("[migrate] usage: node scripts/apply-migration.mjs <path-to-migration.sql>");
    process.exitCode = 1;
    return;
  }

  const conn = getConn();
  console.log("[migrate] file:", file);
  console.log("[migrate] conn present:", !!conn);
  if (!conn) {
    console.error("[migrate] NO_DB_CONN — set DATABASE_URL or SUPABASE_CONNECTION_STRING");
    process.exitCode = 1;
    return;
  }

  const path = resolve(process.cwd(), file);
  let sql;
  try {
    sql = readFileSync(path, "utf8");
  } catch (e) {
    console.error("[migrate] cannot read", path, e.message);
    process.exitCode = 1;
    return;
  }
  console.log("[migrate] sql bytes:", sql.length);

  const client = new Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    console.log("[migrate] CONNECTED OK");

    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("commit");
      console.log("[migrate] APPLIED OK");
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    }

    // Report what is actually in the database now — never claim success without this.
    const t = await client.query(
      "select 1 as ok from pg_tables where schemaname='public' and tablename='model_controls'",
    );
    console.log("[migrate] model_controls table:", t.rowCount ? "present" : "MISSING");

    const cols = await client.query(
      "select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' and table_name='model_controls' order by ordinal_position",
    );
    console.log("[migrate] model_controls columns:");
    for (const r of cols.rows) {
      console.log(
        `  ${r.column_name} ${r.data_type}${r.is_nullable === "NO" ? " not null" : ""}${
          r.column_default ? ` default ${r.column_default}` : ""
        }`,
      );
    }

    const cons = await client.query(
      `select conname, pg_get_constraintdef(oid) as def
         from pg_constraint
        where conrelid = 'runtime_startup_history'::regclass
          and conname in ('runtime_startup_history_result_check','runtime_startup_history_status_check')
        order by conname`,
    );
    console.log("[migrate] runtime_startup_history checks:");
    for (const r of cons.rows) {
      console.log(`  ${r.conname} allows skipped_disabled: ${r.def.includes("skipped_disabled")}`);
    }

    const trg = await client.query(
      "select tgname from pg_trigger where tgrelid = 'model_controls'::regclass and not tgisinternal",
    );
    console.log("[migrate] model_controls triggers:", trg.rows.map((r) => r.tgname).join(",") || "none");

    const n = await client.query("select count(*)::int as c from model_controls");
    console.log("[migrate] model_controls rows:", n.rows[0]?.c);

    console.log("[migrate] DONE");
  } catch (e) {
    console.error("[migrate] ERR", e.message?.slice(0, 2000));
    if (e.stack) console.error(e.stack.slice(0, 2000));
    process.exitCode = 1;
  } finally {
    try {
      await client.end();
    } catch {}
  }
}

main();
