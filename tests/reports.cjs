const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const nodes=new Map(),memory=new Map(),downloads=[];
const node=()=>({innerHTML:'',textContent:'',classList:{toggle(){}},querySelector(){return null},querySelectorAll(){return []}});
const urlApi=class extends URL {};
urlApi.createObjectURL=blob=>{downloads.push(blob);return 'blob:test'};
urlApi.revokeObjectURL=()=>{};
const context={console,Blob,URL:urlApi,URLSearchParams,Math,Date,JSON,Map,Set,Number,
 requestAnimationFrame(){},fetch:()=>new Promise(()=>{}),
 localStorage:{getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)},
 window:{location:{search:'',href:'http://localhost/'},setInterval(){},setTimeout(){},clearTimeout(){},addEventListener(){},history:{replaceState(){}}},
 document:{querySelector:selector=>{if(selector==='#intro-modal-root')return null;if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector)},querySelectorAll:()=>[],addEventListener(){},createElement:()=>({click(){}}),body:{classList:{toggle(){}},appendChild(){},removeChild(){}}},
};
vm.createContext(context);
const run=code=>vm.runInContext(code,context);
run(fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace('\ninitializeSharedPlayers();','\n'));
(async()=>{
 run(`
 ALL_VIDEOS=[{id:'a',label:'A',sourceGroup:'Set 1',correctChoice:'track',sectionId:'market'},
 {id:'b',label:'B',sourceGroup:'Set 2',correctChoice:'cascade',sectionId:'market'},
 {id:'c',label:'C',sourceGroup:'Set 3',correctChoice:'track',sectionId:'market'},
 {id:'d',label:'Unanswered',sourceGroup:'Set 4',correctChoice:'cascade',sectionId:'market'}];
 ALL_VIDEOS_BY_ID=Object.fromEntries(ALL_VIDEOS.map(video=>[video.id,video]));
 const pick=(videoId,choice,correct,responseSeconds)=>({videoId,choice,correct,responseSeconds});
 const first={id:'alice-1',name:'Alice',nameKey:'alice',totalQuestions:2,totalCorrect:2,totalAccuracy:1,completedAt:'2026-10-15T10:00:00Z',finalCoins:12,answers:[pick('a','track',true,2),pick('b','cascade',true,4)]};
 const second={id:'alice-2',name:'ALICE',nameKey:'alice',totalQuestions:3,totalCorrect:1,totalAccuracy:1/3,completedAt:'2026-10-15T11:00:00Z',finalCoins:9,answers:[pick('a','cascade',false,null),pick('b','track',false,8),pick('c','track',true,10)]};
 const bob={id:'bob-1',name:'Bob',nameKey:'bob',totalQuestions:1,totalCorrect:1,totalAccuracy:1,completedAt:'2026-10-15T12:00:00Z',finalCoins:11,answers:[pick('a','track',true,3)]};
 state.demoPlayers=[second,bob];state.demoHistory=[first,second,bob];
 state.selectedMode='demo';state.showAnalysis=true;state.reportStatus={demo:'ready'};
 state.analyticsLoaded=true;
 state.analyticsEvents=[{mode:'demo',type:'video_play',nameKey:'alice',sessionId:'one',videoId:'a',timestamp:'2026-10-15T10:00:00Z'},
 {mode:'demo',type:'video_seek',nameKey:'alice',sessionId:'one',videoId:'a',timestamp:'2026-10-15T10:00:01Z'},
 {mode:'quiz',type:'video_play',nameKey:'bob',sessionId:'two',videoId:'a',timestamp:'2026-10-15T10:00:02Z'}];
 `);
 const definitions=run('getDetailedReportDefinitions()');
 assert.equal(definitions.runs.rows.length,3,'Every historical attempt is included once');
 assert.equal(definitions.answers.rows.length,6,'Repeated players keep all answer rows');
 const alice=definitions.users.rows.find(row=>row.player==='ALICE');
 assert.equal(alice.attempts,2);assert.equal(alice.questions,5);assert.equal(alice.correct,3);
 assert.equal(alice.accuracy_percent,60,'Accuracy is weighted by answer count');
 assert.equal(alice.average_response_seconds,6,'Missing timing is not treated as zero');
 assert.equal(definitions.videos.rows.find(row=>row.video_id==='a').attempts,3);
 assert.equal(definitions.videos.rows.find(row=>row.video_id==='a').unique_players,2);
 assert.equal(definitions.videos.rows.find(row=>row.video_id==='d').accuracy_percent,null);
 assert.equal(definitions['activity-users'].rows[0].events,2,'Activity is scoped to the selected mode');
 assert.equal(definitions['activity-videos'].rows[0].seeks,1);
 assert.equal(definitions['activity-events'].rows.length,2);
 run(`state.analyticsEvents.push({mode:'demo',type:'video_pause',nameKey:'alice',sessionId:'one',videoId:undefined,videoSrc:'http://localhost/videos/a',timestamp:'2026-10-15T10:00:03Z'})`);
 assert.equal(run("getDetailedReportDefinitions()['activity-videos'].rows.length"),1,'Clip URLs and catalog IDs group into the same video');
 assert.ok(run('renderAnalysisModal()').includes('Per-video responses'));
 assert.ok(run('renderAnalysisModal()').includes('Per-user performance'));
 assert.ok(run('renderAnalysisModal()').includes('select-analysis-mode'));
 for(const retired of ['Friday Lineup','Learning Quiz','4.0 Quick Quiz']) assert.ok(!run('renderReportNavigation()').includes(retired),'Retired mode is absent from report navigation');
 run("downloadCsv('detail-answers')");
 const csv=await downloads.at(-1).text();
 assert.equal(csv.split('\n').length,7,'The actual download includes all answer rows');
 assert.ok(csv.includes('alice-1')&&csv.includes('alice-2'));
 assert.equal(run('serializeCsv([], ["player","correct"])'),'player,correct','Empty exports keep their column headers');
 assert.ok(run('csvEscape("=SUM(1,2)")').includes("'=SUM"),'Names cannot execute spreadsheet formulas');
 assert.equal(run('csvEscape(-2)'),'-2','Negative numeric results remain numeric');
 run(`state.currentRun={id:'active-demo',name:'Playing',mode:'demo'};state.analysisMode='quiz';render=()=>{};`);
 const calls=[];
 context.fetch=async(url)=>{calls.push(url);return {ok:true,json:async()=>url.includes('analytics')?{events:[],recentEvents:[],summary:{}}:{players:[],history:[],updatedAt:null}}};
 await run('syncAllDataFromServer({force:true})');
 assert.ok(calls.includes('/api/collaborator-players?view=full'),'Retired report selections fall back to Collaborator history');
 assert.ok(calls.includes('/api/analytics?view=full'),'All modes load the full retained activity window');
 assert.equal(run('state.currentRun.id'),'active-demo','Report browsing never replaces the active game');
 assert.equal(run('state.reportStatus.demo'),'ready');
 run(`state.analysisMode='endless';state.endlessPlayers=[{id:'endless',name:'Runner',nameKey:'runner',totalQuestions:250,totalCorrect:200,finalCoins:300}];state.savedEndlessRun={...state.endlessPlayers[0],mode:'endless',answers:[{videoId:'a',choice:'track',correct:true}]};`);
 assert.equal(run('getDetailedReportDefinitions().users.rows[0].questions'),250,'Endless totals do not use the trimmed review');
 assert.equal(run('getDetailedReportDefinitions().answers.rows.length'),1);
 assert.ok(run('renderDetailedReports()').includes('not a complete lifetime history'));
  const {default:worker}=await import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync(path.join(__dirname,'../worker/index.js'),'utf8')).toString('base64'));
  const originalFetch=global.fetch;
  const events=Array.from({length:300},(_,i)=>({id:'event-'+i,mode:'demo',type:'video_play',timestamp:'2026-10-15T12:00:00Z'}));
  global.fetch=async()=>Response.json({content:Buffer.from(JSON.stringify({events})).toString('base64')});
  try {
    const compact=await (await worker.fetch(new Request('https://game.example/api/analytics'),{})).json();
    const full=await (await worker.fetch(new Request('https://game.example/api/analytics?view=full'),{})).json();
    assert.equal(compact.recentEvents.length,250);
    assert.equal(compact.events,undefined);
    assert.equal(full.events.length,300,'The live host exports beyond the recent activity preview');
  } finally {global.fetch=originalFetch;}
 console.log('PASS: report mode switching, all historical attempts, weighted user/video statistics, mode-scoped activity, full CSV downloads, empty headers, safe text and honest Endless coverage.');
})().catch(error=>{console.error(error);process.exitCode=1});
