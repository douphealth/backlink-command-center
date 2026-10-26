/**
 * GitHub Autopilot read-only intelligence for every legacy/browser section.
 * The browser IndexedDB is not shared with the encrypted GitHub vault.
 * Never reinterpret local controls, suppression or zero counts as live state.
 */
export async function readAutopilot(fetchImpl=fetch){
  try{
    const res=await fetchImpl('/data/autopilot.json',{cache:'no-store',signal:AbortSignal.timeout(6500)});
    if(!res.ok||!(res.headers.get('content-type')||'').toLowerCase().includes('json'))return null;
    const data=await res.json();
    if(data?.schema!=='linkforge-autopilot/1'||!data.funnel||!data.generated_at)return null;
    return data;
  }catch{return null}
}
export function ageHours(snapshot,now=Date.now()){
  if(!snapshot?.generated_at)return Infinity;
  const date=Date.parse(snapshot.generated_at);
  return Number.isFinite(date)?Math.max(0,(now-date)/36e5):Infinity;
}
const caution={
  overview:'Figures below come from GitHub Autopilot. Manual browser records are not synchronized.',
  operations:'Local pause controls and saved plans do NOT affect live GitHub Autopilot. Use its Run/Stop controls.',
  prospects:'The list below contains locally saved publishers. Unlock the encrypted live queue under Autopilot.',
  outreach:'The list below is browser-local. Live SMTP acceptance does not prove inbox delivery.',
  placements:'Live link observations are shown separately from imported browser-only records.',
  submissions:'Autopilot does not automatically submit publisher forms. This is manual tracking only.',
  spend:'Live GitHub API charges and the on-device browser ledger are separate.',
  sites:'Live crawl counts are different from manual HTTP checks stored on this device.',
  learning:'The learning engine uses GitHub Autopilot results, not imported browser-only outcomes.',
  activity:'Live scheduled-run events and local browser activity are independent records.',
  suppression:'Important: browser-local suppression does NOT stop the live Autopilot from emailing a publisher.'
};
export function liveBanner(snapshot,view,{escapeHTML:e,n,niceTime}){
  const valid=snapshot&&Number.isFinite(ageHours(snapshot));
  const stale=!valid||ageHours(snapshot)>8;
  const title=valid?'GitHub Autopilot snapshot · '+niceTime(snapshot.generated_at):'GitHub Autopilot snapshot unavailable';
  const status=stale?'LAST CYCLE NOT RECENTLY VERIFIED':'LAST CYCLE RECORDED';
  const f=snapshot?.funnel||{};
  const counts=valid?'<div class="live-snapshot-counts">'+
    n(f.prospects_evaluated)+' evaluated · '+n(f.qualified)+' qualified · '+n(f.contacted)+' contacted · '+n(f.won)+' earned links</div>':'';
  return '<section class="browser-banner live-context" role="status"><div>'+
    '<div class="browser-eyebrow">'+status+' · BROWSER RECORDS SEPARATE</div>'+
    '<strong>'+e(title)+'</strong><p>'+e(caution[view]||'This page stores manual records only.')+'</p>'+counts+'</div>'+
    '<div class="browser-actions"><button class="secondary" data-view="autopilot">Open Autopilot</button>'+
    '<button class="secondary" data-action="backup-workspace">Back up local data</button></div></section>';
}
function statGrid(rows,h){
  const e=h.escapeHTML,n=h.n;
  return '<div class="section-grid live-stats">'+rows.map(r=>
    '<div class="mini-stat"><strong>'+e(typeof r[1]==='number'?n(r[1]):String(r[1]??'—'))+
    '</strong><span>'+e(r[0])+'</span></div>').join('')+'</div>';
}
const sectionHeading='<div class="data-note live-note"><strong>Source:</strong> GitHub Autopilot published snapshot. Data below is read-only and independently stored from this browser workspace.</div>';
export function livePanel(s,view,h){
  if(!s||!s.funnel)return '';
  const {escapeHTML:e,n,niceTime,external,panel,table,empty}=h;
  const f=s.funnel,sp=s.spend||{},out=s.outreach||{},stages=s.stages||{};
  if(view==='overview')return '';
  if(view==='prospects')return statGrid([
    ['Domains evaluated',f.prospects_evaluated],['Qualified publishers',f.qualified],['Ready for outreach',out.ready||0]],h)
    +sectionHeading;
  if(view==='outreach')return statGrid([
    ['SMTP-accepted initial pitches',f.contacted],['Replies recorded',f.replied],['Ready to contact',out.ready||0]],h)
    +panel('Live Autopilot outreach status','Sending is scheduled independently from browser-only messages',
      '<div class="panel-pad">Mode: <strong>'+e(out.mode||'unknown')+'</strong> · Today: '+
      n(out.sent_today||0)+'/'+n(out.cap_today||0)+' · Next eligible window: '+
      e(out.next_send_at?niceTime(out.next_send_at):'not scheduled')+
      '<p class="hint">These are recorded initial pitches, not independently confirmed inbox deliveries.</p></div>')
    +sectionHeading;
  if(view==='placements'){
    const wins=(s.wins||[]).slice(0,200);
    const rows=wins.map(x=>'<tr><td>'+e(x.publisher||'unknown')+'</td><td>'+
      external(x.page_url,'Source page')+'</td><td>'+external(x.target,'Target URL')+'</td><td>'+
      e(x.kind==='won'?'Earned after outreach':'Pre-existing link')+'</td><td>'+e(x.rel||'unspecified')+'</td></tr>');
    return statGrid([['Earned links',f.won],['Pre-existing found',f.existing_links],['Links in published evidence',wins.length]],h)
      +panel('Links observed by GitHub Autopilot','Pre-existing references are not credited as new outreach results',
        rows.length?table(['Publisher','Publisher page','Our asset','Attribution','Rel'],rows):
          empty('No observed backlinks','Autopilot has not published any source-page link evidence.'))
      +sectionHeading;
  }
  if(view==='spend')return statGrid([
    ['GitHub Autopilot spend today','$'+Number(sp.today_usd||0).toFixed(3)],
    ['Autopilot spend this month','$'+Number(sp.month_usd||0).toFixed(3)],
    ['Monthly Autopilot cap','$'+Number(sp.monthly_cap_usd||0).toFixed(2)]],h)+sectionHeading;
  if(view==='sites'){
    const rows=(s.sites||[]).map(x=>'<tr><td>'+e(x.domain)+'</td><td>'+n(x.discovered)+'</td><td>'+
      n(x.pages)+'</td><td>'+n(x.eligible)+'</td><td>'+external(x.top,'Top eligible URL')+'</td></tr>');
    return panel('Portfolio crawl · GitHub Autopilot','Only pages actually included in the last crawl count as crawled',
      rows.length?table(['Site','Discovered','Crawled','Promotable','Top URL'],rows):empty('No crawl data','No site results published.'))+sectionHeading;
  }
  if(view==='learning'){
    const fps=(s.learning?.footprints||[]).slice(0,12);
    const rows=fps.map(x=>'<tr><td>'+e(x.footprint)+'</td><td>'+n(x.queries)+'</td><td>'+
      n(x.ready)+'</td><td>'+Number(x.rate||0).toFixed(2)+' leads/search</td></tr>');
    return panel('Observed search yield · GitHub Autopilot',
      'Prospects per tracked search, not a success probability; more than one lead per search is possible',
      rows.length?table(['Search pattern','Tracked searches','Ready leads','Leads / search'],rows):
        empty('No search outcomes','The system has not published discovery learning yet.'))+sectionHeading;
  }
  if(view==='activity'){
    const logs=(s.log||[]).slice(-25).reverse();
    const rows=logs.map(x=>'<tr><td>'+e(x)+'</td></tr>');
    return panel('Last Autopilot cycle log','Published, sanitized run events (browser activity remains separate)',
      rows.length?table(['Recorded event'],rows):empty('No published events','No latest run log found.'))+sectionHeading;
  }
  if(view==='operations'){
    const rows=Object.entries(stages).map(([name,x])=>'<tr><td>'+e(name)+'</td><td>'+
      e(x.ok===true?'Completed':x.ok===false?'FAILED':'Skipped')+'</td><td>'+
      e(x.error||x.skipped||'—')+'</td></tr>');
    return statGrid([['Last cycle',niceTime(s.generated_at)],['SMTP-accepted initial pitches',f.contacted],
      ['Latest earned links',f.won]],h)
      +panel('GitHub automation stage health','A completed stage does not guarantee business outcomes',
        table(['Stage','State','Reason'],rows))
      +'<div class="alert-warning">The controls below apply only to the local browser workspace. They do NOT pause, resume or cancel GitHub Autopilot.</div>';
  }
  if(view==='suppression')return '<div class="alert-warning"><strong>Live outreach safety:</strong> '+
      'This browser suppression list is NOT connected to the live GitHub Autopilot vault. '+
      'Adding a domain here does not prevent unattended outreach. Stop Autopilot from its own controls '+
      'if a live publisher must not be contacted until suppression is synchronized.</div>';
  if(view==='submissions')return '<div class="data-note"><strong>Autonomy boundary:</strong> GitHub Autopilot discovers editorial prospects and sends email, '+
      'but does not independently submit website forms or bypass CAPTCHAs. No submitted forms should be claimed without a receipt.</div>';
  return '';
}
