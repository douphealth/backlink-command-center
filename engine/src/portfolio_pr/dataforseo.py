"""Metered DataForSEO API v3 adapter for evidence-led backlink discovery.

ALL paid requests are explicitly enabled, priced from free /appendix/user_data,
reserved transactionally, cached, and NEVER retried when outcome is uncertain.
Amounts below represent USD, not LLM tokens. No credentials are persisted.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import base64
import binascii
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_CEILING
from hashlib import sha256
import json
import os
from urllib.parse import urlsplit

import requests

from .engine import Engine, host, reg_domain, is_public_url, utc_now

API_ROOT = 'https://api.dataforseo.com/v3/'
ALLOWED_ENDPOINTS = frozenset({
    'backlinks/competitors/live',
    'backlinks/domain_intersection/live',
    'backlinks/backlinks/live',
})

SCHEMA = """
CREATE TABLE IF NOT EXISTS dfs_requests (
    request_id TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL,
    site TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    day_utc TEXT NOT NULL,
    month_utc TEXT NOT NULL,
    reserved_micro INTEGER NOT NULL CHECK(reserved_micro>=0),
    actual_micro INTEGER CHECK(actual_micro>=0),
    status TEXT NOT NULL CHECK(status IN ('reserved','uncertain','completed','api_error')),
    created_at TEXT NOT NULL,
    finished_at TEXT,
    task_id TEXT,
    error_type TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_dfs_month ON dfs_requests(month_utc,status);
CREATE INDEX IF NOT EXISTS idx_dfs_day ON dfs_requests(day_utc,status);
CREATE TABLE IF NOT EXISTS dfs_cache (
    key_hash TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL,
    json_result TEXT NOT NULL,
    fetched_utc TEXT NOT NULL,
    expires_utc TEXT NOT NULL,
    actual_micro INTEGER NOT NULL,
    task_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dfs_account_watch (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    balance_micro INTEGER NOT NULL,
    accounted_micro INTEGER NOT NULL,
    checked_utc TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dfs_spend_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    observed_utc TEXT NOT NULL,
    detail TEXT NOT NULL,
    cleared_utc TEXT DEFAULT NULL
);
CREATE TABLE IF NOT EXISTS dfs_gap_domains (
    owned_site TEXT NOT NULL,
    publisher_domain TEXT NOT NULL,
    first_seen_utc TEXT NOT NULL,
    last_seen_utc TEXT NOT NULL,
    competitor_json TEXT NOT NULL,
    rank_1000 INTEGER,
    spam_score REAL,
    nofollow_share REAL,
    source TEXT NOT NULL,
    sample_status TEXT NOT NULL DEFAULT 'unverified',
    PRIMARY KEY(owned_site,publisher_domain)
);
"""


class DataForSEOError(RuntimeError):
    pass


class DataForSEOBlocked(DataForSEOError):
    """A budget, policy, credential, or account constraint stopped a paid call."""


class DataForSEOUncertain(DataForSEOError):
    """A paid POST was attempted but response was lost. NEVER auto-retry."""


def micro(amount: Decimal | str | float | int) -> int:
    try:
        amount = Decimal(str(amount))
        if not amount.is_finite() or amount < 0:
            raise ValueError('Invalid negative/nonfinite cost')
        return int((amount * 1_000_000).to_integral_value(rounding=ROUND_CEILING))
    except (InvalidOperation, TypeError) as exc:
        raise ValueError('Invalid USD cost') from exc


def usd(amount_micro: int) -> str:
    return f'{Decimal(amount_micro) / Decimal(1_000_000):.6f}'


@dataclass(frozen=True)
class Limits:
    # Very conservative opt-in starting ceilings; the operator can LOWER values.
    day_micro: int = micro('0.12')
    month_micro: int = micro('1.00')
    request_micro: int = micro('0.06')
    calls_day: int = 3
    calls_site_day: int = 2
    max_rows: int = 75
    cache_days: int = 21

    @classmethod
    def environment(cls):
        def amount(key, default):
            # No silent ceiling increases beyond the audited maximum defaults.
            v = micro(os.getenv(key, default))
            maximum = micro(default)
            if v > maximum:
                raise DataForSEOBlocked(f'{key} exceeds audited hard ceiling ${default}')
            return v
        def count(key, default):
            v = int(os.getenv(key, str(default)))
            if v < 0 or v > default:
                raise DataForSEOBlocked(f'{key} outside audited range 0..{default}')
            return v
        return cls(day_micro=amount('DFS_MAX_USD_PER_DAY','0.12'),
                   month_micro=amount('DFS_MAX_USD_PER_MONTH','1.00'),
                   request_micro=amount('DFS_MAX_USD_PER_REQUEST','0.06'),
                   calls_day=count('DFS_MAX_PAID_CALLS_DAY',3),
                   calls_site_day=count('DFS_MAX_CALLS_SITE_DAY',2),
                   max_rows=count('DFS_MAX_ROWS',75),
                   cache_days=max(7,min(90,int(os.getenv('DFS_CACHE_DAYS','21')))))


def _extract_user(resp: dict) -> dict:
    if resp.get('status_code') != 20000:
        raise DataForSEOBlocked('DataForSEO free account/pricing check did not succeed')
    tasks=resp.get('tasks') or []
    if len(tasks)!=1 or tasks[0].get('status_code') != 20000:
        raise DataForSEOBlocked('DataForSEO free account-check task failed')
    values=tasks[0].get('result') or []
    if not isinstance(values,list) or not values or not isinstance(values[0],dict):
        raise DataForSEOBlocked('DataForSEO account response missing expected result')
    return values[0]


def _rate_from_user(user: dict, endpoint: str) -> tuple[Decimal, Decimal]:
    parts=endpoint.split('/')
    if len(parts)!=3 or parts[0]!='backlinks' or parts[2]!='live':
        raise DataForSEOBlocked('Endpoint not supported for account-specific pricing')
    # DataForSEO account response: `price` holds endpoint prices; `rates` holds usage limits.
    rates=(user.get('price') or {}).get('backlinks') or {}
    scope=(rates.get(parts[1]) or {}).get('live') or {}
    entries=scope.get('priority_normal')
    if not isinstance(entries,list) or not entries:
        raise DataForSEOBlocked('Current DataForSEO rate unavailable: paid API disabled')
    fixed=Decimal('0'); per_row=Decimal('0'); found=set()
    for entry in entries:
        try:
            label=str(entry.get('cost_type','')).lower().replace('_','')
            cost=Decimal(str(entry.get('cost','invalid')))
            if cost<0 or not cost.is_finite() or label not in ('perrequest','perresult'):
                raise ValueError()
        except (TypeError,ValueError,InvalidOperation,AttributeError) as exc:
            raise DataForSEOBlocked('Unrecognized account price component; paid API blocked') from exc
        found.add(label)
        if label=='perrequest':fixed+=cost
        else:per_row+=cost
    if found != {'perrequest','perresult'}:
        raise DataForSEOBlocked('Cannot verify both per-request and per-row account prices')
    # An account rate of zero can be legitimate (credit), but still reserve floor.
    return fixed,per_row


def _read_basic_auth_file(filepath: str) -> tuple[str, str]:
    """Read a private, Base64 encoded `login:password` file without logging secrets.

    The file is injected at runtime (for example, via a Docker Compose secret).
    It is NEVER bundled into a distribution artifact or written to SQLite.
    """
    try:
        path = Path(filepath)
        if not path.is_file() or path.stat().st_size > 8192:
            raise ValueError('invalid credential file')
        raw = path.read_bytes().strip()
        decoded = base64.b64decode(raw, validate=True)
        login, password = decoded.decode('utf-8').split(':', 1)
        if (not login or not password or
                any(c in login or c in password for c in '\x00\r\n')):
            raise ValueError('invalid credential pair')
        return login, password
    except (OSError, ValueError, UnicodeError, binascii.Error) as exc:
        # No exception string, file contents, password or original exception chain.
        raise DataForSEOBlocked('Unreadable or invalid DataForSEO Basic Auth secret file') from None


class DataForSEO:
    def __init__(self, engine: Engine, *, login: str | None=None, password: str | None=None,
                 session=None, limits: Limits | None=None, enabled: bool | None=None):
        self.engine=engine
        self.session=session or requests.Session()
        env_login = os.getenv('DATAFORSEO_LOGIN') or os.getenv('DATAFORSEO_API_LOGIN') or ''
        env_password = os.getenv('DATAFORSEO_PASSWORD') or os.getenv('DATAFORSEO_API_PASSWORD') or ''
        auth_file = os.getenv('DATAFORSEO_BASIC_AUTH_FILE') or ''
        if login is not None or password is not None:
            self.login, self.password = login or '', password or ''
        elif env_login or env_password:
            # Never mix half of an environment pair with a mounted secret.
            self.login, self.password = env_login, env_password
        elif auth_file:
            self.login, self.password = _read_basic_auth_file(auth_file)
        else:
            self.login, self.password = '', ''
        self.enabled = (os.getenv('DATAFORSEO_PAID_ENABLED','NO') == 'YES') if enabled is None else enabled
        self.limits = limits or Limits.environment()
        self.engine.conn.executescript(SCHEMA)
        self.engine.conn.commit()
        self._user=None
        self._user_at=None

    @property
    def configured(self) -> bool:
        return bool(self.login and self.password)

    def account(self, *, force=False):
        """Free GET: authenticated user_data supplies actual pricing and balance."""
        if not self.configured:
            raise DataForSEOBlocked('DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD absent; no paid calls made')
        now=datetime.now(timezone.utc)
        if self._user is not None and not force and now-self._user_at<timedelta(minutes=30):
            return self._user
        try:
            r=self.session.get(API_ROOT+'appendix/user_data',auth=(self.login,self.password),
                               headers={'Accept':'application/json'},timeout=(5,15),allow_redirects=False)
            r.raise_for_status()
            result=_extract_user(r.json())
        except (requests.RequestException,ValueError,KeyError,TypeError) as exc:
            # Free request failure never falls back to guessed prices.
            raise DataForSEOBlocked(f'Free DataForSEO account/rate validation failed ({type(exc).__name__})') from exc
        balance=(result.get('money') or {}).get('balance')
        try:
            if balance is None or Decimal(str(balance))<0:
                raise ValueError()
        except (ValueError,InvalidOperation,TypeError) as exc:
            raise DataForSEOBlocked('Cannot verify positive DataForSEO balance; paid API blocked') from exc
        # Detect other clients draining the same DataForSEO account. Our local
        # budgets cannot police APIs outside this one SQLite database. Compare
        # provider-balance movement to our own billed/reserved ledger, and STOP
        # on unexpected usage rather than quietly burning additional credits.
        if os.getenv('DFS_MONITOR_EXTERNAL_SPEND','YES') == 'YES':
            balance_micro=micro(balance)
            own= self.engine.conn.execute('''SELECT COALESCE(SUM(COALESCE(actual_micro,reserved_micro)),0) n
                 FROM dfs_requests''').fetchone()['n']
            last=self.engine.conn.execute('''SELECT balance_micro,accounted_micro FROM dfs_account_watch
                 ORDER BY id DESC LIMIT 1''').fetchone()
            if last is not None:
                delta=max(0, int(last['balance_micro'])-balance_micro)
                explained=max(0, int(own)-int(last['accounted_micro']))
                unexplained=delta-explained
                if unexplained>micro('0.005'):
                    evidence={'observed_provider_balance_drop_usd':usd(delta),
                       'known_local_spend_or_reserved_usd':usd(explained),
                       'unexplained_usd':usd(unexplained),
                       'policy':'No further paid requests until spending is independently audited'}
                    self.engine.log('dfs_external_spend_alert',evidence)
                    self.engine.conn.execute('''INSERT INTO dfs_spend_alerts(kind,observed_utc,detail)
                         VALUES(?,?,?)''',('unexplained_provider_spend',utc_now(),json.dumps(evidence)))
                    self.engine.conn.commit()
                    raise DataForSEOBlocked('Unexpected external DataForSEO account spending detected; paid requests paused')
            self.engine.conn.execute('''INSERT INTO dfs_account_watch(balance_micro,accounted_micro,checked_utc)
                 VALUES(?,?,?)''',(balance_micro,int(own),utc_now()))
            self.engine.conn.commit()
        self._user=result
        self._user_at=now
        return result

    def _stable_key(self, endpoint: str, payload: dict):
        value=json.dumps({'endpoint':endpoint,'payload':payload},sort_keys=True,separators=(',',':'))
        return sha256(value.encode()).hexdigest()

    def _get_cache(self, key_hash):
        row=self.engine.conn.execute('SELECT json_result,expires_utc,actual_micro,task_id FROM dfs_cache WHERE key_hash=?',(key_hash,)).fetchone()
        if not row or row['expires_utc']<=utc_now():return None
        return {'data':json.loads(row['json_result']),'cached':True,
                'actual_usd':usd(row['actual_micro']),'task_id':row['task_id']}

    def status(self):
        conn=self.engine.conn
        d=datetime.now(timezone.utc)
        day=d.strftime('%Y-%m-%d');month=d.strftime('%Y-%m')
        def spent(where,val):
            return int(conn.execute(f'''SELECT COALESCE(SUM(COALESCE(actual_micro,reserved_micro)),0) v
                FROM dfs_requests WHERE {where}=?''',(val,)).fetchone()['v'])
        by_day=spent('day_utc',day);by_month=spent('month_utc',month)
        count=conn.execute('SELECT COUNT(*) c FROM dfs_requests WHERE day_utc=?',(day,)).fetchone()['c']
        uncertain=conn.execute("SELECT COUNT(*) c FROM dfs_requests WHERE status IN ('reserved','uncertain')").fetchone()['c']
        external_alerts=conn.execute('SELECT COUNT(*) c FROM dfs_spend_alerts WHERE cleared_utc IS NULL').fetchone()['c']
        return {'configured':self.configured,'paid_enabled':self.enabled,'currency':'USD',
                'day_spend_or_reserved_usd':usd(by_day),'month_spend_or_reserved_usd':usd(by_month),
                'day_ceiling_usd':usd(self.limits.day_micro),'month_ceiling_usd':usd(self.limits.month_micro),
                'paid_requests_today':count,'unreconciled_paid_requests':uncertain,
                'unresolved_external_spend_alerts':external_alerts,
                'cache_rows':conn.execute('SELECT COUNT(*) c FROM dfs_cache').fetchone()['c']}

    def _reserve(self,key_hash,site,endpoint,upper_micro):
        conn=self.engine.conn
        now=datetime.now(timezone.utc);day=now.strftime('%Y-%m-%d');month=now.strftime('%Y-%m')
        req_id=sha256((key_hash+'|'+day).encode()).hexdigest()
        try:
            conn.execute('BEGIN IMMEDIATE')
            prior=conn.execute('SELECT status FROM dfs_requests WHERE request_id=?',(req_id,)).fetchone()
            if prior:
                raise DataForSEOBlocked('Same paid request already attempted today; no duplicate charge')
            rows=conn.execute('''SELECT site,day_utc,month_utc,COALESCE(actual_micro,reserved_micro) charge
                 FROM dfs_requests WHERE month_utc=?''',(month,)).fetchall()
            # A timed-out response may have been billed. Pause all paid operations
            # until explicitly reconciled; never compound an unknown balance.
            stale=conn.execute("SELECT COUNT(*) c FROM dfs_requests WHERE status IN ('reserved','uncertain')").fetchone()['c']
            if stale:
                raise DataForSEOBlocked('Unreconciled paid request detected; global spending circuit breaker active')
            alert=conn.execute('SELECT COUNT(*) c FROM dfs_spend_alerts WHERE cleared_utc IS NULL').fetchone()['c']
            if alert:
                raise DataForSEOBlocked('Unresolved external DataForSEO spending anomaly; paid API globally paused')
            overruns=conn.execute('''SELECT COUNT(*) c FROM dfs_requests WHERE actual_micro>reserved_micro''').fetchone()['c']
            if overruns:
                raise DataForSEOBlocked('Prior provider cost exceeded reservation; audit account before proceeding')
            total=sum(r['charge'] for r in rows)
            daily=sum(r['charge'] for r in rows if r['day_utc']==day)
            site_calls=sum(1 for r in rows if r['day_utc']==day and r['site']==site)
            daily_calls=sum(1 for r in rows if r['day_utc']==day)
            if total+upper_micro>self.limits.month_micro:
                raise DataForSEOBlocked('Hard monthly DataForSEO USD budget reached; paid calls paused')
            if daily+upper_micro>self.limits.day_micro:
                raise DataForSEOBlocked('Hard daily DataForSEO USD budget reached; paid calls paused')
            if daily_calls>=self.limits.calls_day or site_calls>=self.limits.calls_site_day:
                raise DataForSEOBlocked('Hard daily DataForSEO call-count cap reached; paid calls paused')
            conn.execute('''INSERT INTO dfs_requests(request_id,key_hash,site,endpoint,day_utc,month_utc,
               reserved_micro,status,created_at) VALUES(?,?,?,?,?,?,?,'reserved',?)''',
               (req_id,key_hash,site,endpoint,day,month,upper_micro,utc_now()))
            conn.commit()
            return req_id
        except Exception:
            conn.rollback()
            raise

    def _complete(self,request_id,status,actual=None,task_id='',error=''):
        self.engine.conn.execute('''UPDATE dfs_requests SET status=?,actual_micro=?,finished_at=?,task_id=?,error_type=? WHERE request_id=?''',
                                 (status,actual,utc_now(),task_id,error[:120],request_id))
        self.engine.conn.commit()

    def post(self,endpoint: str,payload:dict, *, site:str, ttl_days:int|None=None):
        if endpoint not in ALLOWED_ENDPOINTS:
            raise DataForSEOBlocked('Paid endpoint not allowlisted')
        site=reg_domain(site)
        if not site:raise DataForSEOBlocked('An owned portfolio site is required')
        requested=int(payload.get('limit',0))
        if requested<1 or requested>self.limits.max_rows:
            raise DataForSEOBlocked(f'Request limit 1..{self.limits.max_rows} results only')
        key=self._stable_key(endpoint,payload)
        hit=self._get_cache(key)
        if hit:return hit
        if not self.enabled:
            raise DataForSEOBlocked('Paid DataForSEO calls disabled (set DATAFORSEO_PAID_ENABLED=YES after credentials/budget review)')
        if self.engine.conn.execute('SELECT 1 FROM dfs_spend_alerts WHERE cleared_utc IS NULL LIMIT 1').fetchone():
            raise DataForSEOBlocked('Unresolved external DataForSEO spending anomaly; paid API globally paused')
        if self.engine.conn.execute("SELECT 1 FROM dfs_requests WHERE status IN ('reserved','uncertain') LIMIT 1").fetchone():
            raise DataForSEOBlocked('Unreconciled paid DataForSEO request; paid API globally paused')
        # Each paid task must confirm the account's CURRENT balance/rates; free GET.
        user=self.account(force=True)
        fixed,rowprice=_rate_from_user(user,endpoint)
        # Worst-case priced per full requested row count, with 25% headroom; no rate guessing.
        predicted_micro=micro((fixed+rowprice*requested)*Decimal('1.25'))
        predicted_micro=max(predicted_micro,micro('0.0001'))
        if predicted_micro>self.limits.request_micro:
            raise DataForSEOBlocked('Expected DataForSEO charge exceeds hard per-request ceiling')
        balance_micro=micro(user['money']['balance'])
        if predicted_micro>balance_micro:
            raise DataForSEOBlocked('Verified DataForSEO account balance too low for reserved worst-case charge')
        req_id=self._reserve(key,site,endpoint,predicted_micro)
        response_data=None
        try:
            resp=self.session.post(API_ROOT+endpoint,auth=(self.login,self.password),json=[payload],
                                   headers={'Accept':'application/json','Content-Type':'application/json'},
                                   timeout=(5,22),allow_redirects=False)
            # Deliberately NO network retries, even for HTTP 429 or 5xx.
            resp.raise_for_status()
            response_data=resp.json()
        except (requests.RequestException,ValueError,TypeError) as exc:
            self._complete(req_id,'uncertain',error=type(exc).__name__)
            raise DataForSEOUncertain(f'Paid request attempted; outcome uncertain ({type(exc).__name__}); no retries') from exc
        tasks=response_data.get('tasks') or [] if isinstance(response_data,dict) else []
        if len(tasks)!=1:
            self._complete(req_id,'uncertain',error='invalid_task_shape')
            raise DataForSEOUncertain('Paid request returned unrecognized task structure; no retry')
        task=tasks[0]
        try:
            price=task.get('cost')
            if price is None:price=response_data['cost']
            actual_micro=micro(price)
        except (KeyError,ValueError,TypeError):
            self._complete(req_id,'uncertain',error='no_actual_cost')
            raise DataForSEOUncertain('Paid response did not include auditable actual USD cost')
        if response_data.get('status_code')!=20000 or task.get('status_code')!=20000:
            self._complete(req_id,'api_error',actual_micro,str(task.get('id','')),str(task.get('status_code','')))
            raise DataForSEOError(f'API rejected task (status {task.get("status_code","unknown")}); actual USD {usd(actual_micro)}')
        if not isinstance(task.get('result'),list):
            self._complete(req_id,'uncertain',error='missing_results')
            raise DataForSEOUncertain('Successful paid task missing results; reserved budget remains held')
        if actual_micro>predicted_micro:
            # Record actual, log discrepancy, stop FURTHER calls via status() and incident check.
            self.engine.log('dfs_price_overrun',{'endpoint':endpoint,'reserved_usd':usd(predicted_micro),
                                                'actual_usd':usd(actual_micro)})
        self._complete(req_id,'completed',actual_micro,str(task.get('id','')))
        ttl=max(7,min(90,ttl_days if ttl_days is not None else self.limits.cache_days))
        result=task.get('result')
        expire=(datetime.now(timezone.utc)+timedelta(days=ttl)).isoformat(timespec='seconds')
        self.engine.conn.execute('''INSERT INTO dfs_cache(key_hash,endpoint,json_result,fetched_utc,expires_utc,
             actual_micro,task_id) VALUES(?,?,?,?,?,?,?)
             ON CONFLICT(key_hash) DO UPDATE SET json_result=excluded.json_result,
             fetched_utc=excluded.fetched_utc,expires_utc=excluded.expires_utc,
             actual_micro=excluded.actual_micro,task_id=excluded.task_id''',
             (key,endpoint,json.dumps(result),utc_now(),expire,actual_micro,str(task.get('id',''))))
        self.engine.conn.commit()
        self.engine.log('dfs_paid_success',{'site':site,'endpoint':endpoint,'actual_usd':usd(actual_micro),
                                            'rows':sum(len(r.get('items') or []) for r in result),
                                            'task_id':task.get('id')})
        return {'data':result,'cached':False,'actual_usd':usd(actual_micro),'task_id':str(task.get('id',''))}

    def domain_gap(self, owned_site:str, competitors:list[str], *, limit:int=60):
        owned=reg_domain(owned_site)
        peers=list(dict.fromkeys(reg_domain(x) for x in competitors))
        peers=[x for x in peers if x and x!=owned]
        if len(peers)<2 or len(peers)>4:
            raise DataForSEOBlocked('Need 2-4 genuinely comparable competitor domains; refuse unrelated peers')
        # Two peers per call minimizes wasted empty intersections; rotating peer pairs is a later research decision.
        peers=peers[:2]
        payload={'targets':{'1':peers[0],'2':peers[1]},'exclude_targets':[owned],
                 'include_subdomains':False,'exclude_internal_backlinks':True,
                 'backlinks_status_type':'live','order_by':['1.rank,desc'],
                 'limit':min(int(limit),self.limits.max_rows)}
        ret=self.post('backlinks/domain_intersection/live',payload,site=owned,ttl_days=21)
        candidates=[];discard={'spam':0,'nofollow':0,'duplicate_or_suppressed':0,'invalid':0}
        for result in ret['data']:
            for item in result.get('items') or []:
                slots=item.get('domain_intersection') or {}
                n=int((item.get('summary') or {}).get('intersections_count') or len(slots))
                if n<2:continue
                examples=[z for z in slots.values() if isinstance(z,dict)]
                if not examples:continue
                publisher=reg_domain(examples[0].get('target',''))
                if not publisher or publisher==owned or any(publisher==c for c in peers):
                    discard['invalid']+=1;continue
                if self.engine.is_suppressed(publisher=publisher) or self.engine.publisher_already_in_pipeline(publisher):
                    discard['duplicate_or_suppressed']+=1;continue
                scores=[z.get('backlinks_spam_score') for z in examples if z.get('backlinks_spam_score') is not None]
                spam=max(float(s) for s in scores) if scores else None
                ranks=[z.get('rank') for z in examples if z.get('rank') is not None]
                rank=max(int(r) for r in ranks) if ranks else None
                fractions=[float(z['referring_pages_nofollow'])/float(z['referring_pages']) for z in examples
                           if z.get('referring_pages_nofollow') is not None and (z.get('referring_pages') or 0)>0]
                nofollow=sum(fractions)/len(fractions) if fractions else None
                if spam is not None and spam>30:discard['spam']+=1;continue
                if nofollow is not None and nofollow>0.7:discard['nofollow']+=1;continue
                self.engine.conn.execute('''INSERT INTO dfs_gap_domains(owned_site,publisher_domain,first_seen_utc,
                   last_seen_utc,competitor_json,rank_1000,spam_score,nofollow_share,source)
                   VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owned_site,publisher_domain) DO UPDATE SET
                   last_seen_utc=excluded.last_seen_utc,competitor_json=excluded.competitor_json,
                   rank_1000=excluded.rank_1000,spam_score=excluded.spam_score,
                   nofollow_share=excluded.nofollow_share''',
                   (owned,publisher,utc_now(),utc_now(),json.dumps(peers),rank,spam,nofollow,
                    'DataForSEO domain_intersection/live'))
                candidates.append({'publisher':publisher,'rank_1000':rank,
                                   'spam_score':spam,'nofollow_share':nofollow,'competitors':peers,
                                   'needs_exact_link_page':True})
        self.engine.conn.commit()
        self.engine.log('dfs_gap_research',{'site':owned,'peer_count':len(peers),
                                            'domains':len(candidates),'rejected':discard,
                                            'cached':ret['cached'],'paid_usd':ret['actual_usd']})
        return {'site':owned,'competitors':peers,'candidate_domains':candidates,
                'rejected':discard,'cached':ret['cached'],'paid_usd':ret['actual_usd'],
                'actual_backlink_pages_sampled':0}

    def enrich_page(self,owned_site:str, publisher_domain:str, competitor:str,
                    asset_url:str, *,limit:int=3):
        """Spend for an exact source page ONLY after cheap domain-level qualification."""
        owned=reg_domain(owned_site);publisher=reg_domain(publisher_domain);peer=reg_domain(competitor)
        gap=self.engine.conn.execute('''SELECT competitor_json,rank_1000,spam_score,nofollow_share
          FROM dfs_gap_domains WHERE owned_site=? AND publisher_domain=?''',(owned,publisher)).fetchone()
        if not gap or peer not in json.loads(gap['competitor_json']):
            raise DataForSEOBlocked('Competitor/page sample not in verified stored link-gap set')
        if self.engine.is_suppressed(publisher=publisher) or self.engine.publisher_already_in_pipeline(publisher):
            raise DataForSEOBlocked('Publisher previously contacted or suppressed')
        if not is_public_url(asset_url) or reg_domain(asset_url)!=owned:
            raise DataForSEOBlocked('Asset URL not under owned portfolio domain')
        payload={'target':peer,'mode':'as_is','filters':['domain_from','like','%'+publisher],
                 'backlinks_status_type':'live','order_by':['rank,desc'],
                 'limit':min(5,max(1,int(limit)))}
        ret=self.post('backlinks/backlinks/live',payload,site=owned,ttl_days=21)
        sources=[]
        for result in ret['data']:
            for item in result.get('items') or []:
                url=item.get('url_from','')
                if (reg_domain(url)!=publisher or not is_public_url(url)
                     or reg_domain(item.get('url_to',''))!=peer):continue
                if item.get('page_from_status_code') not in (None,200):continue
                sources.append({'source_url':url,'target_url':item.get('url_to',''),
                                'anchor':item.get('anchor'),'page_title':item.get('page_from_title')})
        # DataForSEO indexed links may be stale; local Engine.verify() must check live HTML.
        accepted=[]
        for item in sources[:2]:
            cid=self.engine.add_candidate(site=owned,source_url=item['source_url'],asset_url=asset_url,
              kind='competitor_gap',title=item.get('page_title') or '',
              competitor_names=json.loads(gap['competitor_json']),
              spam_score=gap['spam_score'],domain_rank=gap['rank_1000'],
              nofollow_share=gap['nofollow_share'])
            # DataForSEO exclude_targets=[owned] establishes a provider-scoped
            # owned-domain baseline for this gap (still recheck any claimed link live).
            self.engine.conn.execute('UPDATE candidates SET gap_own_baseline_verified=1 WHERE id=?',(cid,))
            accepted.append({'id':cid,'source_url':item['source_url'],'backlink_to_competitor':item['target_url']})
        self.engine.conn.execute('''UPDATE dfs_gap_domains SET sample_status=?
             WHERE owned_site=? AND publisher_domain=?''',
             ('candidate_page_found' if accepted else 'no_suitable_page',owned,publisher))
        self.engine.conn.commit()
        self.engine.log('dfs_page_sample',{'site':owned,'publisher':publisher,'pages':len(accepted),
                                            'paid_usd':ret['actual_usd'],'cached':ret['cached']})
        return {'source_pages':accepted,'cached':ret['cached'],'paid_usd':ret['actual_usd']}

    def discover_peer_domains(self,site:str,*,limit:int=12):
        """Optional paid discovery, NOT proof of topical similarity. Requires human/website vetting."""
        owned=reg_domain(site)
        payload={'target':owned,'exclude_large_domains':True,'main_domain':True,
                 'order_by':['rank,desc'],'limit':min(20,max(2,int(limit)))}
        ret=self.post('backlinks/competitors/live',payload,site=owned,ttl_days=30)
        peers=[]
        for item in (ret['data'][0].get('items') or []) if ret['data'] else []:
            candidate=reg_domain(item.get('target',''))
            if not candidate or candidate==owned or self.engine.is_suppressed(publisher=candidate):continue
            peers.append({'domain':candidate,'rank_1000':item.get('rank'),
                          'backlink_intersections_with_owned':item.get('intersections'),
                          'topical_fit_verified':False})
        return {'candidates':peers,'cached':ret['cached'],'actual_usd':ret['actual_usd'],
                'warning':'DataForSEO backlink-overlap competitors are NOT necessarily topical peers'}
