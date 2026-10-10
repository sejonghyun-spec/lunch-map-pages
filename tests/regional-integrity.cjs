/* Lightweight regional integrity regression tests: node tests/regional-integrity.cjs
 * No external services or browser required.
 */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const rows=JSON.parse(fs.readFileSync(path.join(root,'restaurants.json'),'utf8')).rows;
const scripts=[...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(x=>x[1]).filter(x=>x.trim());
scripts.forEach((source,index)=>{
  assert.doesNotThrow(()=>new Function(source),'inline script '+index);
});
const code=scripts[scripts.length-1];

function extract(begin,end){
  const start=code.indexOf(begin);
  assert.ok(start>=0,'Missing '+begin);
  const next=code.indexOf(end,start+begin.length);
  assert.ok(next>start,'Missing end of '+begin);
  return code.slice(start,next);
}
function validCoords(row){
  return Number.isFinite(Number(row.lat))&&Number.isFinite(Number(row.lng))&&
    Number(row.lat)>=33&&Number(row.lat)<=39&&Number(row.lng)>=124&&Number(row.lng)<=132;
}
function mockContext(records,options={}){
  const state={
    allData:records,
    activeRegionKey:'pohang',
    placesService:{},
    enrichQueueRunning:false,enrichQueuePending:false,
    regionKeyForRow:row=>row.region==='포항'?'pohang':row.region==='충주'?'chungju':'hapjeong',
    hasValidCoords:validCoords,
    enrichOneRow:options.enrichOneRow||async row=>{row.lat=row.region==='포항'?35.98:37.01;row.lng=row.region==='포항'?129.37:127.94;return true;},
    buildFilters:()=>{state.filterCalls=(state.filterCalls||0)+1;},
    render:()=>{state.renderCalls=(state.renderCalls||0)+1;},
    setTimeout
  };
  vm.runInNewContext(
    extract('async function hydrateMissingRows(){','\nfunction applyDbRows(')+
      '\nthis.hydrateMissingRows=hydrateMissingRows;',state
  );
  return state;
}
async function main(){
  const counts=rows.reduce((o,row)=>(o[row.region]=(o[row.region]||0)+1,o),{});
  assert.equal(counts['합정'],53);
  assert.equal(counts['포항'],11);
  assert.equal(counts['충주'],7);
  assert.match(code,/allDisplayRestaurants\(\)\.filter\(row=>regionKeyForRow\(row\)===activeRegionKey\)/);
  assert.match(code,/if\(validRows\.length===1&&fit\)/);
  assert.match(code,/if\(!validRows\.length\)\{[\s\S]{0,300}if\(fit\)\{/);

  const canonical={row:55,region:'포항',name:'테스트 식당',address:'포항시',lat:null,lng:null};
  const ctx=mockContext([canonical]);
  await ctx.hydrateMissingRows();
  assert.ok(validCoords(canonical),'Enrichment must mutate canonical rows');
  assert.ok(ctx.renderCalls>0,'Enrichment must redraw map/list');

  let resume;
  const src=[
    {row:55,region:'포항',name:'포항 테스트',address:'포항시',lat:null,lng:null},
    {row:65,region:'충주',name:'충주 테스트',address:'충주시',lat:null,lng:null}
  ];
  const sw=mockContext(src,{enrichOneRow:async row=>{
    if(row.region==='포항')await new Promise(resolve=>{resume=resolve;});
    row.lat=row.region==='포항'?35.98:37.01;
    row.lng=row.region==='포항'?129.37:127.94;
    return true;
  }});
  const first=sw.hydrateMissingRows();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(typeof resume,'function');
  sw.activeRegionKey='chungju';
  await sw.hydrateMissingRows();
  assert.equal(sw.enrichQueuePending,true);
  resume();
  await first;
  await new Promise(resolve=>setTimeout(resolve,400));
  assert.ok(validCoords(src[1]),'Queued second region must be enriched');
  assert.equal(sw.enrichQueueRunning,false);
  assert.equal(sw.enrichQueuePending,false);

  const c=vm.createContext({
    Promise,
    kakao:{maps:{LatLng:class{constructor(lat,lng){this.lat=lat;this.lng=lng;}},services:{SortBy:{DISTANCE:'distance'},Status:{OK:'OK'}}}},
    regionCenterForRow:()=>({lat:35.98,lng:129.37}),
    regionKeyForRow:row=>String(row.address||'').includes('포항')?'pohang':
      String(row.address||'').includes('충주')?'chungju':'hapjeong',
    bestExactKakaoPlace:(_row,data)=>data[0]||null,
    scoreKakaoPlaceMatch:(row,p)=>p.place_name===row.name?120:0,
    distanceMeters:(a,b)=>Math.sqrt(Math.pow((a.lat-b.lat)*111000,2)+Math.pow((a.lng-b.lng)*92000,2)),
    placesService:null
  });
  vm.runInContext(extract('function searchPlaceForRow(row){','\nconst kakaoPlaceUrlCache'),c);
  const target={name:'포항 테스트',region:'포항',address:'경상북도 포항시 남구',lat:null,lng:null};
  async function tryPlace(place){
    c.placesService={keywordSearch:(_q,cb)=>cb([place],'OK')};
    return c.searchPlaceForRow(target);
  }
  assert.equal(await tryPlace({place_name:'다른 식당',road_address_name:'포항시',y:35.98,x:129.37}),null);
  assert.equal(await tryPlace({place_name:'포항 테스트',road_address_name:'충주시',y:37.01,x:127.94}),null);
  assert.equal(await tryPlace({place_name:'포항 테스트',road_address_name:'포항시',y:36.5,x:129.37}),null);
  const okay={place_name:'포항 테스트',road_address_name:'포항시 남구',y:35.98,x:129.37};
  assert.equal(await tryPlace(okay),okay);
  console.log('PASS regional data, canonical enrichment, region handoff, and Kakao match guards');
}
main().catch(err=>{console.error(err);process.exitCode=1;});
