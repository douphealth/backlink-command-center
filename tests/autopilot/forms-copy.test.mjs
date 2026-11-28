// The contact-form message itself (forms.mjs): length, one ask, honest 3-way offer, the closing opt-out sentence,
// the reply address, and which form pages count as an editorial route.
import test from 'node:test';
import assert from 'node:assert/strict';
import {composeForm,formTemplate,formProblem,formOptOut,formPageVerdict,validOffer,wordCount,writesForms,FORM_OPT_OUT,FORM_WORDS} from '../../scripts/autopilot/forms.mjs';
import * as pitch from '../../scripts/autopilot/pitch.mjs';
import {classifyReply} from '../../scripts/autopilot/mail.mjs';

const SITES=[{domain:'gearuptofit.com',topic:'running shoes'},{domain:'gearuptogrow.com',topic:'study skills spaced repetition'}],SITE=SITES[0],FROM='owner@gmail.com';
const ASSET={url:'https://gearuptofit.com/shoe-finder/',title:'Shoe Finder',type:'interactive_tool',interactive:true,description:'Answer six questions and get running shoe picks matched to your gait, weight and mileage.'};
const P={id:'p1',site:'gearuptofit.com',domain:'runblog.com',page_url:'https://runblog.com/flat-feet/',title:'What are the best running shoes for flat feet?',author:'Maria Lopez'};
const OFFER={partner_site:'gearuptogrow.com',partner_page:'https://gearuptogrow.com/learning/spaced-repetition/',partner_title:'Spaced repetition guide',their_url:'https://runblog.com/flat-feet/',their_title:'Best running shoes for flat feet',score:0.7};
const compose=(p=P,asset=ASSET,o={})=>composeForm(p,asset,SITE,{senderName:'Alex',from:FROM,...o});
const urls=b=>b.match(/https?:\/\/\S+/g)||[];

test('every message: 60-100 words, a subject, one ask, our page as the only URL, the opt-out sentence and our Gmail address to reply to',async()=>{
  const long={...ASSET,title:'The Complete and Extremely Detailed Running Shoe Finder for Every Single Kind of Runner',description:'A long description of running shoes, gait, weight, mileage and everything else that matters to runners when they pick a pair.'};
  const cases=[[P,ASSET],[{...P,author:''},ASSET],[{...P,author:'admin@runblog.com'},ASSET],[{...P,title:'Shoes'},{url:'https://gearuptofit.com/x/',title:'X'}],
    [{...P,list_page:{items:12,title:'Best running tools'}},ASSET],[{...P,kind:'mention',author:''},{url:'https://gearuptofit.com/',title:'GearUpToFit'}],
    [{...P,title:'An extraordinarily long article title about running shoes for people who have flat feet and overpronation issues'},long],
    [{...P,title:'Best trail shoes [2026 Update] {draft}'},ASSET]];
  for(const [p,asset] of cases)for(const offer of [null,OFFER]){
    const m=await compose(p,asset,{offer});
    assert.ok(m,`a message for ${p.title}`);const n=wordCount(m.body);
    assert.ok(n>=FORM_WORDS[0]&&n<=FORM_WORDS[1],`${n} words`);
    assert.equal(formProblem(m,{asset,offer:m.offer,from:FROM}),null);
    assert.deepEqual(urls(m.body),[asset.url]);
    assert.ok(m.body.includes(formOptOut()));assert.match(m.body,/\nReply to: owner@gmail\.com$/);
    assert.doesNotMatch(m.body,/P\.S\.|reply "no"|\[|\{/);
    assert.match(m.body,p.author==='Maria Lopez'?/^Hi Maria,\n/:/^Hi there,\n/,'greeted by first name or "there", never by an address');
    assert.ok(m.subject.length>=8&&m.subject.length<=90);
    assert.equal(m.writer,'template');assert.equal(m.variant,m.offer?'template:form_link_exchange':'template:form');
    if(offer)assert.ok(m.offer,'the offer fits in every case above');
  }
  const m=await compose();
  assert.equal(m.subject,'Suggestion for "What are the best running shoes for flat feet?"');
  assert.match(m.body,/I'm Alex from gearuptofit\.com, a site about running shoes\. Would you consider adding Shoe Finder to "What are the best running shoes for flat feet\?"\?/);
  assert.match(m.body,/The edit would be one link, with "Shoe Finder" as the link text\./);
  const list=await compose({...P,list_page:{items:12,title:'Best running tools'}});assert.match(list.body,/to your list "Best running tools"\?/);assert.equal(list.subject,'A suggestion for "Best running tools"');
  const mention=await compose({...P,kind:'mention'},{url:'https://gearuptofit.com/',title:'GearUpToFit'});assert.match(mention.body,/Thanks for mentioning GearUpToFit in /);assert.doesNotMatch(mention.body,/The edit would be/);
});

test('the 3-way offer says C is a separate site I run, names its page without linking it, and never mentions payment or a placed link',async()=>{
  const m=await compose(P,ASSET,{offer:OFFER});
  assert.match(m.body,/If you add it, I'll link to your "Best running shoes for flat feet" from my related page "Spaced repetition guide" on gearuptogrow\.com, a separate site I run\./);
  assert.doesNotMatch(m.body,/\b(?:pay|paid|fee|price|already linked|have linked)\b/i);
  const mention=await compose({...P,kind:'mention'},{url:'https://gearuptofit.com/',title:'GearUpToFit'},{offer:{...OFFER,partner_title:'',their_title:''}});
  assert.match(mention.body,/If you link it, I'll link to your article from a related page on gearuptogrow\.com, a separate site I run\./);
  // validOffer: C must be one of ours, never A, its page on C and their article on their own domain.
  assert.deepEqual(validOffer({...OFFER,extra:'x'},P,SITES),OFFER);
  for(const bad of [{...OFFER,partner_site:'gearuptofit.com',partner_page:'https://gearuptofit.com/a/'},{...OFFER,partner_site:'other.com',partner_page:'https://other.com/a/'},
    {...OFFER,partner_page:'https://elsewhere.com/a/'},{...OFFER,their_url:'https://notrunblog.com/a/'},null,'offer'])assert.equal(validOffer(bad,P,SITES),null);
  assert.equal(validOffer(OFFER,P,[]),null,'without the list of our sites nothing can be proven ours');
});

test('formProblem rejects what the owner\'s rules forbid',()=>{
  const ok=formTemplate(P,ASSET,SITE,{senderName:'Alex',from:FROM});
  assert.equal(formProblem(ok,{asset:ASSET,from:FROM}),null);
  const bad=(edit,o={})=>formProblem({...ok,...edit},{asset:ASSET,from:FROM,...o});
  assert.equal(bad({body:ok.body.replace(ASSET.url,`${ASSET.url} https://gearuptogrow.com/`)}),'extra_url');
  assert.equal(bad({body:ok.body.replace(ASSET.url,'https://gearuptofit.com/other/')}),'wrong_url');
  assert.equal(bad({body:ok.body.replace(formOptOut(),'Thanks.')}),'opt_out_missing');
  assert.equal(bad({body:ok.body.replace('Reply to: owner@gmail.com','Reply to: someone@else.com')}),'reply_address');
  assert.equal(bad({body:ok.body.replace('Hi Maria,','Hi editor@runblog.com,')}),'reply_address');
  assert.equal(bad({body:ok.body.replace('Happy to send anything you need.','Could we pay you for it? We could.')}),'more_than_one_ask');
  assert.equal(bad({body:ok.body.replace('Happy to send anything you need.','We would happily pay a small fee.')}),'payment_mentioned');
  assert.equal(bad({body:ok.body.replace('Happy to send anything you need.','Our page already links to your article.')}),'claims_link_placed');
  assert.equal(bad({body:ok.body.replace('Happy to send anything you need.','In return, a link from my other site.')}),'exchange_without_offer');
  assert.equal(bad({},{offer:OFFER}),'exchange_not_stated');
  assert.equal(bad({body:ok.body+' extra'.repeat(40)}),'too_long');
  assert.equal(bad({body:`Hi there,\n\n${ASSET.url}\n\n${formOptOut()}\nReply to: ${FROM}`}),'too_short');
  assert.equal(bad({subject:'Hi'}),'subject_length');
  assert.equal(bad({body:ok.body.replace('Happy to send','Happy to send [your name]')}),'placeholder_or_markup');
});

test('the closing sentence is the copy track\'s natural opt-out once pitch.mjs exports it, and replies to it are still read as opt-outs',()=>{
  const theirs=typeof pitch.OPT_OUT==='string'&&!/reply\s+["“]?no\b|^p\.?\s?s\.?\b/i.test(pitch.OPT_OUT.trim())?pitch.OPT_OUT.replace(/\s+/g,' ').trim():null;
  assert.equal(formOptOut(),theirs||FORM_OPT_OUT);
  assert.equal(FORM_OPT_OUT,"If it's not a fit, just say so and I won't follow up.");
  assert.doesNotMatch(formOptOut(),/P\.S\.|reply "no"/);
  for(const body of ['No thanks.','not a fit for us','Please remove us from your list.'])assert.equal(classifyReply({from:'ed@runblog.com',subject:'Shoe Finder',body}),'negative',body);
});

test('form pages: a do-not-pitch notice, a sales-intake or support-only form, or no form at all is not an editorial route',()=>{
  const page=(extra,form='<input name="name"><input name="email"><textarea name="message"></textarea>')=>`<html><body>${extra}<form method="post">${form}</form></body></html>`;
  assert.deepEqual(formPageVerdict(page('<p>Questions or suggestions? Write to us.</p>'),'https://runblog.com/contact/'),{ok:true,why:null});
  // The site's own promises in a newsletter box are not a do-not-pitch notice.
  for(const promise of ['Join the newsletter. We never spam.',"We don't spam you, ever.",'We will not spam you.'])assert.equal(formPageVerdict(page(`<p>${promise}</p>`)).ok,true,promise);
  for(const notice of ['Please, no solicitations.','No SEO pitches or link requests.',"Please don’t pitch us.",'Do not pitch us here.','Please never spam this form.','Do not use this form to sell services.',
    'This form is not for advertising inquiries.','We do not accept guest posts or sponsored content.','Unsolicited pitches will be ignored.','We are not accepting link insertions.',
    '<script>var x="no solicitations"</script><p>Hello</p>'])
    assert.equal(formPageVerdict(page(`<p>${notice}</p>`)).why,notice.startsWith('<script')?null:'no_solicitation_notice',notice);
  assert.equal(formPageVerdict(page('<p>This form is for customer support requests only.</p>')).why,'not_editorial_form');
  assert.equal(formPageVerdict(page('','<input name="email"><input name="project_budget"><textarea name="m"></textarea>')).why,'sales_form');
  assert.equal(formPageVerdict(page('','<label>Request a quote</label><input name="email"><textarea name="m"></textarea>')).why,'sales_form');
  assert.equal(formPageVerdict(page(''),'https://runblog.com/advertise/').why,'sales_form');
  assert.equal(formPageVerdict(page('','<textarea name="comment"></textarea>')).why,'no_form','a comment form is not a contact form');
  assert.equal(formPageVerdict('<html><body><p>Email us.</p></body></html>').why,'no_form');
});

test('only a writer that says it writes for forms is asked, and its output must pass the same rules',async()=>{
  const pw=new pitch.PitchWriter({senderName:'Alex'});if(!pw.channels)assert.equal(writesForms(pw),false,'the email pitch writer does not write form copy');
  let asked=0;const plain={write:async()=>{asked++;return {subject:'x',body:'y'}}};
  assert.equal((await compose(P,ASSET,{writer:plain})).writer,'template');assert.equal(asked,0,'an email writer is never asked for form copy');
  const good=formTemplate(P,ASSET,SITE,{senderName:'Alex',from:FROM});let args;
  const formWriter={channels:['form'],write:async(...a)=>{args=a;return {...good,writer:'groq',variant:'ai:form'}}};
  const m=await compose(P,ASSET,{writer:formWriter,offer:null});
  assert.equal(m.writer,'groq');assert.equal(m.variant,'ai:form');assert.equal(args[3].channel,'form');assert.equal(args[3].exchange,null);assert.equal(args[3].from,FROM);
  const stats={},badWriter={channels:new Set(['form']),write:async()=>({subject:'A good subject line',body:good.body.replace(formOptOut(),'Bye.')})};
  const fallback=await compose(P,ASSET,{writer:badWriter,stats});
  assert.equal(fallback.writer,'template');assert.deepEqual(stats.writer_rejected,{opt_out_missing:1});
});
