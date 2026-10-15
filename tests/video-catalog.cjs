// Exercise the actual shipped manifests, filenames, answer keys and sampling.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const element = () => ({innerHTML:'', classList:{toggle(){}}, querySelector(){return null}, querySelectorAll(){return []}});
const context = {
  console, URL, URLSearchParams, Map, Set, Math, Date, Number, JSON,
  requestAnimationFrame(){},
  localStorage:{getItem(){return null},setItem(){},removeItem(){}},
  window:{location:{search:'',href:'http://localhost/'},setInterval(){},setTimeout(){},addEventListener(){}},
  document:{querySelector:selector=>selector==='#intro-modal-root'?null:element(),querySelectorAll:()=>[],addEventListener(){},body:{classList:{toggle(){}}}},
  fetch:()=>new Promise(()=>{}),
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace('\ninitializeSharedPlayers();', '\n'), context);
context.fetch = async url => ({ok:true,text:async()=>fs.readFileSync(path.join(root, decodeURIComponent(url)), 'utf8')});
context.check = (value, message) => assert.ok(value, message);
context.checkVideo = video => {
  const local = path.join(root, decodeURIComponent(video.src));
  assert.ok(fs.statSync(local).size > 0, `Playable file: ${video.src}`);
  assert.ok(!video.src.includes('%2F'), 'Folder separators remain URL path separators');
  if (video.sectionId === 'market') {
    const expected = video.id.includes('/track_') ? 'track' : 'cascade';
    assert.equal(video.correctChoice, expected, `Answer key: ${video.id}`);
    assert.match(video.sourceGroup, /^Set [1-4]$/, 'Neutral set labels');
  }
};
const verify = vm.runInContext(`(async () => {
  render = () => {};
  const {videos} = await loadVideoCatalog();
  ALL_VIDEOS = videos;
  ALL_VIDEOS_BY_ID = Object.fromEntries(videos.map(video => [video.id, video]));
  videos.forEach(checkVideo);
  const clips = getCollaboratorVideos();
  check(clips.length === 100, 'All 100 replacement clips load');
  check(new Set(clips.map(video => video.id)).size === 100, 'Unique full-path video IDs');
  check(clips.filter(video => video.correctChoice === 'track').length === 50, '50 Tracks');
  check(clips.filter(video => video.correctChoice === 'cascade').length === 50, '50 Cascades');
  for (const group of new Set(clips.map(video => video.sourceGroup))) {
    check(clips.filter(video => video.sourceGroup === group).length === 25, '25 clips per set');
  }
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const videoOrder = buildRunVideoOrder('demo');
    check(videoOrder.length === 5 && new Set(videoOrder).size === 5, 'Five unique questions');
    check(new Set(videoOrder.map(id => ALL_VIDEOS_BY_ID[id].sourceGroup)).size === 4, 'All four sets represented');
    check(isCurrentRunCompatible({mode:'demo', videoOrder}), 'Replacement run resumes');
    videoOrder.forEach(id => seen.add(id));
  }
  check(seen.size === 100, 'Every replacement clip is reachable');
  const oldRun = {mode:'demo',videoOrder:Array.from({length:5},(_,i)=>'Group 1/old-'+i+'.mp4')};
  check(!isCurrentRunCompatible(oldRun), 'Retired in-progress runs are rejected');
  state.currentRun = oldRun;
  ensureCurrentRunVideoOrder();
  check(state.currentRun === null, 'Retired saved runs are cleared');
  const order = buildRunVideoOrder('demo');
  order[0] = videos.find(video => video.sectionId === 'low-energy').id;
  check(!isCurrentRunCompatible({mode:'demo',videoOrder:order}), 'Research clips cannot enter a collaborator run');
  check(!PLAYABLE_MODES.includes('quick') && !PLAYABLE_MODES.includes('quiz'), 'Retired research modes cannot be selected');
  window.NEUTRINO_CONFIG = {videoBaseUrl:'https://media.example.test'};
  const clip = clips[0];
  const cdn = buildVideoUrl(MANIFEST_SOURCES[0].folderName, clip.id.slice(MANIFEST_SOURCES[0].folderName.length + 1));
  check(cdn === 'https://media.example.test/' + clip.src, 'Nested clip URLs support the media CDN');
})()`, context);
verify.then(()=>console.log('PASS: all 100 new clips, exact filenames and answer keys, four-set sampling, saved-run replacement, retired mode removal and nested CDN URLs.'))
  .catch(error=>{console.error(error);process.exitCode=1;});
