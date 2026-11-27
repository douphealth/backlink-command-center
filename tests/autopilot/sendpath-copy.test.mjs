import test from 'node:test';
import assert from 'node:assert/strict';
import {templatePitch,listInclusionPitch,brokenLinkPitch,alternativePitch,mentionPitch,followupPitch,isListPage,unusedFact,factsIn,assetFacts,
  pitchProblem,followupProblem,PitchWriter,aiProviders,reSubject} from '../../scripts/autopilot/pitch.mjs';

const site={domain:'gearuptofit.com',topic:'running shoes'};
const asset={url:'https://gearuptofit.com/shoe-finder/',title:'Running Shoe Finder | GearUpToFit',type:'interactive_tool',interactive:true,words:1900,
  description:'Answer six questions and get matched to running shoes by gait and terrain.',reasons:['2 data tables','Cites 12 authoritative sources','Flagship asset']};
const TOOL='it is a free interactive tool (no sign-up needed)',TABLES='it includes 2 data tables';
const urls=b=>b.match(/https?:\/\/\S+/g)||[];
// The owner's copy rules: no stock openers, no compliments, no pricing, no link swaps.
const BANNED=/I was reading|hope (?:this|you)|thanks for (?:putting|maintaining)|great (?:article|post|content)|love your|\bpric(?:e|ing)\b|\$\d|link exchange|didn't mention/i;

test('template pitches: who we are, one direct ask, one URL, one proof point and a concrete proposed edit; no filler',()=>{
  const p={id:'a',title:'Resources for New Runners',author:'Jane Doe',fit_section:'Choosing shoes'};
  const out=templatePitch(p,asset,{senderName:'Alex',site});
  assert.equal(out.variant,'template:resource_suggestion');assert.equal(out.writer,'template');
  assert.match(out.body,/^Hi Jane,\n\nI'm writing from gearuptofit\.com, a site about running shoes\. Would you consider adding Running Shoe Finder to your "Choosing shoes" section in "Resources for New Runners"\?/);
  assert.match(out.body,/the edit would be one link in that section, with "Running Shoe Finder" as the link text\./,'ends with a concrete edit: asset title as anchor, in the matched section');
  assert.deepEqual(urls(out.body),[asset.url]);assert.equal((out.body.match(/\?/g)||[]).length,2,'one ask (plus the P.S. question)');
  assert.doesNotMatch(out.body,BANNED);assert.doesNotMatch(out.body,/data tables|authoritative/,'one proof point only');
  assert.deepEqual(out.facts_used,[TOOL]);assert.doesNotMatch(out.body,/Flagship/);
  const plain=templatePitch({id:'b',title:'How to start running at 40'},asset,{senderName:'Alex',site});
  assert.match(plain.body,/adding Running Shoe Finder to "How to start running at 40"\?/);assert.match(plain.body,/one link on the page, with "Running Shoe Finder" as the link text/);
  for(const t of [brokenLinkPitch({id:'c',title:'X guide',broken_link:{anchor:'old fit guide',host:'dead.example',reason:'not_found'}},asset,{senderName:'Alex',site}),
    alternativePitch({id:'d',kind:'linkgap',title:'Gear',competitor_link:{host:'other.example',anchor:'shoe quiz',match:'topic'}},asset,{senderName:'Alex',site}),
    mentionPitch({id:'e',kind:'mention',title:'Pest tips'},asset,{senderName:'Alex',site})]){
    assert.doesNotMatch(t.body,BANNED);assert.deepEqual(urls(t.body),[asset.url]);assert.match(t.variant,/^template:/);assert.ok(Array.isArray(t.facts_used));
    assert.match(t.body,/Best,\nAlex\ngearuptofit\.com\n\nP\.S\. Not relevant for you\?/);
  }
  const broken=brokenLinkPitch({id:'c',title:'X guide',broken_link:{anchor:'old fit guide',host:'dead.example',reason:'not_found'}},asset,{senderName:'Alex',site});
  assert.match(broken.body,/Would you consider pointing "old fit guide" to the page above instead\?/,'the edit keeps their own anchor text');
  assert.match(mentionPitch({kind:'mention',title:'Pest tips'},asset,{senderName:'Alex',site}).body,/Thanks for mentioning Running Shoe Finder in "Pest tips"\./,'brand without the title suffix');
});

test('list and roundup pages get the list-inclusion ask with at most one proof point',()=>{
  const yes=['10 Best Free Image Compression Tools in 2026','The Ultimate List of Spaced Repetition Apps','Houseplant care resources list','Top 7 Houseplant Care Apps','Best Running Resources','12 useful calculators for runners'];
  const no=['Best Running Shoes for Flat Feet','The best way to clean grout: tools you need','How to start running','Pest tips for renters'];
  for(const t of yes)assert.equal(isListPage({title:t}),true,t);
  for(const t of no)assert.equal(isListPage({title:t}),false,t);
  assert.equal(isListPage({title:'How to start running',list_page:{items:14,title:'Running links'}}),true,'the inflow track marks list pages directly');
  assert.equal(isListPage({kind:'mention',title:'Best running tools'}),false,'a mention is always a thank-you');
  const p={id:'l',title:'15 Best Running Apps and Tools for Beginners',author:'Sam Lee',fit_section:'Shoe tools'};
  const out=templatePitch(p,asset,{senderName:'Alex',site});
  assert.deepEqual(out,listInclusionPitch(p,asset,{senderName:'Alex',site}));assert.equal(out.variant,'template:list_inclusion');
  assert.match(out.body,/Would you consider adding Running Shoe Finder to your "Shoe tools" section in "15 Best Running Apps and Tools for Beginners"\? It is a free interactive tool \(no sign-up needed\)\./);
  assert.deepEqual(out.facts_used,[TOOL]);assert.doesNotMatch(out.body,/data tables|authoritative|Answer six questions/,'one proof point, nothing else');
  assert.doesNotMatch(out.body,/already links to your article/,'never claimed without our own crawl saying so');
  assert.doesNotMatch(out.body,BANNED);assert.deepEqual(urls(out.body),[asset.url]);
  const named=listInclusionPitch({id:'m',title:'Page title',list_page:{title:'Running tools we use',items:9}},{...asset,interactive:false,type:'reference',words:500,reasons:[]},{senderName:'Alex',site});
  assert.match(named.body,/to your list "Running tools we use"\?\n/,'no proof point when the page has no checkable fact');assert.deepEqual(named.facts_used,[]);
  const cited=listInclusionPitch({...p,cited_by_us:{our_url:'https://www.gearuptofit.com/guide/beginners/'}},asset,{senderName:'Alex',site});
  assert.match(cited.body,/Our page gearuptofit\.com\/guide\/beginners already links to your article\./);assert.deepEqual(urls(cited.body),[asset.url],'our other page is named, not linked');
});

test('a follow-up never presents a fact the first email stated: the honest nudge, or one unused fact',()=>{
  const p={title:'Resources for New Runners',author:'Jane Doe',fit_section:'Choosing shoes'};
  const legacy=followupPitch(p,asset,{senderName:'Alex',site,subject:'Re: Suggestion'});
  assert.equal(legacy.variant,'template:followup_nudge');assert.deepEqual(legacy.facts_used,[]);
  assert.match(legacy.body,/^Hi Jane, just checking whether you'd consider adding Running Shoe Finder to your "Choosing shoes" section in "Resources for New Runners"\. Happy to send anything you need\.\n\nhttps:\/\/gearuptofit\.com\/shoe-finder\/\n\nBest,\nAlex\ngearuptofit\.com\n\nP\.S\. Not relevant/);
  assert.equal(legacy.subject,'Re: Suggestion');assert.doesNotMatch(legacy.body,BANNED);
  const fact=followupPitch({...p,facts_used:[TOOL]},asset,{senderName:'Alex',site});
  assert.equal(fact.variant,'template:followup_fact');assert.deepEqual(fact.facts_used,[TABLES]);assert.match(fact.body,/It includes 2 data tables\. Happy to send/);
  const all=followupPitch({...p,facts_used:[TOOL,TABLES]},asset,{senderName:'Alex',site});
  assert.equal(all.variant,'template:followup_nudge');assert.doesNotMatch(all.body,/data tables|interactive tool/);
  // A fact stated in other words (an AI pitch) counts as stated: "cites 12 sources" is not offered again.
  assert.equal(unusedFact({facts_used:['Cites 12 authoritative sources']},{...asset,interactive:false,words:500,type:'reference',reasons:['Cites 12 authoritative sources']}),null);
  assert.equal(unusedFact({facts_used:[]},asset),TOOL);assert.equal(unusedFact({},asset),null,'unrecorded facts: all count as stated');
  const list=followupPitch({title:'Top 7 Houseplant Care Apps',facts_used:[TOOL,TABLES]},asset,{senderName:'Alex',site});
  assert.match(list.body,/adding Running Shoe Finder to your list "Top 7 Houseplant Care Apps"\./);
  const mention=followupPitch({kind:'mention',title:'Pest tips'},asset,{senderName:'Alex',site});
  assert.match(mention.body,/turning the mention of Running Shoe Finder in "Pest tips" into a link\./);
  assert.equal(reSubject('Re: x'),'Re: x');assert.equal(reSubject('Hello\nthere'),'Re: Hello there');
  assert.equal(followupPitch({title:'X',last_subject:'Resource for you'},asset,{senderName:'Alex'}).subject,'Re: Resource for you');
});

test('facts are counted generously when an AI email states them in its own words',()=>{
  const facts=[...assetFacts(asset),'Cites 12 authoritative sources','Original survey data'];
  assert.deepEqual(factsIn('Our finder is free and needs no sign-up. It has two comparison tables.',facts),[TOOL,TABLES]);
  assert.deepEqual(factsIn('It draws on 12 published studies and an original survey.',facts),['Cites 12 authoritative sources','Original survey data']);
  assert.deepEqual(factsIn('',facts),[]);
});

test('validation rejects stock openers, flattery, link swaps and long or false follow-ups',()=>{
  const body=`Hi there, I'm writing from gearuptofit.com. ${'Some words here. '.repeat(14)} ${asset.url}\n\nBest,\nAlex`;
  assert.equal(pitchProblem({subject:'A shoe finder for you',body},asset),null);
  assert.equal(pitchProblem({subject:'A shoe finder for you',body:'I hope this finds you well. '+body},asset),'cliche');
  assert.equal(pitchProblem({subject:'A shoe finder for you',body:body+' I love your blog.'},asset),'cliche');
  assert.equal(pitchProblem({subject:'A shoe finder for you',body:body+' Happy to do a link exchange.'},asset),'offer_not_allowed');
  assert.equal(followupProblem({body:'Hi there, just checking. '+asset.url}),null);
  assert.equal(followupProblem({body:'One detail I didn\'t mention: it is free.'}),'followup_claim');
  assert.equal(followupProblem({body:'word '.repeat(80)}),'followup_too_long');
});

const completion=content=>new Response(JSON.stringify({choices:[{message:{content}}]}),{status:200,headers:{'content-type':'application/json'}});
const modelList=()=>new Response(JSON.stringify({data:[{id:'fixture-chat-70b'}]}),{headers:{'content-type':'application/json'}});
const writerWith=(answer,seen=[])=>new PitchWriter({senderName:'Default Name',providers:aiProviders({GROQ_API_KEY:'k'}),
  fetchImpl:async(u,o)=>{if(String(u).endsWith('/models'))return modelList();const req=JSON.parse(o.body);seen.push({system:req.messages[0].content,facts:JSON.parse(req.messages[1].content.replace(/^[^\n]*\n/,''))});return completion(answer)}});
const SIG='\n\nBest,\nSam\ngearuptofit.com\n\nP.S. Not relevant for you? Just reply "no" and I won\'t email again.';

test('AI follow-ups: same thread subject, short, honest; a long or false answer falls back to the template',async()=>{
  const p={id:'f',title:'Resources for New Runners',author:'Jane Doe',facts_used:[TOOL],page_url:'https://pub.example/r'};
  const good=`Subject: anything\n\nHi Jane, just checking whether you'd consider adding Running Shoe Finder to Resources for New Runners. It includes 2 data tables. Happy to send anything you need.\n\n${asset.url}${SIG}`;
  const seen=[];const w=writerWith(good,seen);
  const out=await w.write(p,asset,site,{situation:'followup',senderName:'Sam',subject:'Re: A free tool for your page'});
  assert.equal(out.writer,'groq');assert.equal(out.variant,'ai:followup');assert.equal(out.subject,'Re: A free tool for your page','threading subject is forced');
  assert.deepEqual(out.facts_used,[TABLES]);
  const f=seen[0].facts;assert.equal(f.situation,'followup');assert.equal(f.new_fact,TABLES);assert.equal(f.reply_subject,'Re: A free tool for your page');assert.equal(f.sender.name,'Sam');
  assert.deepEqual(f.our_asset.facts,[TABLES],'only the unused fact is offered');assert.match(seen[0].system,/situation is "followup"/);assert.match(seen[0].system,/never write "I didn't mention"/);
  const liar=writerWith(`Subject: x\n\nHi Jane, one detail I didn't mention: it is a free interactive tool. Just checking whether you'd consider adding it to your page.\n\n${asset.url}${SIG}`);
  const t=await liar.write(p,asset,site,{situation:'followup',senderName:'Sam',subject:'Re: y'});
  assert.equal(t.writer,'template');assert.equal(t.variant,'template:followup_fact');assert.deepEqual(liar.reasons,{followup_claim:1});assert.equal(t.subject,'Re: y');
  const long=writerWith(`Subject: x\n\nHi Jane, ${'just checking in about the page once more. '.repeat(12)}\n\n${asset.url}${SIG}`);
  assert.equal((await long.write(p,asset,site,{situation:'followup',senderName:'Sam',subject:'Re: y'})).writer,'template');assert.deepEqual(long.reasons,{followup_too_long:1});
});

test('AI first pitches get the matched section text, the list framing, our citation and the per-site sender name',async()=>{
  const body=`I'm Sam from gearuptofit.com, a site about running shoes. Would you consider adding Running Shoe Finder to the "Shoe tools" section of your list of the best running apps? It is a free interactive tool with no sign-up.\n\n${asset.url}\n\nIf it fits, the entry could be "Running Shoe Finder" with that link.${SIG}`;
  const seen=[];const w=writerWith(`Subject: Running Shoe Finder for your list\n\n${body}`,seen);
  const p={id:'g',title:'15 Best Running Apps and Tools',fit_section:'Shoe tools',fit_excerpt:'x'.repeat(900),page_url:'https://pub.example/apps',cited_by_us:{our_url:'https://gearuptofit.com/guide/apps/'}};
  const out=await w.write(p,asset,site,{senderName:'Sam'});
  assert.equal(out.variant,'ai:list_inclusion');assert.deepEqual(out.facts_used,[TOOL]);
  const f=seen[0].facts;assert.equal(f.situation,'list_inclusion');assert.deepEqual(f.list,{name:'15 Best Running Apps and Tools',section:'Shoe tools'});
  assert.deepEqual(f.our_asset.facts,[TOOL],'at most one proof point for a list ask');assert.equal(f.editor_page.relevant_section_text.length,600);
  assert.deepEqual(f.cited_by_us,{our_page:'gearuptofit.com/guide/apps'});assert.equal(f.sender.name,'Sam');
  assert.match(seen[0].system,/situation is "list_inclusion"/);assert.match(seen[0].system,/No compliments/);assert.match(seen[0].system,/concrete proposed edit/);
  const plain=[];await writerWith(`Subject: x\n\n${body}`,plain).write({id:'h',title:'How to start running',page_url:'https://pub.example/start'},asset,site,{senderName:'Sam'});
  assert.equal(plain[0].facts.situation,'resource_suggestion');assert.equal(plain[0].facts.editor_page.relevant_section_text,null);assert.equal(plain[0].facts.cited_by_us,undefined,'never claimed without the crawl saying so');
  // Without an AI writer the template is signed with the per-site name too.
  const none=new PitchWriter({senderName:'Default Name'});
  assert.match((await none.write({id:'i',title:'How to start running'},asset,site,{senderName:'Sam'})).body,/Best,\nSam\ngearuptofit\.com/);
  assert.match((await none.write({id:'i',title:'How to start running'},asset,site)).body,/Best,\nDefault Name\n/);
});
