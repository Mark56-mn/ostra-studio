import pg from "pg";
const { Client } = pg;
const conn = process.env.DATABASE_URL || process.env.SUPABASE_CONNECTION_STRING;
const c = new Client({ connectionString: conn, ssl:{rejectUnauthorized:false}});
await c.connect();
const r1 = await c.query("select count(*)::int as c from runtime_startup_history where trigger_source='scheduler:test-bettertrade'");
const r2 = await c.query("select count(*)::int as c from runtime_startup_leases where trigger_source='scheduler:test-bettertrade'");
const r3 = await c.query("select count(*)::int as c from workers where provider='kaggle' and type='script'");
console.log("leftover history test:", r1.rows[0].c);
console.log("leftover leases test:", r2.rows[0].c);
console.log("leftover workers kaggle:", r3.rows[0].c);
const r4 = await c.query("select count(*)::int as c from runtime_startup_history");
const r5 = await c.query("select count(*)::int as c from runtime_startup_leases where released_at is null");
console.log("total history now:", r4.rows[0].c);
console.log("active leases now:", r5.rows[0].c);
if (r1.rows[0].c>0 || r2.rows[0].c>0 || r3.rows[0].c>0) {
  await c.query("delete from runtime_startup_history where trigger_source='scheduler:test-bettertrade' or trigger_source='test-duplicate'");
  await c.query("delete from runtime_startup_leases where trigger_source='scheduler:test-bettertrade' or trigger_source like 'test-duplicate%'");
  await c.query("delete from workers where type='script' and runtime='kaggle' and provider='kaggle'");
  console.log("cleaned");
}
const r6 = await c.query("select count(*)::int as c from runtime_startup_history");
const r7 = await c.query("select count(*)::int as c from runtime_startup_leases where released_at is null");
const r8 = await c.query("select count(*)::int as c from runtime_schedules");
console.log("after: history", r6.rows[0].c, "active leases", r7.rows[0].c, "schedules", r8.rows[0].c);
await c.end();
