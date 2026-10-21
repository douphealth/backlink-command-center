import test from 'node:test';
import assert from 'node:assert/strict';
import {eligible,sitemapLocs,discoverSitemapUrls} from '../../scripts/sitemap-discovery.mjs';
test('sitemaps accept only first-party safe article URLs',()=>{
 assert.equal(eligible('https://gearuptofit.com/shoe-finder/','gearuptofit.com'),true);
 for(const url of ['https://evil.example/post','http://gearuptofit.com/post','https://gearuptofit.com/privacy/','https://user:pass@gearuptofit.com/post'])assert.equal(eligible(url,'gearuptofit.com'),false);
});
test('XML discovery stays bounded and same-site',async()=>{
 const fetchImpl=async url=>new Response('<urlset><url><loc>https://gearuptofit.com/guide-a/</loc></url><url><loc>https://external.example/bad/</loc></url></urlset>',{headers:{'content-type':'application/xml'},status:200});
 const r=await discoverSitemapUrls({domain:'gearuptofit.com'},{fetchImpl,limit:2});
 assert.deepEqual(r.urls,['https://gearuptofit.com/guide-a/']);
 assert.equal(sitemapLocs('<url><loc>https://test.example/a?x=1&amp;y=2</loc></url>')[0],'https://test.example/a?x=1&y=2');
});
