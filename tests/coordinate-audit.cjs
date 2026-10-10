/* Address audit for static regional restaurant coordinates.
 * Runs the existing public Kakao SDK in a browser under the Pages origin.
 * Does not write to the DB. Only verified road/building matches may be copied.
 */
'use strict';
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const rows=JSON.parse(fs.readFileSync(path.join(root,'restaurants.json'),'utf8')).rows;
const targets=rows.filter(r=>(r.lat==null||r.lng==null)&&['포항','충주'].includes(r.region));
const url='https://sejonghyun-spec.github.io/lunch-map-pages/';
(async()=>{
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{ }),args:['--no-sandbox']});
try{
 const ctx=await browser.newContext({viewport:{width:1200,height:880},ignoreHTTPSErrors:true});
 await ctx.route(url,r=>r.fulfill({contentType:'text/html',body:html}));
 await ctx.route(url+'restaurants.json',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({rows})}));
 await ctx.route(url+'awards.json',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({rows:[]})}));
 await ctx.route('https://script.google.com/**',r=>{
   const x=new URL(r.request().url()),callback=x.searchParams.get('callback');
   return r.fulfill({contentType:'application/javascript',body:callback&&/^[a-zA-Z0-9_]+$/.test(callback)?
    callback+'('+JSON.stringify({rows,commentsByKey:{},loadedAt:Date.now()})+');':''});
 });
 const page=await ctx.newPage();
 await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForFunction(()=>mapReady&&geocoder&&placesService,{timeout:60000});
 const result=await page.evaluate(async targets=>{
   const normalize=s=>String(s||'').toLowerCase().replace(/경상북도/g,'경북').replace(/충청북도/g,'충북')
     .replace(/경상남도/g,'경남').replace(/충청남도/g,'충남').replace(/\s+/g,' ').trim();
   const addressKey=s=>{
     const str=normalize(s);const city=/포항/.test(str)?'포항':/충주/.test(str)?'충주':'';
     const match=str.match(/([가-힣0-9·]+(?:대로|로|길))\s*(\d+(?:-\d+)?)(?!\d)/);
     return city&&match?city+'|'+match[1]+'|'+match[2]:'';
   };
   const output=[];
   for(const target of targets){
     const geocoded=await new Promise(resolve=>{
       const timeout=setTimeout(()=>resolve({status:'TIMEOUT',rows:[]}),6000);
       geocoder.addressSearch(target.address,(r,status)=>{clearTimeout(timeout);resolve({status,rows:Array.isArray(r)?r:[]});});
     });
     const matched=geocoded.rows.filter(r=>{
       const addr=[r.road_address?.address_name,r.address?.address_name,r.address_name].filter(Boolean);
       return addr.some(x=>addressKey(x)&&addressKey(x)===addressKey(target.address));
     });
     const g=matched.length===1?matched[0]:null;
     output.push({name:target.name,region:target.region,address:target.address,
       status:geocoded.status,key:addressKey(target.address),candidateCount:geocoded.rows.length,
       matchedCount:matched.length,lat:g?Number(g.y):null,lng:g?Number(g.x):null,
       kakaoRoad:g?.road_address?.address_name||'',kakaoAddress:g?.address?.address_name||'',
       reviewed:g?'Kakao geocoder exact road/building number':'UNVERIFIED'});
     await new Promise(resolve=>setTimeout(resolve,140));
   }
   return output;
 },targets);
 console.log('GEOCODE_AUDIT_START');
 result.forEach(x=>console.log(JSON.stringify(x)));
 console.log('GEOCODE_AUDIT_END');
 console.log('Summary confirmed='+result.filter(r=>r.lat!=null).length+' missing='+result.filter(r=>r.lat==null).length);
}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
