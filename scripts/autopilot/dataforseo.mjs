/**
 * DataForSEO client with a persistent spend ledger and hard daily/monthly caps.
 * Every billed call is recorded with the provider-reported cost. Endpoints the
 * account cannot access are parked for 7 days instead of failing every run.
 */
import {sleep,NOW,ageDays} from './util.mjs';

const API='https://api.dataforseo.com/v3/';
const ESTIMATE={serp:0.004,relevant_pages:0.03};

export class DataForSEO{
  constructor({login,password,state,dailyUsd=0.5,monthlyUsd=10,fetchImpl=fetch,log=()=>{}}){
    this.auth=login&&password?Buffer.from(`${login}:${password}`).toString('base64'):'';
    this.state=state;state.ledger??=[];state.dfs_blocked??={};
    this.dailyUsd=dailyUsd;this.monthlyUsd=monthlyUsd;this.fetch=fetchImpl;this.log=log;this.calls=0;this.spent=0;
  }
  get enabled(){return !!this.auth}
  reject(status,body){
    const msg=String(body?.status_message||body?.tasks?.[0]?.status_message||'').slice(0,140);
    this.authError=status===403?`DataForSEO refused access (HTTP 403${msg?': '+msg:''}). If IP allow-listing is on in your DataForSEO account, turn it off — GitHub's servers use changing IPs.`
      :`DataForSEO rejected the login (HTTP ${status}${msg?': '+msg:''}). Use the API login and the API password from app.dataforseo.com/api-access — not your website password.`;
    this.log('dataforseo: '+this.authError);this.auth='';
  }
  /** Free account check (no charge): confirms the login works and reads the balance. */
  async verify(){
    if(!this.auth)return {status:'missing'};
    try{
      const res=await this.fetch(API+'appendix/user_data',{headers:{Authorization:'Basic '+this.auth},signal:AbortSignal.timeout(30000)});
      const body=await res.json().catch(()=>null);
      if(res.status===401||res.status===403||body?.status_code===40100){this.reject(res.status===200?401:res.status,body);return {status:'rejected',error:this.authError}}
      const r=body?.tasks?.[0]?.result?.[0];
      if(!res.ok||!r)return {status:'unverified',error:`DataForSEO account check failed (HTTP ${res.status})`};
      return {status:'connected',balance_usd:Number(r.money?.balance??NaN)};
    }catch{return {status:'unverified',error:'DataForSEO could not be reached'}}
  }
  spend(period){const key=period==='day'?NOW().slice(0,10):NOW().slice(0,7);
    return this.state.ledger.filter(x=>x.at.startsWith(key)).reduce((n,x)=>n+Number(x.cost||0),0)}
  canSpend(kind){
    if(!this.enabled)return false;
    const b=this.state.dfs_blocked[kind];if(b&&ageDays(b)<7)return false;
    const est=ESTIMATE[kind]??0.05;
    return this.spend('day')+est<=this.dailyUsd&&this.spend('month')+est<=this.monthlyUsd;
  }
  async post(kind,endpoint,task){
    if(!this.canSpend(kind))return null;
    for(let attempt=0;attempt<2;attempt++){
      let body;
      try{
        const res=await this.fetch(API+endpoint,{method:'POST',headers:{Authorization:'Basic '+this.auth,'Content-Type':'application/json'},body:JSON.stringify([task]),signal:AbortSignal.timeout(60000)});
        body=await res.json().catch(()=>null);
        if(res.status===401||res.status===403){this.reject(res.status,body);return null}
      }catch{body=null}
      const cost=Number(body?.cost||0);
      if(cost>0){this.state.ledger.push({at:NOW(),kind,endpoint,cost});this.spent+=cost}
      this.calls++;
      const t=body?.tasks?.[0],code=Number(t?.status_code||body?.status_code||0);
      if(code===20000)return t.result||[];
      if(code>=40200&&code<40300||code===40204||code===40104){this.state.dfs_blocked[kind]=NOW();this.log(`dataforseo: ${kind} not available on this account (${code}); parked 7 days`);return null}
      if(attempt===0&&(!body||code>=50000||code===40101)){await sleep(3000);continue}
      this.log(`dataforseo: ${endpoint} failed ${code} ${t?.status_message||body?.status_message||''}`.trim());
      return null;
    }
    return null;
  }
  async serp(keyword,{depth=20,location=2840,language='en'}={}){
    const r=await this.post('serp','serp/google/organic/live/advanced',{keyword,location_code:location,language_code:language,depth});
    return (r?.[0]?.items||[]).filter(x=>x.type==='organic').map(x=>({url:x.url,domain:x.domain,title:x.title,description:x.description,rank:x.rank_absolute}));
  }
  async relevantPages(domain,{limit=100,location=2840,language='en'}={}){
    const r=await this.post('relevant_pages','dataforseo_labs/google/relevant_pages/live',{target:domain,location_code:location,language_code:language,limit,order_by:['metrics.organic.etv,desc'],exclude_top_domains:false});
    return (r?.[0]?.items||[]).map(x=>{const o=x.metrics?.organic||{};
      return {url:x.page_address,etv:o.etv||0,keywords:o.count||0,striking:(o.pos_4_10||0)+(o.pos_11_20||0),top3:(o.pos_1||0)+(o.pos_2_3||0)}});
  }
}
