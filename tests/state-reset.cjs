const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const memory = new Map([
  ['game-that-neutrino-current-run', JSON.stringify({id:'retired-run',mode:'demo'})],
  ['game-that-neutrino-last-name', JSON.stringify('Retired player')],
  ['game-that-neutrino-endless-run', JSON.stringify({id:'retired-endless',mode:'endless',totalQuestions:250})],
  ['game-that-neutrino-collaborator-pending', JSON.stringify([{id:'retired-upload',answers:Array(5).fill({})}])],
  ['game-that-neutrino-trophies-v1', JSON.stringify({retired:{name:'Retired player',unlocked:['first-call'],synced:false}})],
  ['another-app-preference', 'keep'],
]);
const node = () => ({innerHTML:'',classList:{toggle(){}},querySelector(){return null},querySelectorAll(){return []}});
function openGame() {
  const context = {
    console, URL, URLSearchParams, Map, Set, Math, Date, Number, JSON,
    requestAnimationFrame(){}, fetch:()=>new Promise(()=>{}),
    localStorage:{getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)},
    window:{location:{search:'',href:'http://localhost/'},setInterval(){},setTimeout(){},addEventListener(){},history:{replaceState(){}}},
    document:{querySelector:selector=>selector==='#intro-modal-root'?null:node(),querySelectorAll:()=>[],addEventListener(){},body:{classList:{toggle(){}}}},
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root,'app.js'),'utf8').replace('\ninitializeSharedPlayers();','\n'),context);
  return code=>vm.runInContext(code,context);
}
(async()=>{
  let run = openGame();
  assert.equal(run('state.currentRun'),null);
  assert.equal(run('state.savedEndlessRun'),null);
  assert.equal(run('state.lastCompletedRun'),null);
  assert.equal(run('state.lastName'),'');
  assert.equal(run('state.pendingCollaboratorRuns.length'),0,'Retired scores cannot migrate back into the outbox');
  assert.equal(run('state.pendingEndlessRuns.length'),0);
  assert.equal(run('Object.keys(state.localTrophies).length'),0);
  assert.equal(memory.get('another-app-preference'),'keep');
  const epoch = run('GAME_STATE_EPOCH');
  run("saveStorage(STORAGE_KEYS.lastName,'Fresh player')");
  run = openGame();
  assert.equal(run('state.lastName'),'Fresh player','New progress survives subsequent reloads');

  const source = fs.readFileSync(path.join(root,'worker/index.js'),'utf8');
  const {default:worker} = await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const originalFetch = global.fetch;
  let githubReads=0, saved;
  global.fetch = async (url,options={}) => {
    githubReads++;
    assert.ok(String(url).includes('/data/'+epoch+'/'),'The reset uses fresh storage instead of historical score files');
    if(options.method==='PUT') {
      saved=JSON.parse(Buffer.from(JSON.parse(options.body).content,'base64').toString());
      return Response.json({});
    }
    return Response.json({content:Buffer.from(JSON.stringify({profiles:[]})).toString('base64'),sha:'test-sha'});
  };
  try {
    for(const endpoint of ['players','collaborator-players','quiz-players','quick-quiz-players','achievements','endless-players']) {
      const response = await worker.fetch(new Request('https://game.example/api/'+endpoint,{method:'POST',body:'{}'}),{});
      assert.equal(response.status,409,'Old open tabs cannot repopulate '+endpoint);
    }
    assert.equal(githubReads,0,'Rejected old writes never reach storage');
    const response = await worker.fetch(new Request('https://game.example/api/achievements',{
      method:'POST',headers:{'Content-Type':'application/json','X-Neutrino-State-Epoch':epoch},
      body:JSON.stringify({name:'Fresh player',unlocked:['first-call']}),
    }),{GITHUB_TOKEN:'test-only-token'});
    assert.equal(response.status,200,'New games can still earn and sync trophies');
    assert.deepEqual(saved.profiles[0].unlocked,['first-call']);
    assert.ok(response.headers.get('Access-Control-Allow-Headers').includes('X-Neutrino-State-Epoch'));
  } finally { global.fetch=originalFetch; }
  console.log('PASS: old saves, trophies and pending uploads stay retired; fresh progress persists; stale tabs cannot restore reset boards.');
})().catch(error=>{console.error(error);process.exitCode=1});
