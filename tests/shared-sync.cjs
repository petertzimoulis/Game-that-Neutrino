const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const node = () => ({innerHTML:'', classList:{toggle(){}}, querySelector(){return null}, querySelectorAll(){return []}});
const memory = new Map();
const context = {console, Blob, URL, URLSearchParams, Date, Math, Map, Set, JSON,
  requestAnimationFrame(){}, fetch:()=>new Promise(()=>{}),
  localStorage:{getItem:key=>memory.get(key),setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)},
  window:{location:{search:'',href:'http://localhost/'},setInterval:()=>1,setTimeout:()=>1,clearTimeout(){},addEventListener(){},history:{replaceState(){}}},
  document:{visibilityState:'visible',querySelector:selector=>selector==='#intro-modal-root'?null:node(),querySelectorAll:()=>[],addEventListener(){},body:{classList:{toggle(){}}}},
  navigator:{sendBeacon:()=>true}
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(require('path').join(__dirname,'../app.js'),'utf8')
  .replace('\ninitializeSharedPlayers();','\n'),context);
vm.runInContext(`
(async()=>{
  const check=(value,message)=>{if(!value)throw new Error(message)};
  render=()=>{};renderAchievementOverlays=()=>{};
  const calls=[];
  fetch=async(url,options)=>{calls.push(url);return {ok:true,json:async()=>({players:[],updatedAt:null,crowdStats:{}})}};
  state.currentRun=null;state.lastCompletedRun=null;state.selectedMode='demo';state.showAnalysis=false;
  await syncAllDataFromServer({force:true});
  check(calls.length===1 && calls[0]===API_COLLABORATOR_PLAYERS_URL,'one mode request, no background analytics');
  calls.length=0;
  await syncAllDataFromServer();
  check(calls.length===0,'focus refresh throttled');
  state.selectedMode='quiz';
  await syncAllDataFromServer({force:true});
  check(calls.length===1 && calls[0]===API_COLLABORATOR_PLAYERS_URL,'retired saved modes fall back to the collaborator leaderboard');
  const first={id:'first',name:'One',nameKey:'one',completedAt:'2026-10-15T00:00:00Z',answers:[]};
  const second={id:'second',name:'Two',nameKey:'two',completedAt:'2026-10-15T01:00:00Z',answers:[]};
  applyCollaboratorPayload({players:[first],crowdStats:{clip:{trackCount:2,cascadeCount:8,correctCount:2}}});
  applyCollaboratorPayload({partial:true,players:[second],history:[second]});
  check(state.demoPlayers.length===2 && state.demoPlayers.crowdStats.clip.trackCount===2,'partial POST keeps other players and crowd counts');
  applyCollaboratorPayload({players:[first],crowdStats:{clip:{trackCount:2,cascadeCount:8,correctCount:2}}});
  check(state.demoPlayers.some(player=>player.id==='second'),'cached read does not hide a confirmed score');
  const lines=getPublicLines('clip',getCrowdPlayers('demo'));
  check(lines.totalResponses===10 && lines.trackCount===2,'aggregate votes survive compact player payloads');
  const shared=await Promise.all([fetchSharedJson('/test-dedupe'),fetchSharedJson('/test-dedupe')]);
  check(calls.filter(url=>url==='/test-dedupe').length===1,'overlapping reads deduplicated');
  state.showAnalysis=true;
  fetch=async(url)=>({ok:true,json:async()=>url.includes('/api/history')
    ? (url.includes('cursor=')?{history:[second],nextCursor:null}:{history:[first],nextCursor:['2026-10-15T00:00:00Z','first']})
    : {players:[first,second]}});
  const full=await fetchLeaderboardData(API_COLLABORATOR_PLAYERS_URL,'demo');
  check(full.history.length===2,'full reports collect bounded history pages');
  let renderCount=0;
  render=()=>{renderCount++};
  state.quizLeaderboardLoaded=true;state.quizDataVersion=null;
  await syncQuizPlayersFromServer();
  check(renderCount>0 && state.quizHistory.length===2,'opening analysis renders full records even when version is unchanged');
  state.showAnalysis=false;
  analyticsQueue.length=0;
  for(let i=0;i<600;i++) trackEvent('test');
  check(analyticsQueue.length===500,'offline telemetry queue bounded');
  let sent=0;
  fetch=async(url,options)=>{sent=JSON.parse(options.body).events.length;return {ok:true,json:async()=>({accepted:sent})}};
  state.analyticsSummary={totalEvents:42};
  await flushAnalyticsEvents();
  check(sent===100 && analyticsQueue.length===400,'telemetry batched at 100');
  check(state.analyticsSummary.totalEvents===42,'small write acknowledgement preserves dashboard');
  window.NEUTRINO_CONFIG={videoBaseUrl:'https://media.example.test'};
  check(buildVideoUrl('Group 1','clip.mp4')==='https://media.example.test/videos/Group%201/clip.mp4','optional independent media CDN uses existing paths');
  globalThis.syncChecksFinished=true;
  console.log('PASS: selected-mode refresh, throttling, read deduplication, compact crowds, partial acknowledgements, report pagination, and bounded telemetry.');
})().catch(error=>{console.error(error);globalThis.syncChecksFailed=true;});
`,context);
process.on('beforeExit',()=>{assert.equal(context.syncChecksFinished,true,'shared sync checks completed');assert.notEqual(context.syncChecksFailed,true)});
