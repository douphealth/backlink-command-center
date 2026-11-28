/**
 * 3-way (ABC) link exchange. Publisher B is asked to link to our site A; in return the owner places a contextual link to
 * B's article from a genuinely related page on one of our OTHER sites, C. C is never A (no A<->B swap), never on B's own
 * domain, and always one of the owner's sites (SITES). No payment is offered or accepted here.
 *
 * The engine has no write access to our sites: it picks the partner page, records the promise in the vault and verifies
 * both links from crawls. Obligation record p.exchange = {...offer, status, offered_at, accepted_at?, their_link_at?,
 * owed_by?, fulfilled_at?, via:'email'|'form'}:
 *   offered -> accepted (a reply says yes, replies.mjs) -> their_link_live (checkLinks finds B's link to A; the return link
 *   is owed within cfg.fulfilDays) -> fulfilled (a link to B's domain is found on the partner page, from the crawl or a fetch)
 *   offered/accepted -> declined (opt-out) | lapsed (no reply and no link for 60 days, or no link 120 days after an answer)
 * Declined and lapsed records free the caps. A link B places after its offer lapsed is still honoured (back to owed).
 * Published from here: counts only (no publisher domains, URLs, names, or which of our pages carries which link).
 */
import {tokens,normUrl,hostOf,rootDomain,sameSite,fetchPage,links,DAY} from './util.mjs';
import {pageIssue,utilityPage} from './indexation.mjs';
import {contentHtml} from './broken.mjs';
import {isSuppressed} from './recipient-policy.mjs';

/** New offers pause while this many promised return links are overdue (the owner catches up first). */
export const EXCHANGE_PAUSE_AT=3;
/** An offer nobody answered and nobody acted on lapses after this many days; an answered or accepted one after STALE_DAYS. */
export const LAPSE_DAYS=60,STALE_DAYS=120;
/** A partner page must be a real article: words, and the thresholds a topical match must reach. */
const MIN_WORDS=500,MIN_SHARED=3,MIN_SCORE=8,CTX_BODY_MAX=3;
// Counted against the caps: offers still open, obligations and links already given. Declined and lapsed free them.
const ACTIVE=new Set(['offered','accepted','their_link_live','fulfilled']),OPEN=new Set(['offered','accepted']);
/** A promise still running with a publisher: one at a time per publisher domain (across all its prospects). */
const RUNNING=new Set(['offered','accepted','their_link_live']);
/** Lapses that no later link of theirs revives: the offer as made was refused (countered) or C is no longer ours. */
const FINAL_LAPSE=new Set(['countered','partner_gone']);
// Pages Google will not index as themselves (searchconsole.mjs classes): a return link from them is worth little.
const UNLINKABLE=new Set(['noindex','canonical_elsewhere','redirect','not_found']);
const related=(x,y)=>!!x&&!!y&&(sameSite(x,y)||sameSite(y,x));
const ms=t=>t instanceof Date?t.getTime():Number.isFinite(Number(t))?Number(t):Date.parse(t)||Date.now();
/** Light stemming so "plants"/"plant" and "studying"/"study" meet; applied to both sides alike. */
const stem=w=>w.length>4&&w.endsWith('ies')?w.slice(0,-3)+'y':w.length>=7&&w.endsWith('ing')?w.slice(0,-3).replace(/([b-df-hj-np-tv-z])\1$/,'$1')
  :w.length>3&&/[^su]s$/.test(w)&&!w.endsWith('is')?w.slice(0,-1):w;
// Words too broad to prove two pages share a subject (the GENERIC idea from prospect.mjs and assets.mjs, wider here because
// C is on another site: only a specific shared subject makes the return link genuinely related).
const GENERIC=new Set(('guide tips home best top free online tool tools calculator help learn learning page site website blog article post '+
  'resource resources list ideas info information easy simple beginner beginners basics step steps practice way ways thing things time year day '+
  'people need know like good great first many much well want look find take keep start better important different example including based read '+
  'share update updated work life part long high low sure really actually often every right real full quick fast old next last little big small '+
  'should would could might must here because some other only each while over after before through been being were had did very without '+
  'within between around down off again same such both few less lot lots thank thanks click sign subscribe newsletter privacy policy cookie comment comments').split(' ').map(stem));
const words=text=>[...new Set(tokens(text).map(stem).filter(w=>w.length>2&&!GENERIC.has(w)))];
const pathWords=url=>{try{return new URL(url).pathname.replace(/[-_/.]/g,' ')}catch{return ''}};

/** Failing sites in an indexation report (the health rule `site_failing`): never chosen as C while they fail. */
export const failingSites=indexation=>new Set((indexation?.sites||[]).filter(s=>s.alert&&s.server_error>=10).map(s=>rootDomain(s.site)));

/**
 * Pages of our sites that can carry a contextual outbound link: HTTP 200, indexable as themselves (no noindex, self
 * canonical, no redirect), not utility or legal pages, at least 500 words, with title words. `crawl` is this cycle's crawl
 * ([{site,pages}]) or the crawl cache ({url: record}). Also keeps, for every crawled page of ours, the hosts its content
 * links to (crawl.mjs external_links and external_hosts), for the "already links to B" filter and fulfilment checks.
 */
export function buildPartnerIndex(crawl,sites,{failing=[]}={}){
  const ours=new Set((sites||[]).map(s=>rootDomain(s.domain)).filter(Boolean)),bySite=new Map(),pages=new Map();
  const records=Array.isArray(crawl)?crawl.flatMap(s=>(s?.pages||[]).map(p=>[s.site,p])):Object.values(crawl||{}).map(p=>[p?.site,p]);
  for(const [siteName,p] of records){
    const d=rootDomain(siteName||p?.site),url=normUrl(p?.url||'');
    if(!url||!ours.has(d)||!sameSite(hostOf(url),d)||p.status!==200)continue;
    // external_links (crawl.mjs) leaves out social, shop and wordpress.com hosts and share-/login- paths; external_hosts lists
    // every host the content links to, so a return link to such a publisher is still seen.
    const ext=Array.isArray(p.external_links)?p.external_links:[],hosts=[...new Set([...ext.map(l=>hostOf(l?.url)),...(Array.isArray(p.external_hosts)?p.external_hosts.map(rootDomain):[])].filter(Boolean))];
    const rec={site:d,url,hosts,listed:ext.length};
    pages.set(url,rec);if(p.final_url&&normUrl(p.final_url)!==url)pages.set(normUrl(p.final_url),rec);
    if(pageIssue(p)!==null||(Number(p.words)||0)<MIN_WORDS||utilityPage(p.url))continue;
    const head=words(`${p.h1||''} ${p.title||''}`);if(!head.length)continue;
    const body=[...new Set([...(p.h2||[]).flatMap(words),...(p.terms||[]).filter(t=>!String(t).includes(' ')).slice(0,40).flatMap(words)])].filter(w=>!head.includes(w));
    const phrases=[...new Set((p.terms||[]).filter(t=>String(t).includes(' ')).map(words).filter(w=>w.length===2).map(w=>w.join(' ')))].slice(0,25);
    const entry={site:d,url,title:String(p.h1||p.title||'').replace(/\s+/g,' ').trim().slice(0,180),words:Number(p.words)||0,head,body,phrases,hosts};
    (bySite.get(d)||bySite.set(d,[]).get(d)).push(entry);
  }
  for(const list of bySite.values())list.sort((a,b)=>a.url.localeCompare(b.url));
  return {ours,sites:bySite,pages,failing:new Set([...failing].map(rootDomain))};
}

/** What B's article is about: its title, the section that fits, that section's text and the article excerpt. */
function context(p){
  const all=tokens(`${p.title||''} ${p.fit_section||''} ${p.fit_excerpt||''} ${String(p.excerpt||'').slice(0,1500)}`).map(stem).filter(w=>w.length>2&&!GENERIC.has(w));
  const pairs=new Set();for(let i=0;i+1<all.length;i++)pairs.add(`${all[i]} ${all[i+1]}`);
  const head=new Set(words(`${p.title||''} ${p.fit_section||''} ${pathWords(p.page_url)}`));
  return {head,ctx:new Set([...all,...head]),pairs};
}
/**
 * Topical relevance of partner page `c` to B's article (0 = no real match). Needs at least MIN_SHARED (3) distinct shared
 * meaningful words, at least one of them from C's own title or H1 (C's subject is in B's article: B's words found only in C's
 * body do not make it related), and a minimum score: title-to-title matches weigh most, incidental body words count at most
 * CTX_BODY_MAX, and a shared two-word phrase adds 2 unless both its words were already counted as title matches.
 */
export function relevance(c,{head,ctx,pairs}){
  const shared=new Set([...c.head,...c.body].filter(w=>ctx.has(w))),titled=c.head.filter(w=>ctx.has(w));
  if(shared.size<MIN_SHARED||!titled.length)return 0;
  let s=0,subject=0,incidental=0;
  for(const w of c.head){if(head.has(w)){s+=3;subject++}else if(ctx.has(w)){s+=2;subject++}}
  for(const w of c.body){if(head.has(w)){s+=2;subject++}else if(ctx.has(w)&&incidental<CTX_BODY_MAX){s++;incidental++}}
  s+=2*c.phrases.filter(x=>pairs.has(x)&&!x.split(' ').every(w=>titled.includes(w))).length;
  return subject&&s>=MIN_SCORE?s:0;
}

/**
 * Exchange load from the vault: per partner page (every open or fulfilled exchange ever), per partner site (offers and
 * obligations active in the last 30 days, plus every link still owed) and the overdue count. An offer drafted as an answer
 * for the owner to send (p.exchange_draft, replies.mjs) holds its page for as long as the draft may still be sent
 * (STALE_DAYS), and its site for 30 days, so the owner sending it late never puts a page over its cap.
 */
export function exchangeTally(state,now=Date.now()){
  const t=ms(now),site=new Map(),page=new Map();let overdue=0;
  for(const p of Object.values(state?.prospects||{})){const x=p?.exchange;
    if(!x||!ACTIVE.has(x.status)){const d=p?.exchange_draft,u=normUrl(d?.partner_page||''),c=rootDomain(d?.partner_site||'');
      const age=t-Date.parse(d?.at);
      if(d&&!(age>=STALE_DAYS*DAY)){if(u)page.set(u,(page.get(u)||0)+1);if(c&&!(age>=30*DAY))site.set(c,(site.get(c)||0)+1)}
      continue}
    const u=normUrl(x.partner_page||''),d=rootDomain(x.partner_site);
    if(u)page.set(u,(page.get(u)||0)+1);
    const last=Math.max(...[x.offered_at,x.accepted_at,x.their_link_at,x.fulfilled_at].map(v=>Date.parse(v||'')).filter(Number.isFinite));
    if(d&&(x.status==='their_link_live'||t-last<30*DAY))site.set(d,(site.get(d)||0)+1);
    if(x.status==='their_link_live'&&Date.parse(x.owed_by)<t)overdue++;
  }
  return {site,page,overdue};
}
const offerOf=x=>({partner_site:x.partner_site,partner_page:x.partner_page,partner_title:x.partner_title,their_url:x.their_url,their_title:x.their_title,score:x.score});
/**
 * Publisher B's footprint with us, over every prospect on B's domain (prospects are kept per site, so one publisher can be
 * known to several of our sites): `sites` = our sites B already links to (a won or existing link, or B's side of an exchange
 * that was accepted or done) and our sites that already give B a return link (C of any active exchange). Choosing one of them
 * as C would make a reciprocal swap or stack two promises on one site. `running`: B has an exchange or a sent-able exchange
 * offer still in progress, so no second one is offered.
 */
export function publisherFootprint(state,domain,{except=null}={}){
  const b=rootDomain(domain),sites=new Set();let running=false;
  if(!b)return {sites,running};
  for(const q of Object.values(state?.prospects||{})){
    if(!q||q===except||except?.id&&q.id===except.id)continue;
    if(!related(rootDomain(q.domain||hostOf(q.page_url)),b))continue;
    for(const u of q.status==='won'||q.status==='already_linked'||q.status==='lost'?[q.won?.target,q.existing_link?.url]:[])if(u&&hostOf(u))sites.add(hostOf(u));
    const x=q.exchange;
    if(x&&['accepted','their_link_live','fulfilled'].includes(x.status)&&q.site)sites.add(rootDomain(q.site));
    if(x&&ACTIVE.has(x.status)&&x.partner_site)sites.add(rootDomain(x.partner_site));
    if(x&&RUNNING.has(x.status))running=true;
    if(q.exchange_draft&&!(x&&ACTIVE.has(x.status))){running=true;if(q.exchange_draft.partner_site)sites.add(rootDomain(q.exchange_draft.partner_site))}
  }
  return {sites,running};
}

/**
 * The partner page C for prospect `p` (publisher B) pitched for our site `targetSite` (A), or null: no genuinely related
 * page, caps reached, exchanges off, or offers paused while EXCHANGE_PAUSE_AT or more return links are overdue. A prospect
 * that already holds an active exchange keeps its deal. One exchange runs per publisher domain at a time, and C is never a
 * site B already links to or already gets a return link from (publisherFootprint), so no C<->B swap and no A<->B swap from
 * an earlier exchange. Ties: higher score, then the partner site and page with the fewest exchanges, then the URL.
 */
export function pickPartner(p,targetSite,{index,state={},cfg={},now=new Date(),failing}={}){
  if(!p||!index?.sites||(cfg.mode&&cfg.mode!=='abc'))return null;
  if(p.exchange&&ACTIVE.has(p.exchange.status))return offerOf(p.exchange);
  const a=rootDomain(typeof targetSite==='string'?targetSite:targetSite?.domain||p.site),b=rootDomain(p.domain||hostOf(p.page_url));
  if(!a||!b||!p.page_url||[...(index.ours||[])].some(d=>related(d,b)))return null;
  const siteCap=Math.max(0,Math.floor(Number(cfg.perPartnerSiteMonth??6))),pageCap=Math.max(0,Math.floor(Number(cfg.perPartnerPage??2)));
  const tally=exchangeTally(state,now);
  if(!siteCap||!pageCap||tally.overdue>=EXCHANGE_PAUSE_AT)return null;
  const foot=publisherFootprint(state,b,{except:p});if(foot.running)return null;
  const down=new Set([...(failing||index.failing||[])].map(rootDomain)),want=context(p);
  let best=null;
  for(const [site,list] of index.sites){
    const load=tally.site.get(site)||0;
    if(related(site,a)||related(site,b)||down.has(site)||load>=siteCap||[...foot.sites].some(f=>related(f,site)))continue;
    for(const c of list){
      const used=tally.page.get(c.url)||0;
      if(used>=pageCap||c.hosts.some(h=>related(h,b))||UNLINKABLE.has(state.index_status?.[c.url]?.class))continue;
      const score=relevance(c,want);if(!score)continue;
      if(!best||score>best.score||score===best.score&&(load<best.load||load===best.load&&(used<best.used||used===best.used&&c.url<best.c.url)))best={c,score,load,used};
    }
  }
  return best?{partner_site:best.c.site,partner_page:best.c.url,partner_title:best.c.title,their_url:p.page_url,their_title:String(p.title||'').replace(/\s+/g,' ').trim().slice(0,180),score:best.score}:null;
}

/**
 * B's link to A is live: the return link is owed within `fulfilDays`. A lapsed offer is honoured too, except one that lapsed
 * because they refused it as made or C is no longer ours. An offer they countered (asked for the link back from A or another
 * site, replies) starts no obligation from C: the owner settles that conversation, so it lapses ('countered') instead.
 * `state`/`pageCap`: a lapsed offer revived on a page that already carries pageCap other exchanges is kept (it was promised)
 * but flagged `over_cap`, so the owner may place it on another related page of the same site (any page of C counts).
 * Returns whether it changed.
 */
export function noteTheirLink(p,{fulfilDays=7,now=new Date(),state=null,pageCap=2}={}){
  const x=p?.exchange;if(x?.status==='fulfilled')delete x.their_link_lost_at; // back after a redesign: nothing else changes
  if(!x||!['offered','accepted','lapsed'].includes(x.status)||x.status==='lapsed'&&FINAL_LAPSE.has(x.lapse_reason))return false;
  const t=ms(now),iso=new Date(t).toISOString();
  if(x.countered_at){if(x.status==='lapsed')return false;x.status='lapsed';x.lapsed_at=iso;x.lapse_reason='countered';return true}
  if(x.status==='lapsed'&&state){const u=normUrl(x.partner_page||'');
    const others=Object.values(state.prospects||{}).filter(q=>q!==p&&ACTIVE.has(q?.exchange?.status)&&u&&normUrl(q.exchange.partner_page||'')===u).length;
    if(others>=Math.max(1,Number(pageCap)||2))x.over_cap=true}
  x.status='their_link_live';x.their_link_at=iso;x.owed_by=new Date(t+(Number(fulfilDays)||7)*DAY).toISOString();
  delete x.lapsed_at;delete x.lapse_reason;delete x.their_link_lost_at;return true;
}
/** B's link to A is gone. Before our return link went up nothing is owed any more (back to accepted); after it, only noted. */
export function noteTheirLinkLost(p,{now=new Date()}={}){
  const x=p?.exchange;if(!x||!['their_link_live','fulfilled'].includes(x.status))return false;
  x.their_link_lost_at=new Date(ms(now)).toISOString();
  if(x.status==='their_link_live'){x.status='accepted';x.accepted_at??=x.their_link_at;delete x.owed_by}
  return true;
}
const linksToSite=(url,site)=>!!site&&related(hostOf(url),rootDomain(site));
/** The same article, however the link is written (scheme, www, trailing slash, tracking parameters). */
const sameArticle=(u,v)=>{const n=x=>normUrl(x||'').replace(/^https?:\/\/(?:www\.)?/i,'').toLowerCase();return !!n(u)&&n(u)===n(v)};

/**
 * The 'exchanges' stage, every cycle (free: plain fetches of our own pages only). Opt-outs and bounces close open offers;
 * a won link to A that checkLinks recorded earlier starts the obligation; stale offers lapse; and every owed return link
 * is looked for on its partner page: first in the crawl record, then by a direct fetch (at most `maxFetches` a cycle,
 * overdue and least recently checked first). Returns counts only.
 */
export async function trackExchanges({state,index=null,cfg={},fetchImpl=fetch,now=new Date(),maxFetches=10,deadline=Infinity,log=()=>{}}){
  const t=ms(now),iso=new Date(t).toISOString(),stats={their_link_live:0,fulfilled:0,declined:0,lapsed:0,fetched:0,owed:0,overdue:0};
  const owed=[];
  for(const p of Object.values(state?.prospects||{})){const x=p?.exchange;if(!x?.status)continue;
    if(OPEN.has(x.status)){
      if(p.status==='declined'||isSuppressed(state,p.email,p.domain)){x.status='declined';x.declined_at=iso;stats.declined++;continue}
      if(p.status==='won'&&linksToSite(p.won?.target,p.site)){if(noteTheirLink(p,{fulfilDays:cfg.fulfilDays,now:t,state,pageCap:cfg.perPartnerPage})){if(x.status==='their_link_live')stats.their_link_live++;else stats.lapsed++}}
      else if(p.status==='bounced'){x.status='lapsed';x.lapsed_at=iso;x.lapse_reason='bounced';stats.lapsed++;continue}
      else{
        const answered=Date.parse(p.replied_at)>=Date.parse(x.offered_at)||x.status==='accepted',since=Date.parse(x.accepted_at||x.offered_at);
        if(t-since>(answered?STALE_DAYS:LAPSE_DAYS)*DAY){x.status='lapsed';x.lapsed_at=iso;x.lapse_reason=answered?'no_link':'no_reply';stats.lapsed++;continue}
      }
    }
    if(x.status==='their_link_live')owed.push(p);
  }
  // Overdue first, then the least recently checked (never checked first), then the earliest due.
  const late=x=>Date.parse(x.owed_by)<t?0:1,str=v=>String(v||'');
  owed.sort((p,q)=>late(p.exchange)-late(q.exchange)||str(p.exchange.return_checked_at).localeCompare(str(q.exchange.return_checked_at))||str(p.exchange.owed_by).localeCompare(str(q.exchange.owed_by)));
  const fulfil=(x,how)=>{x.status='fulfilled';x.fulfilled_at=iso;x.verified_by=how;stats.fulfilled++};
  // One link to B's domain on a page fulfils one obligation: when two of B's exchanges point at the same page, each needs a link
  // to its own article. Any link in the page's content counts (social, shop and wordpress.com hosts, share- paths included).
  const onPage=new Map();
  for(const p of Object.values(state?.prospects||{})){const x=p?.exchange;if(x&&['their_link_live','fulfilled'].includes(x.status)){const k=`${normUrl(x.partner_page||'')}|${rootDomain(p.domain||hostOf(x.their_url))}`;onPage.set(k,(onPage.get(k)||0)+1)}}
  for(const p of owed){const x=p.exchange,b=rootDomain(p.domain||hostOf(x.their_url));if(!b||!x.partner_page)continue;
    const unique=(onPage.get(`${normUrl(x.partner_page)}|${b}`)||0)<=1;
    // A return link the owner moved to another page of the same site (offered over the page's cap) counts from any crawled page of C.
    const crawled=x.over_cap?[...(index?.pages?.values()||[])].filter(r=>related(r.site,rootDomain(x.partner_site))):[index?.pages?.get(normUrl(x.partner_page))].filter(Boolean);
    const at=unique?crawled.find(r=>r.hosts.some(h=>related(h,b))):null;
    // Placed on another page of C: that page is where the link now is (and what the page caps count from here on).
    if(at){if(normUrl(at.url)!==normUrl(x.partner_page)){x.offered_page=x.partner_page;x.partner_page=at.url;delete x.over_cap}fulfil(x,'crawl');continue}
    if(stats.fetched>=maxFetches||Date.now()>deadline)continue;
    stats.fetched++;x.return_checked_at=iso;
    const res=await fetchPage(x.partner_page,{fetchImpl,timeout:12000,maxBytes:2_000_000});
    if(res.status!==200)continue;
    const found=links(contentHtml(res.body||''),res.url||x.partner_page).filter(l=>related(hostOf(l.url),b));
    if(found.some(l=>sameArticle(l.url,x.their_url))||unique&&found.length)fulfil(x,'fetch');
  }
  for(const p of Object.values(state?.prospects||{}))if(p?.exchange?.status==='their_link_live'){stats.owed++;if(Date.parse(p.exchange.owed_by)<t)stats.overdue++}
  log(`exchanges: ${stats.their_link_live} publisher links started an obligation, ${stats.fulfilled} return links verified, ${stats.owed} owed (${stats.overdue} overdue), ${stats.lapsed} offers lapsed, ${stats.declined} declined${stats.fetched?`; ${stats.fetched} partner pages fetched`:''}`);
  return stats;
}

/**
 * Funnel counts (public): offers ever made, accepted (said yes or linked), owed (their link is live, ours not yet found),
 * overdue (owed past owed_by) and fulfilled (our return link verified).
 */
export function exchangeCounts(state,now=Date.now()){
  const t=ms(now),c={exchanges_offered:0,exchanges_accepted:0,exchanges_owed:0,exchanges_overdue:0,exchanges_fulfilled:0};
  for(const p of Object.values(state?.prospects||{})){const x=p?.exchange;if(!x?.status)continue;c.exchanges_offered++;
    if(x.accepted_at||['accepted','their_link_live','fulfilled'].includes(x.status))c.exchanges_accepted++;
    if(x.status==='their_link_live'){c.exchanges_owed++;if(Date.parse(x.owed_by)<t)c.exchanges_overdue++}
    if(x.status==='fulfilled')c.exchanges_fulfilled++}
  return c;
}
/** summary.exchanges (public): how many of our sites carry or owe exchange links (a count, no names) and whether offers pause. */
export function exchangeSummary(state,{cfg={},now=Date.now()}={}){
  const sites=new Set();for(const p of Object.values(state?.prospects||{})){const x=p?.exchange;if(x&&ACTIVE.has(x.status)&&x.partner_site)sites.add(rootDomain(x.partner_site))}
  return {by_partner_site_count:sites.size,paused:cfg.mode!=='off'&&exchangeTally(state,now).overdue>=EXCHANGE_PAUSE_AT};
}
