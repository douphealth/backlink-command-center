"""Evidence-first backlink prospecting engine; never turns a pitch into a claimed backlink.

The implementation is intentionally conservative. Scores represent editorial fit, not
DA/DR or predicted rankings. Missing commercial SEO metrics remain NULL, not zero.
"""
from __future__ import annotations

import csv
import hashlib
import html
from html.parser import HTMLParser
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin, urlsplit

import requests

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS candidates (
 id INTEGER PRIMARY KEY, site TEXT NOT NULL, source_url TEXT NOT NULL,
 publisher_domain TEXT NOT NULL, asset_url TEXT NOT NULL, kind TEXT NOT NULL,
 title TEXT NOT NULL DEFAULT '', editorial_evidence TEXT NOT NULL DEFAULT '',
 editorial_policy_url TEXT NOT NULL DEFAULT '', contact_email TEXT NOT NULL DEFAULT '',
 contact_source_url TEXT NOT NULL DEFAULT '', source_status INTEGER,
 asset_status INTEGER, source_checked_at TEXT, asset_checked_at TEXT,
 live_already_links INTEGER NOT NULL DEFAULT 0, explicit_invitation INTEGER NOT NULL DEFAULT 0,
 spam_score REAL, traffic_monthly REAL, domain_rank REAL,
 nofollow_share REAL, competitor_count INTEGER NOT NULL DEFAULT 0,
 competitor_names TEXT NOT NULL DEFAULT '[]',
 score INTEGER, excluded_reason TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'found',
 source_title TEXT NOT NULL DEFAULT '', last_updated TEXT NOT NULL DEFAULT '',
 unique_key TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS activity (
 id INTEGER PRIMARY KEY, time_utc TEXT NOT NULL, type TEXT NOT NULL,
 candidate_id INTEGER, provider_id TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL,
 FOREIGN KEY(candidate_id) REFERENCES candidates(id)
);
CREATE TABLE IF NOT EXISTS messages (
 id INTEGER PRIMARY KEY, candidate_id INTEGER NOT NULL UNIQUE, to_address TEXT NOT NULL,
 subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
 gmail_id TEXT UNIQUE, gmail_draft_id TEXT, followup_draft_id TEXT, followup_at TEXT, created_at TEXT NOT NULL, sent_at TEXT,
 FOREIGN KEY(candidate_id) REFERENCES candidates(id)
);
CREATE TABLE IF NOT EXISTS suppression (
 identity TEXT PRIMARY KEY, reason TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_usage (
 day TEXT NOT NULL, provider TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(day, provider)
);
CREATE TABLE IF NOT EXISTS outcomes (
 id INTEGER PRIMARY KEY, candidate_id INTEGER NOT NULL,
 outcome TEXT NOT NULL, evidence TEXT NOT NULL, time_utc TEXT NOT NULL,
 UNIQUE(candidate_id,outcome,evidence), FOREIGN KEY(candidate_id) REFERENCES candidates(id)
);
CREATE TABLE IF NOT EXISTS verified_links (
 candidate_id INTEGER PRIMARY KEY, placement_url TEXT NOT NULL,
 target_url TEXT NOT NULL, rel TEXT NOT NULL, observed_at TEXT NOT NULL,
 FOREIGN KEY(candidate_id) REFERENCES candidates(id)
);
CREATE INDEX IF NOT EXISTS idx_site ON candidates(site, score DESC);
CREATE INDEX IF NOT EXISTS idx_status ON candidates(status);
-- v4: Reusable, auditable cross-site asset/search/form inventories.
CREATE TABLE IF NOT EXISTS portfolio_assets (
 domain TEXT NOT NULL,url TEXT PRIMARY KEY,checked_at TEXT NOT NULL,
 http_status INTEGER NOT NULL,title TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'unverified',error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS search_history (
 id INTEGER PRIMARY KEY,site TEXT NOT NULL,query TEXT NOT NULL,
 query_key TEXT NOT NULL,attempted_at TEXT NOT NULL,result_count INTEGER NOT NULL DEFAULT 0,
 inserted_count INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_search_site ON search_history(site,attempted_at);
CREATE INDEX IF NOT EXISTS idx_search_query ON search_history(site,query_key,attempted_at);
CREATE TABLE IF NOT EXISTS submissions (
 id INTEGER PRIMARY KEY,site TEXT NOT NULL,publisher TEXT NOT NULL,
 form_url TEXT NOT NULL,asset_url TEXT NOT NULL,eligibility TEXT NOT NULL DEFAULT '',
 needs_login INTEGER NOT NULL DEFAULT 0,needs_captcha INTEGER NOT NULL DEFAULT 0,
 rights_confirmed INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'researched',
 source_url TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,
 checked_at TEXT,blocker TEXT NOT NULL DEFAULT '',page_title TEXT NOT NULL DEFAULT '',
 receipt TEXT,submitted_at TEXT,listing_url TEXT NOT NULL DEFAULT '',
 UNIQUE(site,form_url,asset_url)
);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
CREATE TABLE IF NOT EXISTS referral_metrics (
 id INTEGER PRIMARY KEY,site TEXT NOT NULL,referrer_domain TEXT NOT NULL,
 date TEXT NOT NULL,sessions INTEGER NOT NULL,engaged_sessions INTEGER,
 conversions INTEGER,source TEXT NOT NULL,imported_at TEXT NOT NULL,
 UNIQUE(site,referrer_domain,date,source)
);

CREATE TABLE IF NOT EXISTS thread_scans (
 candidate_id INTEGER PRIMARY KEY REFERENCES candidates(id),
 checked_at TEXT NOT NULL, thread_id TEXT NOT NULL DEFAULT '',
 external_count INTEGER NOT NULL DEFAULT 0, last_message_id TEXT NOT NULL DEFAULT ''
);


"""

TIMEOUT = (5, 12)
UA = 'PortfolioEditorialResearch/1.0 (+independent-editorial-research; single-page verification)'
BAD_PAGE_WORDS = ('buy backlinks', 'guaranteed backlinks', 'pbn service', 'link insertion pricing',
                  'high da guest posts', 'buy guest post', 'paid guest post')
BAD_HOST_WORDS = ('backlink-service', 'backlink-seller', 'pbn-network', 'link-farm')
UNSAFE_SCHEMES = {'javascript', 'file', 'ftp', 'data'}
SUFFIX_PAIRS = {'co.uk','org.uk','ac.uk','gov.uk','com.au','edu.au','com.br','co.nz','co.jp','com.cn','co.in','co.za'}
FREE_MAIL = {'gmail.com','googlemail.com','hotmail.com','outlook.com','live.com','yahoo.com','icloud.com','aol.com','proton.me','protonmail.com'}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def host(value: str) -> str:
    value = value.strip().lower()
    if not value:
        return ''
    parsed = urlsplit(value if '://' in value else 'https://' + value)
    return (parsed.hostname or '').removeprefix('www.').rstrip('.')


def reg_domain(value: str) -> str:
    h = host(value)
    p = h.split('.')
    if len(p) < 2:
        return h
    tail = '.'.join(p[-2:])
    return '.'.join(p[-3:]) if tail in SUFFIX_PAIRS and len(p) >= 3 else tail


def is_public_url(url: str, resolve: bool = False) -> bool:
    """Network-safety boundary: refuse internal IPs, service hosts and non-HTTP schemes."""
    try:
        p = urlsplit(url)
        if p.scheme not in ('https', 'http') or not p.hostname or p.username or p.password:
            return False
        if p.port not in (None, 80, 443):
            return False
        h = p.hostname.lower().rstrip('.')
        if h in ('localhost', 'metadata.google.internal') or h.endswith(('.local','.internal','.lan')):
            return False
        try:
            ip = ipaddress.ip_address(h)
            if not ip.is_global:
                return False
        except ValueError:
            if '.' not in h:
                return False
            if resolve:
                found = socket.getaddrinfo(h, p.port or (443 if p.scheme == 'https' else 80))
                if not found or not all(ipaddress.ip_address(x[4][0]).is_global for x in found):
                    return False
        return True
    except (ValueError, OSError):
        return False


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.anchor_hrefs = []
        self.anchor_rels = []
        self.mailto = []
        self.forms = []
        self.heading_parts = []
        self.in_title = False
        self.in_h = False
        self.exclude = 0
        self.title = ''
    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        if tag in ('script','style','noscript'):
            self.exclude += 1
        if tag == 'title': self.in_title = True
        if tag in ('h1','h2','h3'): self.in_h = True
        if tag == 'form':
            self.forms.append((d.get('action') or '').strip())
        if tag == 'a':
            href = (d.get('href') or '').strip()
            if href.startswith('mailto:'):
                e = href[7:].split('?')[0].strip().lower()
                if re.fullmatch(r'[a-z0-9_.+%-]+@[a-z0-9.-]+\.[a-z]{2,}',e):
                    self.mailto.append(e)
            elif href and not any(href.lower().startswith(s + ':') for s in UNSAFE_SCHEMES):
                self.anchor_hrefs.append(href)
                self.anchor_rels.append(d.get('rel',''))
    def handle_endtag(self, tag):
        if tag in ('script','style','noscript'):
            self.exclude = max(0,self.exclude - 1)
        if tag == 'title': self.in_title = False
        if tag in ('h1','h2','h3'): self.in_h = False
    def handle_data(self, data):
        if self.exclude: return
        v = data.strip()
        if not v: return
        if self.in_title: self.title += v + ' '
        if self.in_h: self.heading_parts.append(v)
        self.parts.append(v)
    @property
    def text(self): return ' '.join(self.parts)


def fetch_page(url: str, session=None) -> dict:
    """Fetch one real page with bounded checked redirects; never follow a redirect into a private network."""
    if not is_public_url(url,resolve=(session is None)):
        return {'status':0,'error':'non-public or invalid URL','title':'','text':'','links':[],'emails':[]}
    client = session or requests.Session()
    try:
        current=url
        response=None
        for _ in range(5):
            if not is_public_url(current,resolve=(session is None)):
                return {'status':0,'error':'unsafe redirect','title':'','text':'','links':[],'emails':[]}
            response = client.get(current,timeout=TIMEOUT,headers={'User-Agent':UA},allow_redirects=False)
            if response.status_code in (301,302,303,307,308):
                next_url = response.headers.get('Location','')
                if not next_url:
                    break
                current=urljoin(current,next_url)
                continue
            break
        else:
            return {'status':0,'error':'too many redirects','title':'','text':'','links':[],'emails':[]}
        final_url=current
        if not is_public_url(final_url,resolve=False):
            return {'status':0,'error':'unsafe redirect','title':'','text':'','links':[],'emails':[]}
        data = response.text[:1_400_000] if 'text/html' in response.headers.get('Content-Type','text/html') else ''
        p = PageParser()
        p.feed(data)
        links = [(urljoin(final_url,l),r) for l,r in zip(p.anchor_hrefs,p.anchor_rels) if is_public_url(urljoin(final_url,l),False)]
        return {'status':response.status_code,'error':'','title':p.title.strip() or (p.heading_parts[0] if p.heading_parts else ''),
                'text':p.text[:60_000], 'links':links, 'emails':sorted(set(p.mailto)), 'forms':p.forms, 'final_url':final_url}
    except (requests.RequestException, OSError) as exc:
        return {'status':0,'error':type(exc).__name__,'title':'','text':'','links':[],'emails':[]}


def found_existing_link(links, asset_url: str, own_domain: str):
    """Returns exact hosted link; link to a different page on owned domain is NOT target URL acceptance."""
    target = urlsplit(asset_url)
    asset_path = target.path.rstrip('/') or '/'
    for url, rel in links:
        p = urlsplit(url)
        if host(url) == host(asset_url) and (p.path.rstrip('/') or '/') == asset_path:
            return (url,rel)
    return None


class Engine:
    def __init__(self, db_path: str | Path):
        path=Path(db_path)
        path.parent.mkdir(parents=True,exist_ok=True)
        self.conn=sqlite3.connect(path)
        self.conn.row_factory=sqlite3.Row
        self.conn.executescript(SCHEMA)
        # Backward-compatible migration for databases created by v2.
        cols={r['name'] for r in self.conn.execute('PRAGMA table_info(messages)')}
        for col in ('gmail_draft_id','followup_draft_id','followup_at'):
            if col not in cols:
                self.conn.execute(f'ALTER TABLE messages ADD COLUMN {col} TEXT')
        candidate_cols={r['name'] for r in self.conn.execute('PRAGMA table_info(candidates)')}
        if 'gap_own_baseline_verified' not in candidate_cols:
            self.conn.execute('ALTER TABLE candidates ADD COLUMN gap_own_baseline_verified INTEGER NOT NULL DEFAULT 0')
        self.conn.commit()

    def log(self, kind: str, detail: dict | str, candidate_id=None, provider_id=''):
        payload=json.dumps(detail,sort_keys=True) if isinstance(detail,dict) else str(detail)
        self.conn.execute('INSERT INTO activity(time_utc,type,candidate_id,provider_id,detail) VALUES(?,?,?,?,?)',
                          (utc_now(),kind,candidate_id,provider_id,payload))
        self.conn.commit()

    def suppress(self, identity: str, reason: str, source: str):
        normalized=identity.lower().strip()
        if '@' not in normalized: normalized=reg_domain(normalized)
        if not normalized: return
        self.conn.execute('INSERT INTO suppression(identity,reason,source,created_at) VALUES(?,?,?,?) ON CONFLICT(identity) DO UPDATE SET reason=excluded.reason,source=excluded.source',
                          (normalized,reason,source,utc_now()))
        self.conn.commit()

    def is_suppressed(self, contact: str = '', publisher: str = '') -> bool:
        identities=[contact.lower().strip(),reg_domain(publisher),reg_domain(contact.split('@')[-1]) if '@' in contact else '']
        identities=[x for x in identities if x]
        if not identities: return False
        q=','.join('?' for _ in identities)
        return self.conn.execute('SELECT 1 FROM suppression WHERE identity IN ('+q+')',identities).fetchone() is not None

    def add_candidate(self, *, site, source_url, asset_url, kind='resource', title='', competitor_names=(),
                      spam_score=None, traffic_monthly=None, domain_rank=None, nofollow_share=None, 
                      contact_email='', contact_source_url='', editorial_policy_url='', editorial_evidence='') -> int:
        if not is_public_url(source_url) or not is_public_url(asset_url): raise ValueError('Public source and asset URL required')
        s=reg_domain(site)
        pub=reg_domain(source_url)
        if not s or not pub or s==pub: raise ValueError('Source publisher must be external to your site')
        unique_key=hashlib.sha256(f'{s}|{urlsplit(source_url).path.rstrip("/")}|{pub}|{urlsplit(asset_url).path.rstrip("/")}'.encode()).hexdigest()
        args=(s,source_url,pub,asset_url,kind,title,editorial_evidence,editorial_policy_url,
              contact_email.strip().lower(),contact_source_url,
              spam_score,traffic_monthly,domain_rank,nofollow_share,len(set(competitor_names)),json.dumps(sorted(set(competitor_names))),unique_key)
        self.conn.execute('''INSERT INTO candidates(site,source_url,publisher_domain,asset_url,kind,title,editorial_evidence,
          editorial_policy_url,contact_email,contact_source_url,spam_score,traffic_monthly,domain_rank,nofollow_share,
          competitor_count,competitor_names,unique_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(unique_key) DO UPDATE SET
          spam_score=COALESCE(excluded.spam_score,candidates.spam_score),
          traffic_monthly=COALESCE(excluded.traffic_monthly,candidates.traffic_monthly),
          domain_rank=COALESCE(excluded.domain_rank,candidates.domain_rank),
          competitor_count=MAX(excluded.competitor_count,candidates.competitor_count),
          competitor_names=CASE WHEN excluded.competitor_count>candidates.competitor_count THEN excluded.competitor_names ELSE candidates.competitor_names END,
          editorial_evidence=CASE WHEN excluded.editorial_evidence!='' THEN excluded.editorial_evidence ELSE candidates.editorial_evidence END,
          editorial_policy_url=CASE WHEN excluded.editorial_policy_url!='' THEN excluded.editorial_policy_url ELSE candidates.editorial_policy_url END,
          contact_email=CASE WHEN excluded.contact_email!='' THEN excluded.contact_email ELSE candidates.contact_email END
          ''', args)
        self.conn.commit()
        return self.conn.execute('SELECT id FROM candidates WHERE unique_key=?',(unique_key,)).fetchone()['id']

    def publisher_already_in_pipeline(self,publisher_domain:str,exclude_candidate_id:int|None=None)->bool:
        """One publisher, ONE active portfolio proposal across all owned sites.

        Domain-level guard prevents parallel pitching to different staff in one newsroom.
        """
        domain=reg_domain(publisher_domain)
        if not domain:return False
        rows=self.conn.execute("""SELECT c.id,c.status,m.status AS mail_status
            FROM candidates c JOIN messages m ON c.id=m.candidate_id
            WHERE c.publisher_domain=? AND m.status IN
              ('draft','draft_uncertain','sent','needs_reconciliation')""",(domain,)).fetchall()
        return any(row['id']!=exclude_candidate_id for row in rows)

    def record_search(self,site:str,query:str,result_count:int,inserted_count:int,error:str=''):
        key=hashlib.sha256(query.lower().strip().encode()).hexdigest()
        self.conn.execute('''INSERT INTO search_history(site,query,query_key,attempted_at,result_count,inserted_count,error)
                VALUES(?,?,?,?,?,?,?)''',
                (reg_domain(site),query,key,utc_now(),result_count,inserted_count,error))
        self.conn.commit()

    def queried_recently(self,site:str,query:str,days:int=14)->bool:
        key=hashlib.sha256(query.lower().strip().encode()).hexdigest()
        cutoff=(datetime.now(timezone.utc)-timedelta(days=days)).isoformat()
        return self.conn.execute('SELECT 1 FROM search_history WHERE site=? AND query_key=? AND attempted_at>=? LIMIT 1',
                         (reg_domain(site),key,cutoff)).fetchone() is not None

    def load_suppressions(self, path: str | Path):
        count=0
        with open(path,encoding='utf-8-sig',newline='') as f:
            for row in csv.DictReader(f):
                if not row.get('identity') or not row.get('reason'):continue
                identity=row['identity'].strip().lower()
                source=row.get('source','imported suppression file')
                self.suppress(identity,row['reason'],source)
                count+=1
                # A new editor at the same business is not a new publisher. Exempt free-mail
                # providers: blocking gmail.com would accidentally block unrelated editors.
                if '@' in identity:
                    business_domain=reg_domain(identity.rsplit('@',1)[-1])
                    if business_domain and business_domain not in FREE_MAIL:
                        self.suppress(business_domain,'Organization previously contacted (inferred from email domain)',source)
        self.log('suppression_import',{'rows':count,'file':str(path)})
        return count

    def load_footprints(self, path: str | Path):
        count=0
        with open(path,encoding='utf-8-sig',newline='') as f:
            for row in csv.DictReader(f):
                if not row.get('source_url') or not row.get('asset_url') or not row.get('site'):
                    continue
                self.add_candidate(**{k:v for k,v in row.items() if k in (
                    'site','source_url','asset_url','kind','title','contact_email','contact_source_url',
                    'editorial_policy_url','editorial_evidence') and v is not None})
                count+=1
        self.log('import_footprints',{'rows_imported':count,'file':str(path)})
        return count

    def load_backlink_gap(self, path: str | Path | list[str | Path], owned_domain: str,
                          competitor_domains: list[str], asset_url: str, own_baseline_verified=False):
        """Import one or multiple real CSV exports, including common Ahrefs-style column names.

        At least two distinct *declared* competitor destinations must occur on an
        external referring publisher. All known links from that publisher to the
        owned domain must be included in the input to exclude existing referrers.
        Metrics remain NULL whenever the export does not supply them.
        Unless own_baseline_verified=True, labels remain POTENTIAL gaps; a partial
        owned backlink CSV cannot establish non-existence of owned backlinks.
        """
        owned=reg_domain(owned_domain)
        competitors={reg_domain(c) for c in competitor_domains}
        competitors.discard(owned)
        if not owned or len(competitors)<2:
            raise ValueError('At least two distinct competitor domains are required')
        files=path if isinstance(path,(list,tuple)) else [path]
        groups={}; own_refs=set(); read=0; malformed=0; duplicate=0; seen=set()
        def get(r,*aliases):
            for alias in aliases:
                val=r.get(alias)
                if val is not None and str(val).strip():return str(val).strip()
            return ''
        for file in files:
            with open(file,encoding='utf-8-sig',newline='') as f:
                reader=csv.DictReader(f)
                if not reader.fieldnames:continue
                for row in reader:
                    read+=1
                    cleaned={re.sub(r'[^a-z0-9]+','_',str(k).lower()).strip('_'):v for k,v in row.items() if k}
                    src=get(cleaned,'source_url','referring_page_url','referring_url','referring_page',
                            'referring_page','backlink_url','page_url','url','from_url')
                    dst=get(cleaned,'target_domain','target_url','target_page_url','target',
                            'linked_domain','linked_to','link_to')
                    if not is_public_url(src) or not dst:
                        malformed+=1;continue
                    pub=reg_domain(src); target=reg_domain(dst)
                    if not pub or pub==owned:continue
                    key=(pub,src.rstrip('/'),target)
                    if key in seen:
                        duplicate+=1;continue
                    seen.add(key)
                    if target==owned:own_refs.add(pub)
                    if target not in competitors:continue
                    agg=groups.setdefault(pub,{'sources':[],'competitors':set(),
                                                'spam':[],'traffic':[],'rank':[],'nofollow':[]})
                    agg['sources'].append(src)
                    agg['competitors'].add(target)
                    for name,aliases in [
                         ('spam',('spam_score','spam','spam_score_percent')),
                         ('traffic',('monthly_traffic','organic_traffic','traffic','page_traffic','referring_page_traffic')),
                         ('rank',('domain_rank','domain_rating','dr','authority_score'))]:
                        raw=get(cleaned,*aliases)
                        if raw:
                            try: agg[name].append(float(raw.replace(',','').replace('%','')))
                            except ValueError:pass
                    nf=get(cleaned,'nofollow','link_attribute','link_type','link_rel').lower()
                    if nf:
                        agg['nofollow'].append('nofollow' in nf or nf in ('1','true','yes'))
        accepted=0; skipped=0
        for pub,agg in groups.items():
            if pub in own_refs or len(agg['competitors'])<2:
                skipped+=1;continue
            source=next((u for u in agg['sources'] if is_public_url(u)),None)
            if source is None:continue
            cid=self.add_candidate(site=owned,source_url=source,asset_url=asset_url,kind='competitor_gap',
                   competitor_names=sorted(agg['competitors']),spam_score=max(agg['spam']) if agg['spam'] else None,
                   traffic_monthly=min(agg['traffic']) if agg['traffic'] else None,
                   domain_rank=max(agg['rank']) if agg['rank'] else None,
                   nofollow_share=(sum(agg['nofollow'])/len(agg['nofollow'])) if agg['nofollow'] else None)
            if own_baseline_verified:
                self.conn.execute('UPDATE candidates SET gap_own_baseline_verified=1 WHERE id=?',(cid,))
            accepted+=1
        self.log('backlink_gap_import',{'source_rows':read,'invalid':malformed,'duplicates':duplicate,
                  'gap_domains':accepted,'excluded':skipped,'owned_domain':owned,'files':len(files),
                  'owned_baseline_verified':bool(own_baseline_verified),'owned_referrers_seen':len(own_refs)})
        return {'source_rows':read,'invalid':malformed,'duplicates':duplicate,
                'gap_domains':accepted,'excluded':skipped,'files':len(files),
                'owned_baseline_verified':bool(own_baseline_verified),
                'gap_confidence':'referring-domain gap from complete verified owned baseline' if own_baseline_verified else 'POTENTIAL gap only; owned-domain backlink coverage unverified'}

    def verify(self, candidate_id: int, session=None, check_contact: bool = True):
        c=self.conn.execute('SELECT * FROM candidates WHERE id=?',(candidate_id,)).fetchone()
        if c is None: raise KeyError(candidate_id)
        if self.is_suppressed(c['contact_email'],c['publisher_domain']):
            self.conn.execute("UPDATE candidates SET excluded_reason='Suppressed publisher/contact',status='rejected' WHERE id=?",(candidate_id,));self.conn.commit();return {'status':'rejected','reason':'suppressed'}
        if self.publisher_already_in_pipeline(c['publisher_domain'],exclude_candidate_id=candidate_id):
            self.conn.execute("UPDATE candidates SET excluded_reason='Publisher already in portfolio pipeline',status='rejected' WHERE id=?",(candidate_id,));self.conn.commit();return {'status':'rejected','reason':'publisher duplicate across sites'}
        page=fetch_page(c['source_url'],session)
        asset=fetch_page(c['asset_url'],session)
        source_ok=200<=page['status']<300
        asset_ok=200<=asset['status']<300
        existing=found_existing_link(page['links'],c['asset_url'],c['site']) if source_ok else None
        evidence=(c['editorial_evidence'] or '').strip()
        text=page['text'].lower()
        invitation_phrases=('write for us','submit a resource','send a pitch',
                            'contributor guidelines','submit a tool','pitch a story',
                            'editorial submissions','accept contributions','submit an article',
                            'send your story idea','suggest a resource','submit your tool',
                            'become a contributor','editorial pitches','share a resource')
        # Only official website copy counts. Imported editorial_evidence is a hint, NOT proof.
        source_policy=source_ok and any(x in text for x in invitation_phrases)
        policy_texts=[text] if source_policy else []
        source_dom=c['publisher_domain']
        # Automatic publisher-route discovery fixes v3's main workflow failure:
        # search candidates arrive WITHOUT a pre-filled email. Never guess one.
        recommended=[]
        for link,rel in page['links']:
            if reg_domain(link)!=source_dom:continue
            path=(urlsplit(link).path or '/').lower()
            if any(word in path for word in ('write-for','contributors','submission','submit','pitch','contact','editorial','suggest')):
                recommended.append(link)
        policy_url=c['editorial_policy_url']
        if policy_url and reg_domain(policy_url)!=source_dom:policy_url=''
        routes=[policy_url,c['contact_source_url']]+recommended
        checked_routes=[];possible_forms=[];published_emails=set(page['emails'])
        visible_pattern=r'\b[a-zA-Z0-9_.+%-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}\b'
        published_emails.update(email.lower() for email in re.findall(visible_pattern,page['text']))
        if source_policy:
            possible_forms.append(page['final_url'] if page.get('forms') else '')
        max_contact_pages=3
        for route in routes:
            if not route or not is_public_url(route) or reg_domain(route)!=source_dom:continue
            if route in checked_routes or route==c['source_url']:continue
            if len(checked_routes)>=max_contact_pages:break
            checked_routes.append(route)
            result=fetch_page(route,session)
            if not 200<=result['status']<300:continue
            route_text=result['text'].lower()
            invited=any(x in route_text for x in invitation_phrases)
            if invited:
                source_policy=True;policy_texts.append(route_text)
                if result.get('forms') or any(word in urlsplit(route).path.lower() for word in ('submit','contact','pitch','suggest')):
                    possible_forms.append(route)
                if not policy_url:policy_url=route
            if check_contact:
                published_emails.update(result['emails'])
                published_emails.update(email.lower() for email in re.findall(visible_pattern,result['text']))
        # An explicitly provided mailbox must appear verbatim on the publisher's pages.
        provided_email=(c['contact_email'] or '').lower().strip()
        if provided_email:
            official_email=provided_email if provided_email in published_emails else ''
        elif source_policy:
            # Address must be literally published. Prefer editor/submission mailboxes;
            # never infer staff names, and skip support, copyright, legal and personal mail.
            def rank_email(email):
                local=email.split('@',1)[0]
                official=reg_domain(email.split('@',1)[1])==source_dom
                editorial=any(word in local for word in ('editor','pitch','submission','contribut','write','resource','press'))
                invalid=any(word in local for word in ('support','billing','legal','privacy','copyright','abuse','noreply','no-reply'))
                return (int(official and editorial and not invalid), int(official and not invalid))
            eligible=[email for email in published_emails if rank_email(email)[0] and
                      reg_domain(email.split('@',1)[1])==source_dom]
            official_email=sorted(eligible,key=rank_email,reverse=True)[0] if eligible else ''
        else:
            official_email=''
        # Form-only publications are research/submission candidates, not failed outreach.
        if source_policy and not official_email:
            for form in dict.fromkeys(x for x in possible_forms if x):
                if reg_domain(form)==source_dom:
                    self.conn.execute('''INSERT INTO submissions(site,publisher,form_url,asset_url,eligibility,
                      needs_login,needs_captcha,rights_confirmed,status,source_url,created_at)
                      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(site,form_url,asset_url) DO NOTHING''',
                      (c['site'],source_dom,form,c['asset_url'],
                       'Editorial invitation found; specific form requirements still need verification',
                       0,0,0,'researched',policy_url or c['source_url'],utc_now()))
            self.conn.commit()
        policy=source_policy
        contact_url=(c['contact_source_url'] if c['contact_source_url'] and reg_domain(c['contact_source_url'])==source_dom else
                     (checked_routes[0] if checked_routes else c['source_url']))
        live_competitors=({reg_domain(u) for u,rel in page['links']} & set(json.loads(c['competitor_names']))) if c['kind']=='competitor_gap' else set()
        # Never claim a contact is operational without a successful delivery or reply.
        excluded=''
        if not source_ok: excluded='Source URL failed live fetch'
        elif not asset_ok: excluded='Asset URL failed live fetch'
        elif existing: excluded='Already links to exact asset'
        elif c['kind']=='competitor_gap' and len(live_competitors)<1: excluded='No imported competitor backlink survives live page check'
        elif c['spam_score'] is not None and c['spam_score']>30:excluded='Spam score above 30'
        elif c['traffic_monthly'] is not None and c['traffic_monthly']<300:excluded='Estimated monthly traffic below 300'
        elif c['nofollow_share'] is not None and c['nofollow_share']>.70:excluded='Nofollow share above 70%'
        elif any(w in (page['title']+' '+text[:12000]).lower() for w in BAD_PAGE_WORDS):excluded='Link seller / paid placement signals'
        elif any(w in c['publisher_domain'] for w in BAD_HOST_WORDS):excluded='Suspicious link-service hostname'
        # A score is editor fit, not proprietary third-party authority.
        score=0
        if source_ok:score+=18
        if asset_ok:score+=15
        if page['text']:score+=5
        if c['kind']=='competitor_gap' and c['competitor_count']>=2:score+=20
        elif policy:score+=20
        elif c['kind'] in ('roundup','resource','interview','guest_post'):score+=12
        if c['traffic_monthly'] is not None:
            if c['traffic_monthly']>=300:score+=10
            else:score-=8
        if c['spam_score'] is not None and c['spam_score']<=10:score+=10
        elif c['spam_score'] is not None and c['spam_score']<=30:score+=5
        if official_email:score+=10
        if c['contact_source_url'] and official_email:score+=5
        if policy and official_email:score+=5
        if c['kind'] in ('roundup','resource','interview'):score+=8
        # Require direct topical overlap; a generic 'write for us' footer is not a prospect.
        stop_words={'the','and','best','free','for','with','how','your','our','this','that','from','about',
                    'guide','tools','tool','page','online','blog','article','methodology','what','when'}
        asset_terms={w for w in re.findall(r'[a-z]{4,}',asset['title'].lower()) if w not in stop_words}
        visible_source=(page['title']+' '+page['text'][:20000]).lower()
        overlap=sorted(w for w in asset_terms if re.search(r'\b'+re.escape(w)+r'\b',visible_source))
        if overlap: score+=8
        score=max(0,min(100,score))
        # Host errors, rate limits, and access denials are not proof a publisher is dead.
        transient=(page['status'] in (0,403,408,429) or page['status']>=500 or
                   asset['status'] in (0,403,408,429) or asset['status']>=500)
        status=('retry' if excluded and transient else 'rejected') if excluded else (
                'verified_ready' if official_email and policy and score>=70 and bool(overlap) else 'research')
        self.conn.execute('''UPDATE candidates SET title=?,source_title=?,source_status=?,asset_status=?,
              source_checked_at=?,asset_checked_at=?,live_already_links=?,explicit_invitation=?,
              contact_email=?,contact_source_url=?,editorial_policy_url=?,score=?,excluded_reason=?,status=? WHERE id=?''',
              (c['title'] or page['title'],page['title'],page['status'],asset['status'],utc_now(),utc_now(),
               int(bool(existing)),int(policy),official_email,contact_url if official_email else '',
               policy_url or '',score,excluded,status,candidate_id))
        self.conn.commit()
        self.log('verified',{'status':status,'score':score,'source_http':page['status'],'asset_http':asset['status'],
              'published_contact_confirmed':bool(official_email),'policy':bool(policy),'topic_overlap':overlap,'live_competitors':sorted(live_competitors),'excluded':excluded},candidate_id)
        return {'status':status,'score':score,'excluded':excluded,'contact_email':official_email,
                'editorial_invitation':bool(policy),'already_links':bool(existing)}

    def prepare_draft(self, candidate_id, config: dict):
        c=self.conn.execute('SELECT * FROM candidates WHERE id=?',(candidate_id,)).fetchone()
        if c is None:raise KeyError(candidate_id)
        if c['status']!='verified_ready' or not c['contact_email'] or not c['explicit_invitation']:
            raise ValueError('Draft generation requires a verified editorial invitation and a published official email')
        if self.is_suppressed(c['contact_email'],c['publisher_domain']):raise ValueError('Suppressed recipient')
        if self.publisher_already_in_pipeline(c['publisher_domain'],exclude_candidate_id=candidate_id):
            raise ValueError('Publisher already has a portfolio-wide draft/pitch; no second site pitch')
        intro=config.get('editorial_idea','').strip()
        if not intro or not config.get('sender_name') or not config.get('identity'):
            raise ValueError('Unique editorial idea, real sender and publisher identity are mandatory')
        if len(intro)>240:raise ValueError('Editorial idea must be specific and concise (<240 chars)')
        subject=f"For {c['source_title'][:24].rstrip()}: a practical idea"
        subject=subject[:53].rstrip()+' [BLF]' 
        content=(
          f"Hello editorial team,\n\n"
          f"I read your page, “{c['source_title'][:90]}”.\n\n"
          f"One original idea for your audience: {intro}\n\n"
          f"For context, I publish {config['identity']}. This relevant page describes our approach: {c['asset_url']}\n\n"
          f"Would you consider the idea through your normal editorial process? Our site may carry disclosed affiliate links; editorial decisions are entirely yours.\n\n"
          f"Best,\n{config['sender_name']}\n{config['identity']}\n\n"
          f"If it's not useful, no reply or follow-up is necessary."
        )
        if len(content.split())>120:
            raise ValueError('Pitch too long: max 120 words from uploaded Backlink Finder skill')
        self.conn.execute('''INSERT INTO messages(candidate_id,to_address,subject,body,created_at)
          VALUES(?,?,?,?,?) ON CONFLICT(candidate_id) DO NOTHING''',
          (candidate_id,c['contact_email'],subject,content,utc_now()))
        self.conn.commit()
        self.log('draft_prepared',{'recipient':c['contact_email'],'subject':subject},candidate_id)
        return dict(self.conn.execute('SELECT * FROM messages WHERE candidate_id=?',(candidate_id,)).fetchone())

    def mark_gmail_draft(self,candidate_id:int, draft_id:str):
        if not draft_id:raise ValueError('Real Gmail draft ID required')
        self.conn.execute("UPDATE messages SET gmail_draft_id=? WHERE candidate_id=? AND status='draft' AND gmail_draft_id IS NULL",(draft_id,candidate_id))
        if self.conn.execute('SELECT changes() AS n').fetchone()['n']!=1:
            self.conn.rollback();raise ValueError('Remote draft already exists or candidate not eligible')
        self.conn.commit();self.log('gmail_draft_created',{'draft_id':draft_id},candidate_id,provider_id=draft_id)

    def mark_followup_draft(self,candidate_id:int, draft_id:str):
        if not draft_id:raise ValueError('Real follow-up Gmail draft ID required')
        self.conn.execute("UPDATE messages SET followup_draft_id=?,followup_at=? WHERE candidate_id=? AND status='sent' AND followup_draft_id IS NULL",(draft_id,utc_now(),candidate_id))
        if self.conn.execute('SELECT changes() AS n').fetchone()['n']!=1:
            self.conn.rollback();raise ValueError('Follow-up draft already exists or original not sent')
        self.conn.commit();self.log('gmail_followup_draft',{'draft_id':draft_id},candidate_id,provider_id=draft_id)

    def sent_count_since(self, cutoff_utc: str) -> int:
        return self.conn.execute("SELECT COUNT(*) AS n FROM messages WHERE status='sent' AND sent_at>=?",(cutoff_utc,)).fetchone()['n']

    def mark_sent(self,candidate_id:int,gmail_id:str):
        if not gmail_id:raise ValueError('Gmail message id needed; never infer send from API attempt')
        self.conn.execute("UPDATE messages SET status='sent',gmail_id=?,sent_at=? WHERE candidate_id=? AND status='draft'",
                          (gmail_id,utc_now(),candidate_id))
        if self.conn.execute('SELECT changes() AS n').fetchone()['n']!=1:
            self.conn.rollback();raise ValueError('Message was not an unsent draft; suppress duplicate')
        self.conn.execute("UPDATE candidates SET status='sent' WHERE id=?",(candidate_id,))
        # Other owned sites must not immediately contact the same publisher as a 'new prospect'.
        self.conn.execute("UPDATE candidates SET status='rejected',excluded_reason='Publisher already contacted by portfolio' WHERE publisher_domain=(SELECT publisher_domain FROM candidates WHERE id=?) AND id<>? AND status IN ('found','research','verified_ready')",(candidate_id,candidate_id))
        self.conn.commit();self.log('gmail_sent',{'gmail_id':gmail_id},candidate_id,provider_id=gmail_id)

    def verify_placement(self, candidate_id:int, session=None, placement_url: str | None=None):
        c=self.conn.execute('SELECT * FROM candidates WHERE id=?',(candidate_id,)).fetchone()
        if c is None:raise KeyError(candidate_id)
        recorded=self.conn.execute('SELECT placement_url FROM verified_links WHERE candidate_id=?',(candidate_id,)).fetchone()
        url=placement_url or (recorded['placement_url'] if recorded else c['source_url'])
        if not is_public_url(url) or reg_domain(url)!=c['publisher_domain']:
            raise ValueError('Placement URL must be public and belong to the verified publisher')
        page=fetch_page(url,session)
        if page['status']==0 or page['status']>=500:
            self.log('link_check_unavailable',{'placement_url':url,'http':page['status'],'error':page.get('error','')},candidate_id)
            return {'live':None,'status':'check_unavailable','http':page['status'],'placement_url':url}
        found=found_existing_link(page['links'],c['asset_url'],c['site']) if page['status']==200 else None
        if found:
            self.conn.execute('''INSERT INTO verified_links(candidate_id,placement_url,target_url,rel,observed_at) VALUES(?,?,?,?,?)
                  ON CONFLICT(candidate_id) DO UPDATE SET placement_url=excluded.placement_url,target_url=excluded.target_url,rel=excluded.rel,observed_at=excluded.observed_at''',
                  (candidate_id,url,found[0],found[1],utc_now()))
            self.conn.execute("UPDATE candidates SET status='link_live' WHERE id=?",(candidate_id,))
        else:
            self.conn.execute('DELETE FROM verified_links WHERE candidate_id=?',(candidate_id,))
            if c['status']=='link_live':self.conn.execute("UPDATE candidates SET status='link_missing' WHERE id=?",(candidate_id,))
        self.conn.commit()
        self.log('link_check',{'live':bool(found),'http':page['status'],'placement_url':url,'rel':found[1] if found else ''},candidate_id)
        return {'live':bool(found),'target_url':found[0] if found else None,'rel':found[1] if found else None,'http':page['status'],'placement_url':url}

    def record_outcome(self,candidate_id:int,outcome:str,evidence:str):
        allowed={'reply_received','reply_positive','reply_negative','accepted','opt_out','permanent_failure','connection_timeout'}
        if outcome not in allowed:raise ValueError('Unknown outcome type; link_live requires independent page verification')
        if not evidence or len(evidence.strip())<8:raise ValueError('Outcomes require an external Gmail/receipt identifier')
        c=self.conn.execute('SELECT * FROM candidates WHERE id=?',(candidate_id,)).fetchone()
        if c is None:raise KeyError(candidate_id)
        self.conn.execute('''INSERT OR IGNORE INTO outcomes(candidate_id,outcome,evidence,time_utc) VALUES(?,?,?,?)''',
                          (candidate_id,outcome,evidence.strip(),utc_now()))
        if outcome=='opt_out':self.suppress(c['contact_email'] or c['publisher_domain'],'Recipient opted out',evidence)
        if outcome in ('permanent_failure','connection_timeout'):
            self.suppress(c['contact_email'] or c['publisher_domain'],outcome,evidence)
        self.conn.commit()
        self.log('editorial_outcome',{'outcome':outcome,'evidence':evidence},candidate_id)

    def learning_evidence(self):
        """Learn only from actual confirmed outcomes; small samples have NO weighting effect."""
        query='''SELECT c.kind,COUNT(DISTINCT CASE WHEN m.status IN ('sent','needs_reconciliation') THEN c.id END) AS contacted,
             COUNT(DISTINCT CASE WHEN o.outcome='reply_positive' THEN c.id END) AS positive,
             COUNT(DISTINCT CASE WHEN o.outcome='accepted' THEN c.id END) AS accepted,
             COUNT(DISTINCT l.candidate_id) AS live
             FROM candidates c LEFT JOIN messages m ON m.candidate_id=c.id
             LEFT JOIN outcomes o ON o.candidate_id=c.id LEFT JOIN verified_links l ON l.candidate_id=c.id
             GROUP BY c.kind'''
        result={}
        for row in self.conn.execute(query):
            contacted=int(row['contacted'] or 0); wins=int(row['positive'] or 0)
            # Bounded empirical Bayes: no strategy change from fewer than eight pitches.
            correction=round(20*((wins+1)/(contacted+4)-0.25)) if contacted>=8 else 0
            correction=max(-8,min(8,correction))
            result[row['kind']]={'contacted':contacted,'positive_replies':wins,
                 'accepted':int(row['accepted'] or 0),'live_links':int(row['live'] or 0),
                 'bounded_score_adjustment':correction}
        return result

    def report(self):
        count=lambda table,where='1=1':self.conn.execute(f'SELECT COUNT(*) n FROM {table} WHERE {where}').fetchone()['n']
        return {'prospects':count('candidates'),'qualified':count('candidates',"status='verified_ready'"),
                'rejected':count('candidates',"status='rejected'"),'drafts':count('messages',"status='draft'"),
                'sent':count('messages',"status='sent'"),'links_live':count('verified_links'),
                'suppressed':count('suppression'),
                'sources_checked':count('candidates', 'source_checked_at IS NOT NULL'),
                'form_opportunities':count('submissions'),
                'forms_confirmed':count('submissions',"status='submitted' AND receipt IS NOT NULL"),
                'emails_awaiting_reconciliation':count('messages',"status IN ('needs_reconciliation','draft_uncertain')")}

    def get_candidates(self,limit=100):
        return [dict(row) for row in self.conn.execute('SELECT * FROM candidates ORDER BY score DESC NULLS LAST, id LIMIT ?', (limit,))]


def render_html_report(engine: Engine, output_path: str | Path, site='Portfolio', portfolio_config=None):
    report=engine.report()
    prospects=engine.get_candidates(60)
    top=report['qualified']
    cards=[]
    website_table=''
    if portfolio_config:
        from .portfolio import site_progress
        rows=site_progress(engine,portfolio_config)
        tr=''.join('<tr><td><strong>'+html.escape(r['domain'])+'</strong></td>'+
                    '<td>'+str(r['assets_verified'])+'/'+str(r['assets_configured'])+'</td>'+
                    '<td>'+str(r['candidates'])+'</td><td>'+str(r['eligible'])+'</td>'+
                    '<td>'+str(r['sent'])+'</td><td>'+str(r['live_links'])+'</td></tr>' for r in rows)
        website_table=('<h2>Portfolio coverage — verified outcomes by website</h2>'+
            '<p class="muted">Configured assets are not automatically evidence of working pages. Sent messages are not proof of delivery.</p>'+
            '<div class="table-wrap"><table><thead><tr><th>Website</th><th>Assets checked live</th><th>Prospects</th><th>Qualified</th><th>Gmail sent</th><th>Live links</th></tr></thead><tbody>'+tr+'</tbody></table></div>')
    rejected_counts={}
    rejected_details=[]
    for p in engine.get_candidates(100000):
        if p['excluded_reason']:
            reason=p['excluded_reason']
            rejected_counts[reason]=rejected_counts.get(reason,0)+1
            if len(rejected_details)<5:rejected_details.append((p['publisher_domain'],reason))
    drop_details=''.join(f'<div class="reject"><b>{html.escape(reason)}</b><span>{count} excluded</span></div>' for reason,count in sorted(rejected_counts.items(),key=lambda x:-x[1]))
    example_rejects=''.join(f'<p class="muted"><code>{html.escape(domain)}</code> — {html.escape(reason)}</p>' for domain,reason in rejected_details)
    for p in prospects:
        bad=p['excluded_reason']
        status='rejected' if bad else p['status']
        color='bad' if bad else 'good' if status in ('verified_ready','link_live') else 'warn'
        val=lambda key,fmt='{:g}':fmt.format(p[key]) if p[key] is not None else 'no data'
        safe=lambda s:html.escape(str(s or ''))
        emails=safe(p['contact_email']) or 'no verified email'
        cards.append(f'''<article class="card"><div class="top"><strong>{safe(p['publisher_domain'])}</strong><span class="pill {color}">{safe(status)}</span></div>
 <a href="{safe(p['source_url'])}" rel="noopener">{safe(p['source_title'] or p['title'] or 'View source page')}</a>
 <p class="meta">{safe(p['kind']+' — potential overlap; owned backlink coverage not verified' if p['kind']=='competitor_gap' and not p['gap_own_baseline_verified'] else p['kind'])} · editorial fit {p['score'] if p['score'] is not None else 'no data'}/100</p>
 <div class="stats"><span>Traffic/mo <b>{val('traffic_monthly')}</b></span><span>Spam <b>{val('spam_score')}</b></span><span>Competitors <b>{p['competitor_count']}</b></span><span>Nofollow <b>{val('nofollow_share','{:.1%}')}</b></span></div>
 <p><b>Matched page:</b> <a href="{safe(p['asset_url'])}">{safe(p['asset_url'])}</a></p>
 <p><b>Editorial route:</b> {emails}</p><p class="muted">{safe(bad or p['editorial_evidence'] or 'Editorial suitability requires verification')}</p></article>''')
    # Display actual metered DataForSEO usage with explicit local-only scope.
    # Reading this budget is entirely offline and never triggers an API call.
    dfs_panel=''
    try:
        from .dataforseo import DataForSEO
        d=DataForSEO(engine).status()
        gaps=engine.conn.execute('SELECT COUNT(*) n FROM dfs_gap_domains').fetchone()['n']
        m=lambda value:html.escape(str(value))
        blocked=('Costed API disabled' if not d['paid_enabled'] else
                 'No credentials' if not d['configured'] else
                 'Spend anomaly — investigate' if d['unresolved_external_spend_alerts'] else
                 'Paid source configured — live calls subject to caps')
        dfs_panel=(
            '<h2>DataForSEO spend monitor</h2>'
            '<p class="muted">Real spending observed by THIS local worker only. '
            'Other DataForSEO integrations can spend outside these limits; account-level limits still matter.</p>'
            '<section class="funnel">'
            '<div class="metric"><strong>$'+m(d['day_spend_or_reserved_usd'])+'</strong><span>Spent or reserved today / $'+m(d['day_ceiling_usd'])+' ceiling</span></div>'
            '<div class="metric"><strong>$'+m(d['month_spend_or_reserved_usd'])+'</strong><span>Spent or reserved this month / $'+m(d['month_ceiling_usd'])+' ceiling</span></div>'
            '<div class="metric"><strong>'+m(d['paid_requests_today'])+'</strong><span>Paid API requests today</span></div>'
            '<div class="metric"><strong>'+m(d['cache_rows'])+'</strong><span>Cached data responses</span></div>'
            '<div class="metric"><strong>'+m(gaps)+'</strong><span>DataForSEO overlap domains (unverified leads)</span></div>'
            '</section><p class="muted">'+m(blocked)+' · Unresolved unknown charges: '
            +m(d['unreconciled_paid_requests'])+' · External spending alarms: '
            +m(d['unresolved_external_spend_alerts'])+'</p>'
        )
    except Exception as exc:
        dfs_panel='<p class="muted">DataForSEO metrics could not be read locally: '+html.escape(type(exc).__name__)+'</p>'
    safe=lambda s:html.escape(str(s))
    html_text=f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
 <title>Backlink Finder · {safe(site)}</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;700&family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@500&display=swap">
 <style>:root{{--bg:#f3f5f9;--surface:#fff;--fg:#141a26;--muted:#5b6578;--line:#dce1ea;--link:#1f4fe0;--link-soft:#e4ebfd;--good:#137a4b;--good-soft:#e1f3ea;--warn:#9a6300;--warn-soft:#fbf0d9;--bad:#b4322a;--bad-soft:#fbe5e3;--display:'Bricolage Grotesque',system-ui,sans-serif;--body:'Instrument Sans',system-ui,sans-serif;--mono:'JetBrains Mono',monospace}}@media(prefers-color-scheme:dark){{:root{{--bg:#0e1320;--surface:#161d2e;--fg:#e6eaf2;--muted:#98a2b6;--line:#2a3348;--link:#7c9bff;--link-soft:#1e2a4d;--good:#5fd39a;--good-soft:#15342a;--warn:#f0b952;--warn-soft:#3a2e14;--bad:#ff8a80;--bad-soft:#3a1c1c}}}}*{{box-sizing:border-box}}body{{background:var(--bg);color:var(--fg);font:16px var(--body);margin:0}}main{{max-width:1150px;margin:auto;padding:36px 18px 80px}}h1{{font:700 clamp(2rem,4vw,3.4rem) var(--display);line-height:1.13;margin:12px 0}}h2{{font:700 1.6rem var(--display);margin-top:40px}}a{{color:var(--link);overflow-wrap:anywhere}}.eyebrow{{font:12px var(--mono);letter-spacing:.08em;color:var(--muted)}}.muted,.meta{{color:var(--muted)}}.funnel{{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:26px 0}}.metric,.card{{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:20px}}.metric strong{{display:block;font:700 26px var(--mono)}}.metric span{{color:var(--muted);font-size:13px}}.cards{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}}.top{{display:flex;gap:10px;justify-content:space-between;align-items:start;margin-bottom:15px}}.top strong{{font:700 21px var(--display)}}.pill{{padding:6px 10px;font:12px var(--mono);border-radius:18px;white-space:nowrap}}.pill.good{{background:var(--good-soft);color:var(--good)}}.pill.warn{{background:var(--warn-soft);color:var(--warn)}}.pill.bad{{background:var(--bad-soft);color:var(--bad)}}.stats{{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:20px 0}}.stats span{{background:var(--bg);padding:10px;border-radius:7px;font-size:12px}}.stats b{{display:block;font-family:var(--mono);font-size:15px}}.card p{{font-size:13px;line-height:1.55}}.table-wrap{{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:var(--surface)}}table{{width:100%;border-collapse:collapse;font:14px var(--body)}}th,td{{text-align:left;padding:14px 12px;border-bottom:1px solid var(--line);white-space:nowrap}}th{{background:var(--bg);color:var(--muted);font-size:12px;font-weight:600}}tbody tr:last-child td{{border-bottom:0}}.rejections{{display:grid;gap:10px;margin-bottom:30px}}.reject{{display:flex;justify-content:space-between;gap:12px;background:var(--bad-soft);color:var(--bad);padding:12px 15px;border-radius:9px;font-size:14px}}footer{{margin-top:40px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}}@media(max-width:640px){{.funnel,.cards{{grid-template-columns:1fr}}main{{padding-top:25px}}}}</style></head><body><main>
 <div class="eyebrow">BACKLINK REPORT · {safe(site)} · {datetime.now(timezone.utc).strftime('%Y-%m-%d')} UTC</div>
 <h1>{top} independently qualified prospect(s), from {report['prospects']} discovered</h1>
 <p class="muted">No fabricated domain metrics. No email is classified as delivered without evidence; no backlink is classified as live without a page check.</p>
 <section class="funnel"><div class="metric"><strong>{report['prospects']}</strong><span>Discovered</span></div><div class="metric"><strong>{report['sources_checked']}</strong><span>Page-checked</span></div><div class="metric"><strong>{report['qualified']}</strong><span>Qualified</span></div><div class="metric"><strong>{report['drafts']}</strong><span>Drafted</span></div><div class="metric"><strong>{report['links_live']}</strong><span>Verified live links</span></div></section>
 <div class="funnel"><div class="metric"><strong>{report['form_opportunities']}</strong><span>Eligible forms under review (not yet submitted)</span></div><div class="metric"><strong>{report['forms_confirmed']}</strong><span>Confirmed form receipts</span></div><div class="metric"><strong>{report['sent']}</strong><span>Sent in this local worker only</span></div><div class="metric"><strong>{report['emails_awaiting_reconciliation']}</strong><span>Uncertain Gmail outcomes</span></div><div class="metric"><strong>no data</strong><span>Traffic where provider absent</span></div></div>
 {dfs_panel}
 {website_table}
 <h2>Why prospects were rejected</h2>
 <p class="muted">Rejection reasons come from live or imported evidence, not hypothetical filters.</p>
 <div class="rejections">{drop_details or '<p>No prospects have failed a live filtering step yet.</p>'}{example_rejects}</div>
 <h2>Evidence-checked opportunities</h2><div class="cards">{''.join(cards) if cards else '<p>No prospects imported or discovered yet. Run a verified backlink-gap import or footprint search first.</p>'}</div>
 <h2>Operational rules</h2><p>Do not send to suppressed or unverifiable addresses. Backlink gap metrics require an authentic backlink data export/API; zero reported metrics are not evidence of zero traffic. Publisher acceptance, backlinks, and referrals are independent outcomes.</p>
 <footer>Every statistic from local verified data · every successful page check recorded · no automatic backlink claims · user controls sending credentials and limits</footer>
 </main></body></html>'''
    Path(output_path).parent.mkdir(parents=True,exist_ok=True)
    Path(output_path).write_text(html_text,encoding='utf-8')
    return output_path
