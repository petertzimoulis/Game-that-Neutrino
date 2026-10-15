const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {webcrypto} = require('node:crypto');
const memory = new Map(), nodes = new Map();
const node = () => ({innerHTML:'',classList:{toggle(){}},querySelector(){return null},querySelectorAll(){return []}});
const context = {
  console, URL, URLSearchParams, Map, Set, Math, Date, Number, JSON, Uint8Array,
  requestAnimationFrame(){}, fetch:()=>new Promise(()=>{}),
  localStorage:{getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)},
  window:{crypto:webcrypto,location:{search:'?mode=endless',href:'http://localhost/?mode=endless'},setInterval(){},setTimeout(){return 0},clearTimeout(){},addEventListener(){},history:{replaceState(){}}},
  document:{visibilityState:'visible',querySelector:selector=>{if(selector==='#intro-modal-root')return null;if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector)},querySelectorAll:()=>[],addEventListener(){},body:{classList:{toggle(){}}}},
};
vm.createContext(context);
const run = code => vm.runInContext(code,context);
run(fs.readFileSync(path.join(__dirname,'../endless.js'),'utf8'));
run(fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace('\ninitializeSharedPlayers();','\n'));
let offline=false;
context.fetch = async (url,options={}) => {
  if(url==='/api/account') return {ok:true,json:async()=>({user:null})};
  if(url==='/api/endless-players') {
    if(offline)throw new Error('offline');
    const record=options.body?JSON.parse(options.body):null;
    if(record)delete record.checkpointKey;
    return {ok:true,json:async()=>record?{record}:{players:[]}};
  }
  return new Promise(()=>{});
};
run(fs.readFileSync(path.join(__dirname,'../accounts.js'),'utf8'));
(async()=>{
  await run('accountInitialization');
  run(`render=()=>{captureAccountProgress()};syncAchievements=async()=>{};syncAllDataFromServer=async()=>{};
    ALL_VIDEOS=Array.from({length:100},(_,i)=>({id:'catalog/'+i,sourceGroup:'Set '+Math.floor(i/25),sectionId:'market',correctChoice:i<50?'track':'cascade',label:'Event '+i,src:'clip.mp4'}));
    ALL_VIDEOS_BY_ID=Object.fromEntries(ALL_VIDEOS.map(video=>[video.id,video]));state.catalogLoaded=true;
    beginRun('Endless tester','endless');`);
  assert.equal(run('getActiveMode()'),'endless');
  assert.ok(run('renderRunView(state.currentRun)').includes('Question 1'));
  const firstDeck=Array.from(run('state.currentRun.videoOrder'));
  assert.equal(new Set(firstDeck).size,100);
  for(let i=0;i<235;i++)run(`handleChoice(ALL_VIDEOS_BY_ID[state.currentRun.videoOrder[state.currentRun.currentIndex]].correctChoice);advanceEndlessRun();`);
  await new Promise(setImmediate);
  await run('syncEndlessFromServer()');
  assert.equal(run('state.currentRun.totalQuestions'),235,'Run continues beyond the catalog and former 100-answer save cap');
  assert.equal(run('state.currentRun.totalCorrect'),235);
  assert.equal(run('state.currentRun.coins'),478,'Lifetime hot-hand scoring survives review trimming');
  assert.equal(run('state.currentRun.bestStreak'),235);
  const earned=Array.from(run("state.localTrophies['endless tester'].unlocked"));
  for(const id of ['endless-10','endless-50','endless-100','endless-streak-10','endless-correct-100'])assert.ok(earned.includes(id),id+' awarded during play');
  assert.ok(!earned.includes('endless-250'),'250-question trophy stays locked at 235');
  assert.ok(!earned.includes('demo-complete'),'Endless play cannot award demo completion');
  assert.equal(run('state.currentRun.answers.length'),10,'Review is bounded');
  assert.equal(run('state.currentRun.videoOrder.length'),100,'Deck is bounded');
  assert.equal(run('isCurrentRunCompatible(state.currentRun)'),true);
  assert.ok(run('JSON.stringify(accountSnapshot()).length')<50000,'Cloud save stays small after long play');
  assert.ok(!run('JSON.stringify(state.endlessPlayers)').includes('checkpointKey'),'Public leaderboard never contains private checkpoint keys');
  run('pauseEndlessRun()');
  assert.equal(run('state.currentRun'),null);
  assert.equal(run('state.savedEndlessRun.totalQuestions'),235);
  assert.ok(JSON.parse(memory.get(run('STORAGE_KEYS.trophies')))['endless tester'].unlocked.includes('endless-100'),'Earned milestone is saved locally');
  // Simulate a run saved before the new trophies were introduced.
  run("state.localTrophies['endless tester'].unlocked=state.localTrophies['endless tester'].unlocked.filter(id=>!id.startsWith('endless-'))");
  const snapshot=run('JSON.stringify(accountSnapshot())');
  run('state.savedEndlessRun=null;state.currentRun=null;writeLocalSnapshot(JSON.parse('+JSON.stringify(snapshot)+'));resumeEndlessRun();');
  assert.equal(run('state.currentRun.totalQuestions'),235,'Account snapshot restores paused Endless run');
  assert.equal(run('state.currentRun.coins'),478);
  const restored=Array.from(run("state.localTrophies['endless tester'].unlocked"));
  for(const id of ['endless-10','endless-50','endless-100','endless-streak-10','endless-correct-100'])assert.ok(restored.includes(id),id+' backfilled on account resume');
  run('evaluateAchievements(state.currentRun)');
  assert.equal(run("state.localTrophies['endless tester'].unlocked.length"),restored.length,'Resuming and answering cannot duplicate trophies');
  const good={id:'one',name:'A',nameKey:'a',totalCorrect:2,totalQuestions:2,totalAccuracy:1,finalCoins:12};
  context.records=[good,{...good,totalQuestions:3,totalAccuracy:2/3,finalCoins:11}];
  assert.equal(run('mergeEndlessPlayers(records)[0].totalQuestions'),3,'An active run updates after wrong answers even when accuracy drops');
  run('finishEndlessRun()');
  await new Promise(setImmediate);await run('syncEndlessFromServer()');
  assert.equal(run('state.savedEndlessRun'),null);
  assert.equal(run('state.lastCompletedRun.mode'),'endless');
  assert.equal(run('state.lastCompletedRun.totalQuestions'),235);
  assert.ok(run('renderResultsView(state.lastCompletedRun)').includes('Endless leaderboard'));
  run(`state.lastCompletedRun=null;beginRun('Another player','endless');`);
  offline=true;
  for(let i=0;i<15;i++)run(`handleChoice(ALL_VIDEOS_BY_ID[state.currentRun.videoOrder[state.currentRun.currentIndex]].correctChoice==='track'?'cascade':'track');advanceEndlessRun();`);
  await new Promise(setImmediate);
  assert.equal(run('state.currentRun.totalQuestions'),15);
  assert.equal(run('state.currentRun.coins'),-5,'Negative coins never end the run automatically');
  assert.ok(run("state.localTrophies['another player'].unlocked.includes('endless-10')"),'Participation milestone counts incorrect calls');
  assert.ok(!run("state.localTrophies['another player'].unlocked.includes('endless-streak-10')"),'Incorrect calls do not award correct-streak trophy');
  run('pauseEndlessRun()');
  assert.ok(run('state.pendingEndlessRuns.length')>0,'Offline checkpoint remains queued');
  assert.equal(run('state.savedEndlessRun.totalQuestions'),15,'Offline progress remains resumable');
  offline=false;
  await new Promise(setImmediate);await run('syncEndlessFromServer({refresh:true})');
  assert.equal(run('state.pendingEndlessRuns.length'),0,'Reconnection retries the checkpoint');
  console.log('PASS: Endless play beyond 100 clips, bounded saves, lifetime scoring, pause/account restore, private keys, separate leaderboard, finish, and offline retry.');
})().catch(error=>{console.error(error);process.exitCode=1});
