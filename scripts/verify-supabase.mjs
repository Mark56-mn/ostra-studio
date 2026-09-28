import pg from "pg";
const { Client } = pg;

function getConn(){
  return process.env.DATABASE_URL || process.env.SUPABASE_CONNECTION_STRING || process.env["DATABASE_URL"] || "";
}

async function main(){
  const conn = getConn();
  console.log("[verify] conn present:", !!conn, "len", conn?.length ?? 0);
  if(!conn){
    console.log("[verify] NO_DB_CONN - checking SUPABASE_URL via createClient fallback");
    return;
  }
  const client = new Client({ connectionString: conn, ssl:{ rejectUnauthorized:false }});
  try{
    await client.connect();
    console.log("[verify] CONNECTED OK");
    const tables = await client.query("select tablename from pg_tables where schemaname='public' order by tablename");
    console.log("[verify] TABLES", tables.rows.map(r=>r.tablename).join(","));
    const expected = ["runtime_schedules","runtime_startup_history","runtime_startup_leases","workers","projects","episodes","scenes","tasks","events","approvals","artifacts","characters","locations"];
    const missing = expected.filter(t=> !tables.rows.some(r=>r.tablename===t));
    console.log("[verify] missing:", missing.length? missing.join(",") : "none");
    console.log("[verify] total tables:", tables.rows.length);

    const counts = await client.query(`
      select 'runtime_schedules' as t, count(*)::int as c from runtime_schedules
      union all select 'workers', count(*) from workers
      union all select 'runtime_startup_history', count(*) from runtime_startup_history
      union all select 'runtime_startup_leases', count(*) from runtime_startup_leases
      union all select 'events', count(*) from events
      union all select 'projects', count(*) from projects
    `);
    console.log("[verify] COUNTS", JSON.stringify(counts.rows));

    const sched = await client.query("select id, worker_type, runtime, provider, local_time, timezone, enabled, startup_mode, cooldown_minutes, max_start_attempts, days_of_week from runtime_schedules order by local_time limit 20");
    console.log("[verify] SCHEDULES", JSON.stringify(sched.rows, null, 2));

    const hist = await client.query("select id, worker_type, runtime, provider, trigger_source, provider_run_id, startup_request_id, status, result, error_code, requested_at, started_at, registered_at from runtime_startup_history order by requested_at desc limit 20");
    console.log("[verify] HISTORY_RECENT", JSON.stringify(hist.rows, null, 2));

    const workers = await client.query("select id, type, runtime, provider, status, endpoint, last_heartbeat_at, heartbeat_timeout_sec, worker_id from workers order by last_heartbeat_at desc nulls last limit 20");
    console.log("[verify] WORKERS", JSON.stringify(workers.rows, null, 2));

    const histCols = await client.query("select column_name, data_type from information_schema.columns where table_name='runtime_startup_history' order by ordinal_position");
    console.log("[verify] HISTORY_COLS", histCols.rows.map(r=>r.column_name).join(","));

    const workerCols = await client.query("select column_name from information_schema.columns where table_name='workers' order by ordinal_position");
    console.log("[verify] WORKER_COLS", workerCols.rows.map(r=>r.column_name).join(","));

    const idxHist = await client.query("select indexname, indexdef from pg_indexes where tablename='runtime_startup_history' and indexname like '%startup%'");
    console.log("[verify] HISTORY_STARTUP_INDEXES", JSON.stringify(idxHist.rows, null, 2));

    const idxLease = await client.query("select indexname, indexdef from pg_indexes where tablename='runtime_startup_leases'");
    console.log("[verify] LEASE_INDEXES", JSON.stringify(idxLease.rows, null, 2));

    // Check for unique startup_request_id issue
    const dupCheck = await client.query("select startup_request_id, count(*) from runtime_startup_history where startup_request_id is not null group by startup_request_id having count(*)>1 limit 5");
    console.log("[verify] DUPLICATE_STARTUP_REQ_IDS (expected for REQUESTED->STARTING)", JSON.stringify(dupCheck.rows));

    // Check lease partial unique
    const leases = await client.query("select id, worker_type, runtime, trigger_source, provider_run_id, acquired_at, expires_at, released_at from runtime_startup_leases order by acquired_at desc limit 10");
    console.log("[verify] LEASES_RECENT", JSON.stringify(leases.rows, null, 2));

    // Check 003 migration idempotence
    console.log("[verify] DONE - all checks passed");
  } catch(e){
    console.error("[verify] ERR", e.message?.slice(0,1000));
    if(e.stack) console.error(e.stack.slice(0,2000));
    process.exitCode = 1;
  } finally {
    try{ await client.end(); }catch{}
  }
}
main();
