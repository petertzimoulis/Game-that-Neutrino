const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const htmlNode = () => ({ innerHTML: '', textContent:'', classList: {toggle(){}}, querySelector(){ return null }, querySelectorAll(){return []} });
const nodes = new Map();
const memory = new Map();
const context = { console, process, memory, URLSearchParams, URL, Map, Set, Math, Date, Number, JSON, requestAnimationFrame:()=>{}, fetch:()=> new Promise(()=>{}), localStorage:{getItem:k=>memory.get(k),setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)}, window:{location:{search:'',href:'http://localhost/'},setInterval:()=>0,setTimeout:()=>0,addEventListener(){},history:{replaceState(){}},alert:()=>{}},document:{querySelector:sel=>{if(sel==='#intro-modal-root') return null;if(!nodes.has(sel))nodes.set(sel,htmlNode());return nodes.get(sel)},querySelectorAll:()=>[],addEventListener(){},body:{classList:{toggle(){}}}} };
vm.createContext(context);
// Isolate game rules from the automatic startup request, tested separately.
vm.runInContext(fs.readFileSync(require('path').join(__dirname,'../app.js'),'utf8').replace('\ninitializeSharedPlayers();', '\n'),context);
vm.runInContext(`
function check(value, message) { if (!value) throw new Error(message); }
check(getInitialSelectedMode() === 'demo', 'default demo');
check(Object.keys(MODE_CONFIGS).length===2 && MODE_CONFIGS.demo && MODE_CONFIGS.endless, 'only two current modes');
for (const retired of ['friday','quiz','quick']) {
 window.location.search='?mode='+retired;
 check(getRequestedMode()===null && getInitialSelectedMode()==='demo', 'retired links fall back to collaborator');
 check(normalizeStoredRun({mode:retired,answers:[]})===null, 'retired saved games cannot resume');
}
window.location.search='';
for (const test of [{total:0,count:0,want:0},{total:4,count:1,want:0},{total:5,count:1,want:2},{total:10,count:0,want:2},{total:10,count:9,want:0}]) {
 check(getCrowdBonus({totalResponses:test.total,trackCount:test.count,cascadeCount:test.total-test.count},'track',true) === test.want, 'bonus boundary '+JSON.stringify(test));
}
ALL_VIDEOS = Array.from({length:4},(_,group)=>Array.from({length:25},(_,i)=>({id:'new/Set '+group+'/'+i,sourceGroup:'Set '+group,correctChoice:'track',sectionId:'market',label:'Event '+i,src:'clip.mp4'}))).flat();
ALL_VIDEOS.push({id:'Low Energy Quiz/legacy',sourceGroup:'Low Energy Quiz',correctChoice:'track',sectionId:'low-energy',label:'Research clip',src:'research.mp4'});
ALL_VIDEOS_BY_ID = Object.fromEntries(ALL_VIDEOS.map(v=>[v.id,v]));
state.catalogLoaded=true;
for(let i=0;i<100;i++) { const order=buildRunVideoOrder('demo'); check(order.length===5 && new Set(order).size===5, 'five unique clips'); check(new Set(order.map(id=>ALL_VIDEOS_BY_ID[id].sourceGroup)).size===4,'all four new sets'); }
for (const retired of ['friday','quiz','quick']) {
 beginRun('Retired mode caller',retired);
 check(state.currentRun.mode==='demo', 'stale callers cannot create retired games');
}
beginRun('Presentation tester','demo');
check(isCurrentRunCompatible(state.currentRun), 'demo compatibility');
const id=state.currentRun.videoOrder[0];
state.demoPlayers=Array.from({length:5},(_,i)=>({id:'v'+i,answers:[{videoId:id,choice:i===0?'track':'cascade'}]}));
handleChoice('track');
check(state.currentRun.answers[0].crowdBonus===2 && state.currentRun.coins===13,'correct + minority bonus');
handleChoice('cascade');
check(state.currentRun.answers.length===1,'double click protected');
state.currentRun.phase='question';state.currentRun.currentIndex=1;
const id2=state.currentRun.videoOrder[1];
state.demoPlayers=Array.from({length:5},(_,i)=>({id:'z'+i,answers:[{videoId:id2,choice:i===0?'cascade':'track'}]}));
handleChoice('cascade');
check(state.currentRun.coins===12 && state.currentRun.answers[1].crowdBonus===0 && !state.currentRun.answers[1].correct,'incorrect minority receives no bonus');
state.currentRun.phase='question';state.currentRun.currentIndex=2;
state.currentRun.answers=[{correct:true,coinsAfter:11},{correct:true,coinsAfter:12}];state.currentRun.coins=12;
const id3=state.currentRun.videoOrder[2];
state.demoPlayers=Array.from({length:5},(_,i)=>({id:'q'+i,answers:[{videoId:id3,choice:i===0?'track':'cascade'}]}));
isDoubleDownSelected=()=>true;
handleChoice('track');
check(state.currentRun.coins===17,'hot hand + wager + crowd stack');

check(getCrowdBonus({totalResponses:5, trackCount:1},'track',false)===0, 'wrong answers never get crowd bonus');
state.currentRun.phase='question';
const trophyRun={name:'Trophy tester',mode:'demo',videoOrder:buildRunVideoOrder('demo'),answers:[]};
trophyRun.answers=trophyRun.videoOrder.map((id,i)=>({videoId:id,sourceGroup:ALL_VIDEOS_BY_ID[id].sourceGroup,correct:true,expectedChoice:i%2?'cascade':'track',crowdBonus:i===0?2:0}));
evaluateAchievements(trophyRun, false);
check(state.localTrophies['trophy tester'].unlocked.length===4,'answer-based trophies earned');
check(!state.localTrophies['trophy tester'].unlocked.includes('finisher'),'completion trophies withheld during run');
evaluateAchievements(trophyRun,true);
check(state.localTrophies['trophy tester'].unlocked.length===8,'eight distinct demo trophy goals');
evaluateAchievements(trophyRun,true);
check(state.localTrophies['trophy tester'].unlocked.length===8,'trophies never duplicate');
check(achievementConditions({...trophyRun, answers:trophyRun.answers.slice(0,4)},true)['perfect-demo']===false,'short run not perfect');
const demoWrong={...trophyRun,answers:trophyRun.answers.map(answer=>({...answer,correct:false}))};
check(achievementConditions(demoWrong,true)['demo-complete'],'demo participation trophy does not require a correct answer');
check(!achievementConditions(demoWrong,false)['demo-complete'],'demo trophy waits for completion');
check(!achievementConditions({...demoWrong,answers:demoWrong.answers.slice(0,4)},true)['demo-complete'],'partial demo cannot earn completion');
check(!achievementConditions({...demoWrong,mode:'quick'},true)['demo-complete'],'other modes cannot earn collaborator trophy');
const endlessBase={mode:'endless',answers:[],totalQuestions:0,totalCorrect:0,bestStreak:0};
for(const threshold of [10,50,100,250]) {
 check(!achievementConditions({...endlessBase,totalQuestions:threshold-1})['endless-'+threshold],'question milestone withheld before '+threshold);
 check(achievementConditions({...endlessBase,totalQuestions:threshold})['endless-'+threshold],'question milestone earned at '+threshold+' even with no correct calls');
 check(!achievementConditions({...endlessBase,mode:'demo',totalQuestions:threshold})['endless-'+threshold],'question milestone limited to Endless Mode');
}
check(!achievementConditions({...endlessBase,bestStreak:9})['endless-streak-10'],'ten-streak trophy withheld at nine');
check(achievementConditions({...endlessBase,bestStreak:10,correctStreak:0})['endless-streak-10'],'best streak survives a later mistake');
check(!achievementConditions({...endlessBase,totalCorrect:99})['endless-correct-100'],'hundred-correct trophy withheld at 99');
check(achievementConditions({...endlessBase,totalCorrect:100})['endless-correct-100'],'hundred correct uses lifetime totals instead of trimmed review');
const feedback=renderRunInsights(trophyRun);
check(!feedback.includes('Confidence check') && feedback.includes('New this run'), 'end feedback keeps trophies without confidence');
check(getActiveAchievementIds({unlocked:['first-call','sure-shot']}).length===1,'retired confidence trophy excluded from standings');

state.quickQuizLoaded=true;
getQuickQuizVideoCount=()=>1;
const quickId=ALL_VIDEOS[0].id;
state.currentRun={id:'quick-test',name:'Quick tester',mode:'quick',phase:'quick-question',videoGroups:{},videoOrder:[quickId],currentIndex:0,answers:[],coins:10};
state.quickQuizPlayers=Array.from({length:5},(_,i)=>({id:'quick'+i,name:'Quick '+i,answers:[{videoId:quickId,choice:i===0?'cascade':'track'}]}));
isDoubleDownSelected=()=>false;
answerQuizQuestion('cascade');
check(state.currentRun.answers[0].crowdBonus===0 && state.currentRun.coins===9,'quick wrong minority gets no bonus');
check(!Object.hasOwn(state.currentRun.answers[0],'confidence'),'quick answer has no confidence field');
const quizRun={mode:'quiz',videoOrder:[quickId],quizChoices:{}};
check(!renderQuizVideoCard(quizRun,quickId,0).includes('confidence'), 'learning quiz has no confidence controls or flair');
check(renderQuizReviewCard({videoId:quickId,choice:'track',expectedChoice:'track',correct:true}).includes('Stored exactly as submitted.'),'answer review has no confidence label');
state.currentRun=trophyRun;state.currentRun.coins=15;state.demoPlayers=[];
finalizeRun().then(async ()=>{
 check(!state.currentRun && state.pendingCollaboratorRuns.length===1 && state.lastCompletedRun.mode==='demo','completion queued durably');
 check(state.demoPlayers.length===0,'pending local score is not shown as a global result');
 check(getCollaboratorRunStatus(state.lastCompletedRun).includes('waiting to upload'),'pending score status is truthful');
 sharedRequests.clear();
 state.syncingCollaboratorPlayers=false;
 fetch=async()=>{throw new Error('offline');};
 await syncCollaboratorPlayersFromServer();
 check(state.pendingCollaboratorRuns.length===1,'failed upload retains run');
 const completed=state.lastCompletedRun;
 let submitted=false;
 fetch=async(url,options)=>{
   if(options.method==='POST') { submitted=true; check(JSON.parse(options.body).id===completed.id,'same run ID on retry'); }
   return {ok:true,json:async()=>({players:submitted?[completed]:[],history:submitted?[completed]:[],updatedAt:submitted?'saved':null})};
 };
 await syncCollaboratorPlayersFromServer();
 check(submitted && state.pendingCollaboratorRuns.length===0 && state.demoPlayers.length===1,'retry uploads to global board');
 check(!getCollaboratorRunStatus(completed).includes('waiting'),'saved run status confirms global persistence');
 check(JSON.parse(memory.get(STORAGE_KEYS.pendingCollaboratorRuns)).length===0,'confirmed upload removed from durable queue');
 localStorage.removeItem(STORAGE_KEYS.collaboratorMigration);
 const historical={...completed,id:'old-fifteen',answers:Array.from({length:15},()=>({}))};
 saveStorage(STORAGE_KEYS.demoPlayers,[completed,completed,historical]);
 const migrated=loadPendingCollaboratorRuns();
 check(migrated.length===1 && migrated[0].id===completed.id,'five-question legacy scores migrate once without duplicates');
 check(loadPendingCollaboratorRuns().length===1,'migration queue survives reload without reimporting');
 globalThis.ruleChecksFinished = true;
 console.log('PASS: five clips across all sets, correct-only crowd bonus, streak/wager scoring, demo and Endless trophy boundaries, durable global submission, offline retry, and confirmed shared standings.');
}).catch(error=>{console.error(error);process.exitCode=1;});
`,context);

process.on('beforeExit', () => { if (!context.ruleChecksFinished) { console.error('Game rule checks did not finish'); process.exitCode = 1; } });
