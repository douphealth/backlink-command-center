/* One Cloudflare D1 database shared by Pages Functions and the scheduled Worker.
 * No fake seed activity and no runtime provider credentials in this module.
 */
export const CONTROL_DEFAULTS = Object.freeze({research_paused:false, outreach_paused:true, dataforseo_paused:true});
export const ACTIONS = Object.freeze({
  research:'Research competitor link gaps',
  audit_assets:'Verify owned linkable resources',
  verify:'Validate promising publishers',
  check_links:'Recheck actual placed links',
  monitor:'Review real outreach replies',
  weekly:'Review real outcomes and learning',
  sync_gsc:'Discover best owned URLs from direct GSC',
});
export const NOW = () => new Date().toISOString();

const TABLES = [
`CREATE TABLE IF NOT EXISTS login_attempts (ip_hash TEXT PRIMARY KEY, failed INTEGER NOT NULL DEFAULT 0, until_ms INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS operator_controls (key TEXT PRIMARY KEY, value INTEGER NOT NULL CHECK(value IN (0,1)), updated_at TEXT NOT NULL, updated_by TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS worker_status (id INTEGER PRIMARY KEY CHECK(id=1),started_at TEXT,last_seen_at TEXT,last_action TEXT,last_research_at TEXT,last_monitor_at TEXT,last_error TEXT,updated_at TEXT)`,
`CREATE TABLE IF NOT EXISTS worker_commands (id INTEGER PRIMARY KEY AUTOINCREMENT,action TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',requested_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,requested_by TEXT NOT NULL DEFAULT 'dashboard',outcome TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '')`,
`CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_unique_action ON worker_commands(action) WHERE status IN ('queued','running')`,
`CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT,time_utc TEXT NOT NULL,type TEXT NOT NULL,detail TEXT,candidate_id INTEGER)`,
`CREATE TABLE IF NOT EXISTS candidates (id INTEGER PRIMARY KEY AUTOINCREMENT,site TEXT NOT NULL,publisher_domain TEXT NOT NULL,source_url TEXT NOT NULL DEFAULT '',asset_url TEXT NOT NULL DEFAULT '',kind TEXT NOT NULL DEFAULT 'gap',title TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'found',score INTEGER,contact_email TEXT,source_checked_at TEXT,traffic_monthly INTEGER,spam_score REAL,domain_rank INTEGER,competitor_count INTEGER,excluded_reason TEXT,explicit_invitation INTEGER NOT NULL DEFAULT 0,last_updated TEXT NOT NULL,editorial_policy_url TEXT,UNIQUE(site,publisher_domain,source_url))`,
`CREATE INDEX IF NOT EXISTS idx_candidates_state ON candidates(status,site)`,
`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT,candidate_id INTEGER NOT NULL,to_address TEXT,subject TEXT,status TEXT NOT NULL DEFAULT 'draft',gmail_id TEXT,gmail_draft_id TEXT,sent_at TEXT,created_at TEXT NOT NULL,followup_at TEXT,FOREIGN KEY(candidate_id) REFERENCES candidates(id))`,
`CREATE TABLE IF NOT EXISTS verified_links (id INTEGER PRIMARY KEY AUTOINCREMENT,candidate_id INTEGER NOT NULL,placement_url TEXT NOT NULL,target_url TEXT NOT NULL,rel TEXT NOT NULL DEFAULT 'unknown',observed_at TEXT NOT NULL,UNIQUE(placement_url,target_url))`,
`CREATE TABLE IF NOT EXISTS submissions (id INTEGER PRIMARY KEY AUTOINCREMENT,site TEXT NOT NULL,publisher TEXT NOT NULL,form_url TEXT NOT NULL,asset_url TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'researched',blocker TEXT,needs_login INTEGER NOT NULL DEFAULT 0,needs_captcha INTEGER NOT NULL DEFAULT 0,rights_confirmed INTEGER NOT NULL DEFAULT 0,receipt TEXT,listing_url TEXT,checked_at TEXT NOT NULL,UNIQUE(site,form_url))`,
`CREATE TABLE IF NOT EXISTS suppression (identity TEXT PRIMARY KEY,reason TEXT NOT NULL,source TEXT NOT NULL,created_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS portfolio_assets (domain TEXT NOT NULL,url TEXT NOT NULL,http_status INTEGER,status TEXT NOT NULL DEFAULT 'unchecked',checked_at TEXT,PRIMARY KEY(domain,url))`,
`CREATE TABLE IF NOT EXISTS dfs_requests (request_id TEXT PRIMARY KEY,key_hash TEXT,site TEXT NOT NULL,endpoint TEXT NOT NULL,status TEXT NOT NULL,day_utc TEXT NOT NULL,month_utc TEXT NOT NULL,reserved_micro INTEGER NOT NULL,actual_micro INTEGER,created_at TEXT NOT NULL,finished_at TEXT,task_id TEXT,error_type TEXT)`,
`CREATE INDEX IF NOT EXISTS idx_dfs_period ON dfs_requests(month_utc,day_utc)`,
`CREATE TABLE IF NOT EXISTS dfs_spend_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,observed_utc TEXT NOT NULL,detail TEXT,cleared_utc TEXT)`,
`CREATE TABLE IF NOT EXISTS dfs_gap_domains (owned_site TEXT NOT NULL,publisher_domain TEXT NOT NULL,first_seen_utc TEXT,last_seen_utc TEXT,competitor_json TEXT,rank_1000 INTEGER,spam_score REAL,nofollow_share REAL,sample_status TEXT,PRIMARY KEY(owned_site,publisher_domain))`,
`CREATE TABLE IF NOT EXISTS dfs_cache (key_hash TEXT PRIMARY KEY,json_result TEXT NOT NULL,expires_utc TEXT NOT NULL,actual_micro INTEGER,task_id TEXT)`,
`CREATE TABLE IF NOT EXISTS dfs_account_watch (id INTEGER PRIMARY KEY AUTOINCREMENT,balance_micro INTEGER NOT NULL,accounted_micro INTEGER NOT NULL,checked_utc TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS outcomes (id INTEGER PRIMARY KEY AUTOINCREMENT,candidate_id INTEGER NOT NULL,outcome TEXT NOT NULL,evidence TEXT,time_utc TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS search_history (id INTEGER PRIMARY KEY AUTOINCREMENT,site TEXT,query TEXT,attempted_at TEXT,result_count INTEGER DEFAULT 0,inserted_count INTEGER DEFAULT 0,error TEXT)`,
`CREATE TABLE IF NOT EXISTS referral_metrics (id INTEGER PRIMARY KEY AUTOINCREMENT,site TEXT,referrer_domain TEXT,date TEXT,sessions INTEGER NOT NULL DEFAULT 0,engaged_sessions INTEGER,conversions INTEGER,source TEXT)`,
`CREATE TABLE IF NOT EXISTS gsc_sync_state (site TEXT PRIMARY KEY,last_attempt_at TEXT NOT NULL,last_result TEXT NOT NULL DEFAULT '')`,
`CREATE TABLE IF NOT EXISTS cron_locks (name TEXT PRIMARY KEY,owner TEXT NOT NULL,claimed_at TEXT NOT NULL,expires_at TEXT NOT NULL)`,
];

export async function ensureDb(db) {
  if (!db || typeof db.prepare!=='function') throw new Error('D1 binding DB is missing');
  // Avoid repeated DDL work in the common case. No data is seeded or fabricated.
  const found = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='operator_controls'").first();
  if (!found) {
    await db.batch(TABLES.map(sql=>db.prepare(sql)));
  }
  // Additive migration: existing databases predate the opportunity table.
  await db.prepare('CREATE TABLE IF NOT EXISTS url_opportunities (site TEXT NOT NULL,url TEXT NOT NULL,score REAL NOT NULL,impressions REAL,clicks REAL,position REAL,kind TEXT,state TEXT NOT NULL DEFAULT \'needs_validation\',measured_at TEXT NOT NULL,PRIMARY KEY(site,url))').run();
  await db.prepare("CREATE TABLE IF NOT EXISTS gsc_sync_state (site TEXT PRIMARY KEY,last_attempt_at TEXT NOT NULL,last_result TEXT NOT NULL DEFAULT '')").run();
  const stamp=NOW();
  await db.batch(Object.entries(CONTROL_DEFAULTS).map(([key,value])=>
    db.prepare('INSERT OR IGNORE INTO operator_controls(key,value,updated_at,updated_by) VALUES(?,?,?,?)')
      .bind(key,value?1:0,stamp,'default-safe')));
}

export async function query(db,sql,...values) {return (await db.prepare(sql).bind(...values).all()).results??[];}
export async function first(db,sql,...values) {return (await db.prepare(sql).bind(...values).first())??null;}
export async function run(db,sql,...values) {return db.prepare(sql).bind(...values).run();}
export async function count(db,table,where='1=1',params=[]) {
  if (!['candidates','messages','submissions','verified_links','suppression','dfs_requests','activity'].includes(table))throw Error('Invalid table');
  return (await first(db,`SELECT COUNT(*) AS total FROM ${table} WHERE ${where}`,...params))?.total??0;
}
export async function flags(db){const rows=await query(db,'SELECT key,value FROM operator_controls');const data={...CONTROL_DEFAULTS};for(const r of rows)data[r.key]=!!r.value;return data;}
export async function log(db,type,detail={},candidateId=null){
  await run(db,'INSERT INTO activity(time_utc,type,detail,candidate_id) VALUES(?,?,?,?)',NOW(),type,JSON.stringify(detail),candidateId);
}
export function workerSummary(row) {
  const age=row?.last_seen_at?Date.now()-Date.parse(row.last_seen_at):Infinity;
  const healthy=age>=0&&age<=75*60*1000&&row.last_action!=='stopped';
  return {running:healthy,label:healthy?'Scheduled Worker recently active':row?'Worker last check stale':'No scheduled Worker run recorded',last_seen_at:row?.last_seen_at??null,
    last_action:row?.last_action??null,last_research_at:row?.last_research_at??null,last_monitor_at:row?.last_monitor_at??null,last_error:row?.last_error??null};
}

export const SPENDING=Object.freeze({requestMicro:60000,dayMicro:120000,monthMicro:1000000,requestsPerDay:3,sitePerDay:2,rows:25});
export function csvSafe(v){if(v==null)return '';const s=String(v);return /^[\s]*[=+@-]/.test(s)?"'"+s:s;}
export function isDomain(s){return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(s)&&s.length<256;}
