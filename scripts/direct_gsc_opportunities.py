#!/usr/bin/env python3
"""Read-only direct GSC URL prioritizer. No email, WordPress write, or paid APIs."""
import argparse, datetime as dt, json, math, os, re, sys
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlsplit

SITES=("gearuptofit.com","affiliatemarketingforsuccess.com","plantastichaven.com","gearuptogrow.com","frenchyfab.com","micegoneguide.com","mysticaldigits.com","efficientgptprompts.com","openclaw-skillshub.com","imagealchemy.app")
KEY_CANDIDATES=("/home/hermes/.hermes/secrets/google-search-console-service-account.json","/home/hermes/.hermes/cache/seo-optimizer-456317-9ac3ea9a1b61.json")
EXCLUDED=re.compile(r"/(?:wp-|privacy|terms|disclaimer|about|contact|author|tag|category|feed|cart|checkout)(?:/|$)|\.(?:xml|json|pdf)$",re.I)
BAD_QUERIES=re.compile(r"\b(login|password|download crack|free trial code|coupon)\b",re.I)
def metrics(rows):
    data=defaultdict(lambda:{"clicks":0.0,"impressions":0.0,"weighted_position":0.0,"query_samples":[]})
    for row in rows:
        keys=row.get("keys",[]); 
        if not keys: continue
        url=keys[0]; q=keys[1] if len(keys)>1 else ""
        im=float(row.get("impressions",0)); cl=float(row.get("clicks",0))
        if im<=0: continue
        target=data[url]; target["clicks"]+=cl; target["impressions"]+=im
        target["weighted_position"]+=im*float(row.get("position",100))
        if q and not BAD_QUERIES.search(q):
            target["query_samples"].append({"query":q,"impressions":im,"clicks":cl,"position":round(float(row.get("position",100)),2)})
    return data
def allowed(domain,url):
    try:
        u=urlsplit(url); host=u.hostname or ""
        return u.scheme=="https" and host.lower().removeprefix("www.")==domain and bool(u.path.strip("/")) and not EXCLUDED.search(u.path)
    except ValueError:return False
def score(domain,url,record,previous=None):
    if not allowed(domain,url):return None
    imp=record["impressions"]; clicks=record["clicks"]
    if imp<15:return None
    pos=record["weighted_position"]/imp; ctr=clicks/imp
    # Opportunity estimate is for prioritization only; not a predicted click or backlink count.
    opportunity=max(0.0, imp*(0.05 if 3<=pos<=10 else 0.025 if pos<=20 else 0.008)-clicks)
    queries=sorted(record["query_samples"],key=lambda q:q["impressions"],reverse=True)[:8]
    linkable=any(x in (url.lower()+" "+" ".join(q["query"].lower() for q in queries)) for x in ("calculator","methodology","guide","study","plant","tool","data","checklist","framework","comparison","spaced repetition","how to","security"))
    historic=previous or {}; decay=max(0.0,(historic.get("impressions",0)-imp)/max(historic.get("impressions",0),1))
    value=(math.log1p(imp)*8+math.sqrt(opportunity)*5+min(decay,1)*10)*(1.2 if 3<=pos<=20 else 0.8)*(1.2 if linkable else 0.7)
    return {"site":domain,"url":url,"score":round(value,2),"clicks":round(clicks,2),"impressions":round(imp,2),"ctr":round(ctr,5),"position":round(pos,2),"potential_gap_estimate":round(opportunity,2),"past_period_impressions":round(historic.get("impressions",0),2),"query_samples":queries,"linkability_signal":"candidate_only" if linkable else "review_needed","eligibility":"REQUIRES_LIVE_CANONICAL_CONTENT_REVIEW","promotion_status":"RESEARCH_ONLY_NO_SEND"}
def candidate_rows(domain,now_rows,prev_rows):
    cur=metrics(now_rows); prior=metrics(prev_rows)
    ranked=[score(domain,u,x,prior.get(u)) for u,x in cur.items()]
    return sorted((x for x in ranked if x),key=lambda x:(-x["score"],x["url"]))
def credential_path():
    paths=([os.environ["GSC_SERVICE_ACCOUNT_FILE"]] if os.getenv("GSC_SERVICE_ACCOUNT_FILE") else [])+list(KEY_CANDIDATES)
    return next((Path(p) for p in paths if Path(p).is_file()),None)
def service():
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    key=credential_path()
    if not key:raise RuntimeError("GSC service account missing: use GSC_SERVICE_ACCOUNT_FILE or provision existing Hermes credential")
    creds=service_account.Credentials.from_service_account_file(str(key),scopes=["https://www.googleapis.com/auth/webmasters.readonly"])
    return build("searchconsole","v1",credentials=creds,cache_discovery=False)
def query(api,site,start,end):
    out=[]
    # Stable pagination avoids silently truncating more than one API page.
    for start_row in range(0,100000,25000):
        resp=api.searchanalytics().query(siteUrl=site,body={"startDate":str(start),"endDate":str(end),"dimensions":["page","query"],"rowLimit":25000,"startRow":start_row,"type":"web","dataState":"final"}).execute()
        batch=resp.get("rows",[]);out+=batch
        if len(batch)<25000:break
    return out
def collect(days,limit):
    api=service(); access={x.get("siteUrl") for x in api.sites().list().execute().get("siteEntry",[])}
    end=dt.date.today()-dt.timedelta(days=3);start=end-dt.timedelta(days=days-1)
    prev_end=start-dt.timedelta(days=1);prev_start=prev_end-dt.timedelta(days=days-1)
    result={"generated_at":dt.datetime.now(dt.timezone.utc).isoformat(),"data_source":"Google Search Console official API (service account)","read_only":True,"window":{"start":str(start),"end":str(end),"previous_start":str(prev_start),"previous_end":str(prev_end)},"sites":[],"candidates":[]}
    for domain in SITES:
        prop=next((v for v in (f"sc-domain:{domain}",f"https://{domain}/") if v in access),None)
        if not prop:
            result["sites"].append({"domain":domain,"status":"NO_ACCESS"});continue
        try:
            current=query(api,prop,start,end);previous=query(api,prop,prev_start,prev_end)
            ranked=candidate_rows(domain,current,previous)[:limit]
            result["sites"].append({"domain":domain,"status":"OK","property":prop,"qualified_for_review":len(ranked)})
            result["candidates"].extend(ranked)
        except Exception as error:
            result["sites"].append({"domain":domain,"status":"ERROR","error_type":type(error).__name__})
    result["candidates"].sort(key=lambda x:(-x["score"],x["site"],x["url"]))
    return result
def main():
    p=argparse.ArgumentParser();p.add_argument("--days",type=int,default=90);p.add_argument("--per-site",type=int,default=10);p.add_argument("--output",default="data/gsc-url-opportunities.json");args=p.parse_args()
    if not 7<=args.days<=365 or not 1<=args.per_site<=100:p.error("days must be 7-365; per-site 1-100")
    try:r=collect(args.days,args.per_site)
    except Exception as e:print("GSC sync failed:",type(e).__name__,str(e)[:170],file=sys.stderr);sys.exit(1)
    path=Path(args.output);path.parent.mkdir(parents=True,exist_ok=True)
    import tempfile
    with tempfile.NamedTemporaryFile(mode="w",encoding="utf-8",dir=path.parent,delete=False) as f:
        json.dump(r,f,indent=2,ensure_ascii=False);tmp=f.name
    os.replace(tmp,path)
    print(json.dumps({"output":str(path),"sites_ok":sum(x["status"]=="OK" for x in r["sites"]),"candidates":len(r["candidates"]),"sending_enabled":False}))
    if not any(x["status"]=="OK" for x in r["sites"]):sys.exit(2)
if __name__=="__main__":main()
