/* Run with Playwright installed: node tests/sidebar-regression.cjs
 * Optional: CHROMIUM_PATH, HTTPS_PROXY, QA_OUTPUT_DIR.
 * The real Kakao SDK runs on the Pages origin; HTML, restaurant data and all
 * Apps Script traffic are intercepted. No comments or suggestions are sent.
 */
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const data=JSON.parse(fs.readFileSync(path.join(root,'restaurants.json'),'utf8'));
const origin='https://sejonghyun-spec.github.io';
const url=origin+'/lunch-map-pages/';
const key=x=>x.name.trim()+'||'+(x.address||'').trim();
const bundle=Object.fromEntries(data.rows.map(x=>[key(x),[]]));
bundle[key(data.rows[0])]=[{id:'qa-1',nickname:'검증',comment:'테스트 후기',helpfulCount:1},{id:'qa-2',nickname:'검증',comment:'두 번째 테스트 후기'}];
const results=[];
let browser,page,errors=[],apiRequests=[];
async function check(name,fn){await fn();results.push(name);console.log('PASS',name);}
async function state(fn,arg){return page.evaluate(fn,arg);}
async function reset(){await state(()=>{clearSelectedRows();showAll();});await page.waitForTimeout(160);}
async function choose(id,value){await page.selectOption('#'+id,value);}
async function menu(id){await page.locator('#mobileMenuButton').click();await page.locator('#'+id).click();await page.waitForTimeout(280);}
async function shot(name){if(process.env.QA_OUTPUT_DIR)await page.screenshot({path:path.join(process.env.QA_OUTPUT_DIR,name+'.png')});}
(async()=>{
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),...(process.env.HTTPS_PROXY?{proxy:{server:process.env.HTTPS_PROXY}}:{}),args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:1440,height:1000},ignoreHTTPSErrors:true,permissions:['geolocation'],geolocation:{latitude:37.55,longitude:126.914}});
 await context.route(url,r=>r.fulfill({contentType:'text/html',body:html}));
 await context.route(url+'restaurants.json',r=>r.fulfill({contentType:'application/json',body:JSON.stringify(data)}));
 await context.route('https://script.google.com/**',r=>{
   const u=new URL(r.request().url());const mode=u.searchParams.get('mode');apiRequests.push(mode||r.request().method());
   const callback=u.searchParams.get('callback');
   if(callback&&/^[a-zA-Z0-9_]+$/.test(callback))return r.fulfill({contentType:'application/javascript',body:callback+'('+JSON.stringify(mode==='data'?{rows:data.rows,commentsByKey:bundle}:mode==='comments'?{comments:bundle[u.searchParams.get('key')]||[]}:{authRequired:true})+');'});
   return r.fulfill({contentType:'text/html',body:'<!doctype html><title>Account connection test</title>'});
 });
 page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(url,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>mapReady&&markerByRow.size>0&&commentsPreloaded);
 await page.evaluate(()=>document.fonts.ready);
 await check('real Kakao SDK, initial rows, markers and result count',async()=>{
   const s=await state(()=>({cards:document.querySelectorAll('.card').length,rows:getRows().length,markers:markerByRow.size,label:document.getElementById('listSub').textContent}));
   assert.equal(s.cards,s.rows);assert.equal(s.markers,s.rows);assert.equal(s.label,s.rows+'곳');assert.ok(s.rows>40);
 });
 await check('all static DOM ids unique; event targets present',async()=>{
   const s=await state(()=>{const ids=[...document.querySelectorAll('[id]')].map(x=>x.id);return ids.filter((id,i)=>ids.indexOf(id)!==i)});assert.deepEqual(s,[]);
   const ids=[...html.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(m=>m[1]);
   const missing=await page.evaluate(ids=>ids.filter(id=>!document.getElementById(id)),ids);
   assert.deepEqual([...new Set(missing)].filter(id=>!['commentConnect','commentRetry','suggestLookupStatus','openNaverLink','openGoogleLink'].includes(id)),[]);
 });
 await check('theme selector defaults to Simple and switches all four themes',async()=>{
   assert.equal(await state(()=>document.documentElement.dataset.theme),'simple');
   assert.equal(await page.locator('[data-theme-option]').count(),4);
   for(const theme of ['night','editorial','bistro','simple']){
     await page.click('#themeButton');
     await page.click('[data-theme-option="'+theme+'"]');
     assert.equal(await state(()=>document.documentElement.dataset.theme),theme);
     assert.equal(await state(()=>localStorage.getItem('lunch-map-theme-v1')),theme);
     assert.equal(await page.locator('[data-theme-option="'+theme+'"]').getAttribute('aria-current'),'true');
   }
 });
 await check('search, four compact native selects, quick bar geometry',async()=>{
   assert.ok(await state(()=>{const boxes=[...document.querySelectorAll('.compact-filter')].map(x=>x.getBoundingClientRect());return boxes.every(b=>b.top===boxes[0].top&&b.width>60)&&document.getElementById('search').getBoundingClientRect().height>=48}));
 });
 await shot('desktop');
 for(const [label,term] of [['name','자성당'],['feature','쫄면'],['address','월드컵로']])await check('search by '+label,async()=>{
   await page.fill('#search',term);await page.waitForTimeout(180);assert.ok(await state(()=>getRows().length>0));assert.ok(await page.locator('.search-hit').count());await reset();
 });
 await check('empty search and reset',async()=>{await page.fill('#search','__no_restaurant__');await page.waitForTimeout(180);assert.equal(await page.locator('.card').count(),0);assert.equal(await page.locator('#listSub').textContent(),'0곳');await reset();});
 await check('multi-category selection and all categories',async()=>{
   await page.click('[data-category="한식"]');await page.click('[data-category="일식"]');assert.ok(await state(()=>selectedCategories.size===2&&getRows().every(x=>['한식','일식'].includes(x.category))));await reset();
 });
 for(const [id,values] of [['ratingFilter',['5','4','3']],['capacityFilter',['4','8','group']],['featureFilter',['waiting','reservation','room','group','fast']],['distanceFilter',['300','500','700','1000']]]){
   await check(id+' all options and active labels',async()=>{
     for(const value of values){await choose(id,value);assert.ok(await page.locator('#'+id).evaluate(el=>el.classList.contains('active')));assert.ok(await state(()=>document.querySelectorAll('.card').length===getRows().length));
       if(id==='ratingFilter')assert.ok(await page.evaluate(v=>getRows().every(x=>ratingScore(x)>=Number(v)),value));
       if(id==='distanceFilter')assert.ok(await page.evaluate(v=>getRows().every(x=>distanceFromSeahTower(x)<=Number(v)),value));
       if(id==='capacityFilter')assert.ok(await page.evaluate(v=>getRows().every(x=>v==='group'?isGroupFriendly(x):v==='8'?capacityMax(x)>=8:capacityMax(x)>=4||isGroupFriendly(x)),value));
       if(id==='featureFilter')assert.ok(await page.evaluate(v=>getRows().every(x=>matchesFeature(x,v)),value));
     }await reset();
   });
 }
 await check('quick rating filter synchronizes native select and aria-pressed',async()=>{await page.click('[data-chip="rating4"]');assert.equal(await page.inputValue('#ratingFilter'),'4');assert.equal(await page.getAttribute('[data-chip="rating4"]','aria-pressed'),'true');await reset();});
 await check('favorite toggle, favorites filter and map results stay synchronized',async()=>{
   await page.locator('.card-favorite').first().click();assert.equal(await page.locator('.card-favorite').first().getAttribute('aria-pressed'),'true');
   assert.ok(await state(()=>!commentPanel.classList.contains('open')));
   await page.click('[data-chip="favorites"]');assert.equal(await page.locator('.card').count(),1);
   await page.locator('.card-favorite').click();assert.equal(await page.locator('.card').count(),0);assert.equal(await state(()=>markerByRow.size),0);await reset();
 });
 await check('list hover highlights corresponding marker and clears',async()=>{
   await page.locator('.card').first().hover();assert.ok(await state(()=>markerByRow.get(Number(document.querySelector('.card').dataset.row)).content.classList.contains('list-hover')));
   await page.hover('#search');assert.ok(await state(()=>![...markerByRow.values()].some(x=>x.content.classList.contains('list-hover'))));
 });
 await check('marker hover highlights list and opens/closes preview',async()=>{
   assert.ok(await state(()=>{const item=[...markerByRow.values()][0];item.content.dispatchEvent(new MouseEvent('mouseenter'));const yes=document.querySelector('.card').classList.contains('map-hover');item.content.dispatchEvent(new MouseEvent('mouseleave'));return yes&&!document.querySelector('.card').classList.contains('map-hover')}));
 });
 await check('keyboard restaurant selection, detail placement, review cache, Kakao link',async()=>{
   await page.locator('.card-open').first().focus();await page.keyboard.press('Enter');await page.waitForTimeout(250);
   assert.ok(await state(()=>selectedRow===Number(document.querySelector('.card').dataset.row)&&document.querySelector('.card').classList.contains('active')&&commentPanel.classList.contains('open')));
   assert.equal(await page.locator('.card-review').first().textContent(),'후기 2');
   const panel=await page.locator('#commentPanel').boundingBox();assert.ok(panel.x>=430&&panel.x+panel.width<=1441);
   await page.waitForFunction(()=>document.getElementById('kakaoMapLink').href.includes('map.kakao.com'));
   await page.click('[data-detail-tab="reviews"]');assert.equal(await page.locator('.comment-item').count(),2);
   await shot('desktop-detail');await page.click('#commentClose');
 });
 await check('recent filter and selected marker',async()=>{
   await page.click('[data-chip="recent"]');assert.equal(await page.locator('.card').count(),1);await reset();
   await state(()=>[...markerByRow.values()][0].content.click());assert.equal(await page.locator('.card.active').count(),1);await page.click('#commentClose');
 });
 await check('current-map filter and full reset',async()=>{
   await page.click('[data-chip="map"]');assert.ok(await state(()=>mapOnlyMode&&getRows().every(isInCurrentMapBounds)));
   await page.click('#multiFilterReset');assert.ok(await state(()=>!mapOnlyMode&&!favoritesOnly&&!recentOnly&&ratingFilter==='all'));
 });
 for(const sort of ['rating','name','distance','default'])await check('sorting '+sort,async()=>{
   await page.click('#sortButton');await page.click('[data-sort="'+sort+'"]');
   assert.ok(await page.evaluate(s=>{const rows=getRows();return sortMode===s&&rows.every((x,i)=>!i||s==='default'||(s==='rating'?ratingScore(rows[i-1])>=ratingScore(x):s==='distance'?distanceFromSeahTower(rows[i-1])<=distanceFromSeahTower(x):rows[i-1].name.localeCompare(x.name,'ko')<=0))},sort));
 });
 await check('my location',async()=>{await page.click('#myLocation');await page.waitForTimeout(250);assert.ok(await state(()=>Math.abs(map.getCenter().getLat()-37.55)<0.0001));await reset();});
 await check('cached review updates preserve card node/scroll and issue no requests',async()=>{
   const before=apiRequests.length;
   assert.ok(await state(()=>{const list=document.getElementById('list');list.scrollTop=100;const top=list.scrollTop;const first=list.firstElementChild;const key=first.querySelector('.card-review').dataset.reviewKey;applyCommentBundle({[key]:[{comment:'cache test'}]});return first===list.firstElementChild&&top===list.scrollTop&&first.querySelector('.card-review').textContent==='후기 1'}));
   await page.waitForTimeout(100);assert.equal(apiRequests.length,before);await page.evaluate(b=>applyCommentBundle(b),bundle);
 });
 await check('no fabricated tags, missing rating, note escaping and aggregated rating count',async()=>{
   assert.deepEqual(await state(()=>cardFeatureParts({feature:'룸 없음'}).tags),['룸 없음']);
   assert.ok(await state(()=>{const a=aggregateRestaurantRows([{row:999,name:'검증',address:'주소',rating:5},{row:1000,name:'검증',address:'주소',rating:4}])[0];renderList([a]);return document.querySelector('.rating').textContent==='★ 4.5'&&document.querySelector('.card-evaluations').textContent==='평가 2'}));
   assert.ok(await state(()=>{renderList([{row:999,name:'검증',feature:'룸 없음',note:'<img src=x onerror=alert(1)>',capacity:'~'}]);return !document.querySelector('.card .rating')&&!document.querySelector('.card img')&&getComputedStyle(document.querySelector('.card-stats')).display==='none'&&document.querySelector('.card-feature').textContent.includes('<img')}));await reset();
 });
 await check('search autocomplete, quick action bar, clustering helpers, review insight and hours parser',async()=>{
   await page.setViewportSize({width:1440,height:900});await reset();
   await page.fill('#search','자');await page.waitForTimeout(80);
   assert.ok(await page.locator('#searchSuggestions').evaluate(el=>el.classList.contains('open')));
   assert.ok(await page.locator('#searchSuggestions .search-suggestion').count()>0);
   await page.fill('#search','');await page.waitForTimeout(80);
   const firstRow=await state(()=>getRows()[0]?.row);
   assert.ok(firstRow);
   await state(row=>selectRow(row,false,false),firstRow);await page.waitForTimeout(100);
   assert.ok(await page.locator('#mapQuickBar').isVisible());
   assert.ok((await page.textContent('#mapQuickName')).trim().length>0);
   assert.ok(await state(()=>typeof clusterGroupsForMap==='function'&&typeof operatingInfo==='function'&&typeof scheduleFromNoteForWeekday==='function'));
   assert.deepEqual(await state(()=>{const x=operatingInfo({hours:'11:00-21:00'});return [x.text,!!x.status];}),['11:00-21:00',true]);
   assert.deepEqual(await state(()=>{
     const note='월요일 11:00-21:00 브레이크 15:00-16:00 라스트오더 20:30 | 화요일 12:00-20:00 | 일요일 휴무';
     const mon=scheduleFromNoteForWeekday(note,0),tue=scheduleFromNoteForWeekday(note,1),sun=scheduleFromNoteForWeekday(note,6);
     return [[mon.hours,mon.breakTime,mon.lastOrder,mon.closed],[tue.hours,tue.closed],[sun.hours,sun.closed]];
   }),[['11:00-21:00','15:00-16:00','20:30',false],['12:00-20:00',false],['',true]]);
   assert.ok(await state(()=>typeof weeklyOperatingSchedule==='function'&&typeof renderWeeklyHours==='function'&&typeof relevantLastOrder_==='function'&&typeof splitDayLastOrders_==='function'));
   const weeklyHours=await state(()=>{
     const row={
       hours:'11:00-21:00',
       breakTime:'15:00-16:00',
       lastOrder:'20:30',
       closedDays:'일요일 정기휴무',
       hoursNote:'월요일 11:00-21:00 브레이크 15:00-16:00 라스트오더 20:30 | 화요일 12:00-20:00 | 일요일 휴무'
     };
     return {rows:weeklyOperatingSchedule(row),html:renderWeeklyHours(row)};
   });
   assert.equal(weeklyHours.rows.length,7);
   assert.equal(weeklyHours.rows[0].hours,'11:00-21:00');
   assert.equal(weeklyHours.rows[1].hours,'12:00-20:00');
   assert.equal(weeklyHours.rows[1].breakTime,'');
   assert.equal(weeklyHours.rows[1].lastOrder,'');
   assert.equal(weeklyHours.rows[6].closed,true);
   assert.ok(weeklyHours.html.includes('detail-hours-disclosure'));
   assert.ok(weeklyHours.html.includes('라스트오더'));
   assert.ok(weeklyHours.html.includes('휴무'));

   const jasung=await state(()=>{
     const row={
       hours:'11:00-20:00',
       breakTime:'15:00-16:30',
       lastOrder:'19:30',
       closedDays:'',
       hoursNote:'월요일 11:00-20:00 브레이크 15:00-16:30 라스트오더 14:30'
     };
     const rows=weeklyOperatingSchedule(row);
     return {
       mon:rows[0],tue:rows[1],
       at1300:relevantLastOrder_(rows[0].lastOrders,13*60),
       at1445:relevantLastOrder_(rows[0].lastOrders,14*60+45),
       at1530:relevantLastOrder_(rows[0].lastOrders,15*60+30),
       at1800:relevantLastOrder_(rows[0].lastOrders,18*60)
     };
   });
   assert.deepEqual(jasung.mon.lastOrders,['14:30','19:30']);
   assert.equal(jasung.mon.lastOrderText,'14:30 · 19:30');
   assert.deepEqual(jasung.tue.lastOrders,['19:30']);
   assert.equal(jasung.at1300,'14:30');
   assert.equal(jasung.at1445,'19:30');
   assert.equal(jasung.at1530,'19:30');
   assert.equal(jasung.at1800,'19:30');

   const duplicateLastOrders=await state(()=>weeklyOperatingSchedule({
     hours:'11:00-20:00',
     breakTime:'15:00-16:30',
     lastOrder:'14:30, 19:30',
     closedDays:'',
     hoursNote:'월요일 11:00-20:00 브레이크 15:00-16:30 라스트오더 14:30'
   }));
   assert.deepEqual(duplicateLastOrders[0].lastOrders,['14:30','19:30']);
   assert.deepEqual(duplicateLastOrders[1].lastOrders,['14:30','19:30']);

   const invalidGeneric=await state(()=>weeklyOperatingSchedule({
     hours:'11:00-21:00',
     breakTime:'15:00-16:00',
     lastOrder:'20:30',
     closedDays:'',
     hoursNote:'화요일 12:00-20:00'
   }));
   assert.deepEqual(invalidGeneric[1].lastOrders,[]);

   await state(()=>renderReviewSummary([
     {taste:5,amount:4,price:3,wait:4},
     {taste:5,amount:4,price:3,wait:4},
     {taste:4,amount:4,price:3,wait:4}
   ]));
   assert.ok(!(await page.locator('#detailReviewInsight').evaluate(el=>el.hidden)));
   await state(()=>clearSelectedRows());
 });
 await check('admin Place text import opens without selecting a restaurant',async()=>{
   assert.equal(await page.locator('#placeCaptureButton').count(),1);
   assert.equal(await page.locator('#detailCaptureButton').count(),1);
   assert.equal(await page.locator('#placeCaptureModal').count(),1);
   assert.equal(await page.locator('#placeTextInput').count(),1);
   assert.ok(await state(()=>typeof submitPlaceText==='function'&&typeof submitPlaceCaptureForm==='function'&&typeof placeTextResultSummary==='function'&&typeof detectedDbNamesInText==='function'&&typeof buildPlaceTextPayload==='function'&&typeof armPlaceCaptureTimeout==='function'));
   const parsed=await state(()=>buildPlaceTextPayload([
     '자성당',
     '서울 마포구 잔다리로7안길 3',
     '홈',
     '메뉴 99+',
     '영업시간 11:30~21:00',
     '브레이크타임 15:00~17:00',
     '02-123-4567',
     '블로그리뷰 123'
   ].join('\\n')));
   assert.deepEqual(parsed.names,['자성당']);
   assert.equal(parsed.records[0].address,'서울 마포구 잔다리로7안길 3');
   assert.equal(parsed.records[0].phone,'02-123-4567');
   assert.ok(parsed.compactText.includes('영업시간 11:30~21:00'));
   assert.ok(parsed.compactText.includes('브레이크타임 15:00~17:00'));
   assert.ok(!parsed.compactText.includes('블로그리뷰 123'));
   assert.ok(parsed.compactText.length<['자성당','서울 마포구 잔다리로7안길 3','홈','메뉴 99+','영업시간 11:30~21:00','브레이크타임 15:00~17:00','02-123-4567','블로그리뷰 123'].join('\\n').length);
   await state(()=>{clearSelectedRows();currentAccount={email:'sejong.hyun@seah.co.kr',name:'qa'};syncPlaceCaptureUI();});
   assert.equal(await page.locator('#placeCaptureButton').isDisabled(),false);
   await page.click('#placeCaptureButton');
   assert.ok(await page.locator('#placeCaptureModal').evaluate(el=>el.classList.contains('open')));
   assert.equal(await page.locator('#captureDone').isDisabled(),true);
   await page.fill('#placeTextInput','자성당\n서울 마포구 잔다리로7안길 3\n영업시간 11:30~21:00');
   assert.equal(await page.locator('#captureDone').isDisabled(),false);

   await state(()=>{
     const originalLoadLiveDb=loadLiveDb;
     loadLiveDb=()=>Promise.resolve(true);
     pendingPlaceText={requestId:999,names:['자성당'],beforeSnapshot:'[]',originalText:String(placeTextInput.value||'')};
     setPlaceCaptureBusy(true);
     window.dispatchEvent(new MessageEvent('message',{
       origin:'https://script.google.com',
       data:{source:'lunch-map-place-text',ok:true,results:[{name:'자성당'}],skipped:[]}
     }));
     loadLiveDb=originalLoadLiveDb;
   });
   await page.waitForTimeout(40);
   assert.equal(await page.locator('#placeCaptureModal').evaluate(el=>el.classList.contains('open')),false);
   assert.equal(await state(()=>placeCaptureBusy),false);
   assert.equal(await page.inputValue('#placeTextInput'),'');
 });
 await check('menu tab remains as manual DB viewer without auto collection',async()=>{
   assert.equal(await page.locator('[data-detail-tab="menu"]').count(),1);
   assert.equal(await page.locator('[data-detail-panel="menu"]').count(),1);
   assert.equal(await page.locator('#menuAutoButton').count(),0);
   assert.equal(await page.locator('#menuList').count(),1);
   assert.ok(await state(()=>typeof fetchMenus==='function'&&typeof loadMenus==='function'&&typeof renderMenuList==='function'&&typeof autoFindMenus==='undefined'));
 });
 await check('place detail actions, related places, comparison and official directions link',async()=>{
   await page.setViewportSize({width:1440,height:900});await reset();
   const rows=await state(()=>getRows().slice(0,3).map(x=>x.row));
   assert.ok(rows.length>=2);
   await state(row=>selectRow(row,false,false),rows[0]);await page.waitForTimeout(160);
   assert.ok(await page.locator('#commentPanel').evaluate(el=>el.classList.contains('open')));
   const detailType=await state(()=>{
     const panel=document.getElementById('commentPanel');
     const info=document.getElementById('detailInfo');
     const value=info?.querySelector('.detail-info-value');
     const hours=info?.querySelector('.detail-hours-disclosure');
     if(hours)hours.open=true;
     return {
       width:panel.getBoundingClientRect().width,
       overflow:info?info.scrollWidth-info.clientWidth:0,
       valueFont:value?parseFloat(getComputedStyle(value).fontSize):0,
       labelFont:parseFloat(getComputedStyle(document.querySelector('.detail-info-label')).fontSize),
       sectionFont:parseFloat(getComputedStyle(document.querySelector('.detail-section-title')).fontSize)
     };
   });
   assert.ok(detailType.width>=410,JSON.stringify(detailType));
   assert.ok(detailType.overflow<=1,JSON.stringify(detailType));
   assert.ok(detailType.valueFont>=15,JSON.stringify(detailType));
   assert.ok(detailType.labelFont>=14,JSON.stringify(detailType));
   assert.ok(detailType.sectionFont>=18,JSON.stringify(detailType));
   assert.ok(await page.locator('#detailDirectionsLink').evaluate(el=>el.getAttribute('href')?.startsWith('https://map.kakao.com/link/to/')));
   assert.ok(await page.locator('#detailShareButton').isVisible());
   assert.ok(await page.locator('#detailCompareButton').isVisible());
   assert.ok(await page.locator('#detailSimilar .related-place').count()>=1);
   assert.ok(await page.locator('#detailNearby .related-place').count()>=1);
   await state(rs=>{toggleCompareRestaurant(dataForRow(rs[0]));toggleCompareRestaurant(dataForRow(rs[1]));},rows);
   assert.ok(await page.locator('#compareTray').isVisible());
   await page.click('#compareOpen');await page.waitForTimeout(80);
   assert.ok(await page.locator('#compareModal').evaluate(el=>el.classList.contains('open')));
   assert.equal(await page.locator('#compareContent .compare-card').count(),2);
   await page.click('#compareClose');
   await state(()=>{compareKeys=[];syncCompareUI();clearSelectedRows();});
 });
 await check('roulette and proposal dialogs open and close',async()=>{
   await page.click('#rouletteOpen');assert.ok(await page.locator('#rouletteModal').evaluate(el=>el.classList.contains('open')));await page.click('#rouletteClose');
   await page.click('#suggestOpen');assert.ok(await page.locator('#suggestModal').evaluate(el=>el.classList.contains('open')));await page.click('#suggestClose');
 });
 await check('company-account popup opens (mock endpoint; no account changes)',async()=>{
   const wait=context.waitForEvent('page');await page.click('#accountButton');const popup=await wait;await popup.waitForLoadState('domcontentloaded');assert.ok(popup.url().startsWith('https://script.google.com/'));await popup.close();
 });
 for(const width of [900,768,390,360,320])await check('mobile '+width+'px: dedicated full-width restaurant sheet and detail',async()=>{
   await page.setViewportSize({width,height:844});await page.waitForTimeout(280);
   assert.ok(await state(()=>sheetState==='mid'&&mobileSheet.classList.contains('sheet-mid')));
   assert.ok(!(await page.locator('#sidebar').isVisible()));
   assert.ok(await page.locator('#mobileSheet').isVisible());
   assert.ok(await page.locator('#mobileSearch').isVisible());
   assert.ok(await page.locator('#themeButton').isVisible());
   await page.click('#themeButton');
   assert.ok(await page.locator('#themeMenu').isVisible());
   await page.click('[data-theme-option="night"]');
   assert.equal(await state(()=>document.documentElement.dataset.theme),'night');
   await state(()=>applyTheme('simple',true));

   assert.ok(!(await page.locator('#mobileSearchOpen').isVisible())&&!(await page.locator('#mobileListOpen').isVisible()));

   const layout=await state(()=>{
     const s=mobileSheet.getBoundingClientRect(),h=document.querySelector('.topbar').getBoundingClientRect();
     const list=document.getElementById('mobileList'),card=list.querySelector('.mobile-card');
     return {
       left:s.left,right:s.right,width:s.width,sheetH:s.height,headerH:h.height,
       listH:list.getBoundingClientRect().height,cardH:card?.getBoundingClientRect().height||0,
       overflow:mobileSheet.scrollWidth-mobileSheet.clientWidth
     };
   });
   assert.ok(layout.headerH<=70,JSON.stringify(layout));
   assert.ok(Math.abs(layout.left)<=1&&Math.abs(layout.right-width)<=1&&Math.abs(layout.width-width)<=1,JSON.stringify(layout));
   assert.ok(layout.sheetH>=300&&layout.sheetH<600,JSON.stringify(layout));
   assert.ok(layout.listH>layout.cardH,JSON.stringify(layout));
   assert.ok(layout.overflow<=1,JSON.stringify(layout));
   if(width===390)await shot('mobile-native-mid');

   await page.fill('#mobileSearch','자성당');await page.waitForTimeout(180);
   assert.ok(await state(()=>searchKeyword==='자성당'&&getRows().length>0));
   assert.equal(await page.locator('#mobileList .mobile-card').count(),await state(()=>getRows().length));
   await page.fill('#mobileSearch','');await page.waitForTimeout(180);

   await page.click('[data-mobile-chip="rating4"]');
   assert.equal(await page.getAttribute('[data-mobile-chip="rating4"]','aria-pressed'),'true');
   assert.ok(await state(()=>ratingFilter==='4'&&getRows().every(x=>ratingScore(x)>=4)));
   await state(()=>resetMultiFilters());await page.waitForTimeout(100);

   await page.click('#mobileDetailedFilterToggle');await page.waitForTimeout(140);
   assert.ok(await state(()=>sheetState==='full'&&mobileSheet.classList.contains('filters-open')));
   assert.ok(await page.locator('#mobileDetailedFilters').isVisible());
   await choose('mobileDistanceFilter','500');
   assert.ok(await page.evaluate(()=>getRows().every(x=>distanceFromSeahTower(x)<=500)));
   await page.click('#mobileFilterReset');
   await page.click('#mobileDetailedFilterToggle');
   assert.ok(await state(()=>!mobileSheet.classList.contains('filters-open')));
   await state(()=>setSheetState('mid'));await page.waitForTimeout(120);

   await page.selectOption('#mobileSort','distance');await page.waitForTimeout(120);
   assert.equal(await state(()=>sortMode),'distance');
   assert.ok(await state(()=>{const rows=getRows();return rows.every((x,i)=>!i||distanceFromSeahTower(rows[i-1])<=distanceFromSeahTower(x))}));
   await state(()=>{sortMode='default';syncSortUI();render(false);setSheetState('mid');});await page.waitForTimeout(100);

   await page.click('#mobileSheetHandle');assert.ok(await state(()=>sheetState==='full'));
   await page.click('#mobileSheetHandle');assert.ok(await state(()=>sheetState==='mid'));
   await state(()=>setSheetState('peek'));await page.waitForTimeout(100);
   assert.ok(!(await page.locator('#mobileSearch').isVisible())&&await page.locator('.mobile-list-head').isVisible());
   await page.click('#mobileSheetHandle');assert.ok(await state(()=>sheetState==='mid'));

   await page.click('#mobileMyLocation');await page.waitForTimeout(250);
   assert.ok(await state(()=>Math.abs(map.getCenter().getLat()-37.55)<0.0001));

   await page.locator('#mobileList .mobile-card-name').first().click();await page.waitForTimeout(250);
   assert.ok(await state(()=>commentPanel.classList.contains('open')&&sheetState==='hidden'&&document.body.classList.contains('detail-mobile-open')));
   const p=await page.locator('#commentPanel').boundingBox();
   assert.ok(Math.abs(p.x)<=1&&Math.abs(p.width-width)<=1&&p.y<=1,JSON.stringify(p));
   const mobileDetail=await state(()=>{
     const panel=document.getElementById('commentPanel');
     const info=document.getElementById('detailInfo');
     const hours=info?.querySelector('.detail-hours-disclosure');
     if(hours)hours.open=true;
     return {
       panelOverflow:panel.scrollWidth-panel.clientWidth,
       infoOverflow:info?info.scrollWidth-info.clientWidth:0,
       valueFont:parseFloat(getComputedStyle(info?.querySelector('.detail-info-value')||panel).fontSize)
     };
   });
   assert.ok(mobileDetail.panelOverflow<=1,JSON.stringify(mobileDetail));
   assert.ok(mobileDetail.infoOverflow<=1,JSON.stringify(mobileDetail));
   assert.ok(mobileDetail.valueFont>=14.5,JSON.stringify(mobileDetail));
   if(width===390)await shot('mobile-detail');
   await page.click('#commentClose');await page.waitForTimeout(350);
   assert.ok(await state(()=>!commentPanel.classList.contains('open')&&sheetState==='mid'&&!document.body.classList.contains('detail-mobile-open')));
 });
 await check('desktop after mobile resize and no uncaught errors',async()=>{
   await page.setViewportSize({width:1440,height:900});await reset();assert.ok(await page.locator('#search').isVisible());assert.deepEqual(errors,[]);
 });
 console.log(JSON.stringify({passed:results.length,errors,apiRequests},null,2));
 await browser.close();
})().catch(async e=>{console.error(e);if(page)await shot('failure').catch(()=>{});if(browser)await browser.close();process.exitCode=1;});
