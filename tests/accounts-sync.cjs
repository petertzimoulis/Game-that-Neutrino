// Optional account saves preserve guest play and isolate each player's progress.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const nodes = new Map(), memory = new Map(), timers = new Map();
let nextTimer = 1;
const node = () => ({innerHTML:'',classList:{toggle(){}},querySelector(){return null},querySelectorAll(){return []}});
const context = {
  console, URL, URLSearchParams, Math, Date, JSON, Map, Set, Number,
  requestAnimationFrame(){},
  localStorage:{getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)},
  fetch:()=>new Promise(()=>{}),
  window:{location:{search:'',href:'http://localhost/'},setInterval(){},setTimeout(fn){const id=nextTimer++;timers.set(id,fn);return id},clearTimeout:id=>timers.delete(id),addEventListener(){},history:{replaceState(){}}},
  document:{visibilityState:'visible',querySelector:selector=>{if(selector==='#intro-modal-root')return null;if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector)},querySelectorAll:()=>[],addEventListener(){},body:{classList:{toggle(){}}}},
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace('\ninitializeSharedPlayers();','\n'),context);
let signedIn = null;
const users = new Map();
let delaySave = null;
context.fetch = async (url, options={}) => {
  const data = options.body ? JSON.parse(options.body) : null;
  let status = 200, result;
  if (url === '/api/account') result = signedIn ? {user:{username:signedIn},...structuredClone(users.get(signedIn))} : {user:null};
  else if (url === '/api/auth/register') {signedIn=data.username;users.set(signedIn,{progress:{},revision:0});result={user:{username:signedIn},...users.get(signedIn)}}
  else if (url === '/api/auth/login') {signedIn=data.username;result={user:{username:signedIn},...structuredClone(users.get(signedIn))}}
  else if (url === '/api/auth/logout') {signedIn=null;result={user:null}}
  else if (url === '/api/account/progress') {
    if (delaySave) await delaySave;
    const user=users.get(signedIn);
    if (!user || data.owner!==signedIn) {status=401;result={error:'Account changed'}}
    else if (data.revision!==user.revision) {status=409;result={error:'Another device saved newer progress'}}
    else {user.progress=structuredClone(data.progress);user.revision++;result={revision:user.revision}}
  } else return new Promise(()=>{});
  return {ok:status===200,status,json:async()=>result};
};
vm.runInContext(fs.readFileSync(path.join(__dirname,'../accounts.js'),'utf8'),context);
const run = code => vm.runInContext(code,context);

(async()=>{
  await run('accountInitialization');
  run(`
    render=()=>{captureAccountProgress()}; syncAllDataFromServer=async()=>{};
    state.catalogLoaded=true;
    ALL_VIDEOS=Array.from({length:4},(_,group)=>Array.from({length:25},(_,i)=>({id:'set'+group+'/'+i,sourceGroup:'Set '+group,sectionId:'market',correctChoice:'track',src:'clip.mp4'}))).flat();
    ALL_VIDEOS_BY_ID=Object.fromEntries(ALL_VIDEOS.map(video=>[video.id,video]));
    beginRun('Guest player','demo');
  `);
  const guestId = run('state.currentRun.id');
  assert.equal(run('accountState.user'),null,'Guest can start immediately without authentication');
  await run(`(async()=>{const guest=accountSnapshot();const payload=await accountRequest('/api/auth/register',{username:'Alice',password:'not-stored'});await restoreAccount(payload,guest)})()`);
  assert.equal(users.get('Alice').progress.currentRun.id,guestId,'Signup adopts the unfinished guest game');
  run(`state.currentRun.currentIndex=2;state.currentRun.coins=14;saveStorage(STORAGE_KEYS.currentRun,state.currentRun);captureAccountProgress();`);
  run(`state.localTrophies['guest player']={name:'Guest player',unlocked:['first-call'],synced:true};captureAccountProgress();`);
  await run('saveAccountProgress()');
  assert.equal(users.get('Alice').progress.currentRun.currentIndex,2,'Question position saves');
  assert.equal(users.get('Alice').progress.currentRun.coins,14,'Coin progress saves');
  assert.deepEqual(users.get('Alice').progress.trophies['guest player'].unlocked,['first-call'],'Earned trophies save to the account');
  assert.ok(![...memory.values()].some(value=>String(value).includes('not-stored')),'Passwords never enter local storage');
  await run(`accountRequest('/api/auth/logout',{})`);
  run('becomeGuest()');
  assert.equal(run('state.currentRun.currentIndex'),0,'Logout restores the separate guest game');
  await run(`(async()=>{const payload=await accountRequest('/api/auth/register',{username:'Bob',password:'not-stored'});await restoreAccount(payload)})()`);
  assert.equal(run('state.currentRun'),null,'A second account cannot inherit Alice’s game');
  await run(`accountRequest('/api/auth/logout',{})`); run('becomeGuest()');
  await run(`(async()=>{const payload=await accountRequest('/api/auth/login',{username:'Alice',password:'not-stored'});await restoreAccount(payload)})()`);
  assert.equal(run('state.currentRun.currentIndex'),2,'Login restores Alice’s saved position');
  assert.equal(run("state.localTrophies['guest player'].unlocked[0]"),'first-call','Login restores earned trophies');
  users.get('Alice').revision++;
  users.get('Alice').progress.currentRun.currentIndex=3;
  run(`state.currentRun.currentIndex=4;saveStorage(STORAGE_KEYS.currentRun,state.currentRun);captureAccountProgress();`);
  await run('saveAccountProgress()');
  assert.equal(run('accountState.status'),'conflict','Stale writes pause for a user choice');
  assert.equal(users.get('Alice').progress.currentRun.currentIndex,3,'Newer device progress is not overwritten');
  run(`accountState.revision=accountState.conflict.revision;accountState.conflict=null;`);
  await run('saveAccountProgress()');
  assert.equal(users.get('Alice').progress.currentRun.currentIndex,4,'Explicitly keeping local progress saves it');
  let release;
  delaySave = new Promise(resolve=>{release=resolve});
  run(`state.currentRun.currentIndex=1;captureAccountProgress();`);
  const saving = run('saveAccountProgress()');
  run(`state.currentRun.currentIndex=2;captureAccountProgress();`);
  release(); await saving; delaySave=null;
  assert.equal(run('loadStorage(STORAGE_KEYS.accountDirty,false)'),true,'Changes made during a save stay dirty');
  await run('saveAccountProgress()');
  assert.equal(users.get('Alice').progress.currentRun.currentIndex,2,'Changes made during a save are sent next');
  assert.equal(run('accountState.status'),'saved');
  signedIn='Bob';
  run(`state.currentRun.currentIndex=3;captureAccountProgress();`);
  await run('saveAccountProgress()');
  assert.equal(run('accountState.user'),null,'A session changed in another tab safely returns this tab to guest mode');
  assert.equal(users.get('Bob').progress.currentRun,null,'Alice’s unsaved progress never overwrites Bob’s account');
  assert.equal(memory.get(run('GUEST_STORAGE_KEYS.accountDirty')+'-account-alice'),'true','Expired-session progress stays available for the next Alice login');
  users.get('Bob').progress.selectedMode='endless';
  await run(`(async()=>{const payload=await accountRequest('/api/account');await restoreAccount(payload,null,{entryMode:getInitialSelectedMode()})})()`);
  assert.equal(run('getActiveMode()'),'demo','Homepage stays on Collaborator after restoring a paused account');
  run(`writeLocalSnapshot({currentRun:{mode:'quick',answers:[]},lastCompletedRun:{mode:'quiz'},selectedMode:'friday',completedRuns:[{id:'archive',mode:'quick',answers:[]}]})`);
  assert.equal(run('state.currentRun'),null,'Account restore cannot reopen a retired game');
  assert.equal(run('state.lastCompletedRun'),null,'Retired game results cannot replace the current screen');
  assert.equal(run('state.selectedMode'),'demo','Retired account selections default to Collaborator');
  assert.equal(run('loadStorage(STORAGE_KEYS.completedRuns,[])[0].id'),'archive','Retired historical data remains preserved');
  console.log('PASS: optional guest play, guest-to-account saves, password privacy, account isolation, resume, stale-device conflicts, and edits during an in-flight save.');
})().catch(error=>{console.error(error);process.exitCode=1});
