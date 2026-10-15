// Endless runs keep lifetime counters and a bounded deck/review, so saves never grow with play time.
const API_ENDLESS_PLAYERS_URL = "/api/endless-players";

function endlessKey() {
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  return [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
}

function endlessDeck(previousId = null) {
  const deck = shuffleList(getCollaboratorVideos().map(video => video.id));
  if (deck.length > 1 && deck[0] === previousId) [deck[0], deck[1]] = [deck[1], deck[0]];
  return deck;
}

function beginEndlessRun(rawName) {
  if (state.savedEndlessRun) { resumeEndlessRun(); return; }
  const name = rawName.trim();
  if (!name || !getCollaboratorVideos().length) return;
  state.lastName = name;
  state.selectedMode = "endless";
  state.lastCompletedRun = null;
  state.currentRun = {
    id: `endless-${Date.now()}-${createSessionId()}`, mode: "endless", name, nameKey: normalizeName(name),
    checkpointKey: endlessKey(), startedAt: new Date().toISOString(),
    videoOrder: endlessDeck(), currentIndex: 0, phase: "question", answers: [],
    totalQuestions: 0, totalCorrect: 0, trackCorrect: 0, cascadeCorrect: 0,
    coins: 10, correctStreak: 0, bestStreak: 0, questionStartedAt: new Date().toISOString(),
  };
  saveStorage(STORAGE_KEYS.lastName, name);
  saveStorage(STORAGE_KEYS.selectedMode, "endless");
  persistEndlessRun();
  render();
}

function persistEndlessRun() {
  const run = state.currentRun;
  if (run?.mode !== "endless") return;
  state.savedEndlessRun = run;
  saveStorage(STORAGE_KEYS.savedEndlessRun, run);
  saveStorage(STORAGE_KEYS.currentRun, run);
}

function isValidEndlessRun(run) {
  return run?.mode === "endless" && typeof run.checkpointKey === "string" && /^[a-f0-9]{64}$/.test(run.checkpointKey) &&
    Array.isArray(run.videoOrder) && run.videoOrder.length > 0 && run.videoOrder.length <= 100 &&
    new Set(run.videoOrder).size === run.videoOrder.length &&
    run.videoOrder.every(id => ALL_VIDEOS_BY_ID[id]?.sectionId === "market") &&
    Number.isInteger(run.currentIndex) && run.currentIndex >= 0 && run.currentIndex < run.videoOrder.length &&
    Number.isSafeInteger(run.totalQuestions) && run.totalQuestions >= 0 &&
    Number.isSafeInteger(run.totalCorrect) && run.totalCorrect >= 0 && run.totalCorrect <= run.totalQuestions &&
    Array.isArray(run.answers) && run.answers.length <= 10 && ["question", "feedback"].includes(run.phase);
}

function resumeEndlessRun() {
  const run = state.savedEndlessRun;
  if (!run) return;
  if (!isValidEndlessRun(run)) {
    // A replaced catalog gets a fresh deck while lifetime totals stay intact.
    run.videoOrder = endlessDeck();
    run.currentIndex = 0;
    run.phase = "question";
  }
  if (!run.videoOrder.length) return;
  state.currentRun = run;
  state.lastCompletedRun = null;
  state.selectedMode = "endless";
  run.questionStartedAt = new Date().toISOString();
  evaluateAchievements(run);
  persistEndlessRun();
  render();
  void syncEndlessFromServer({refresh:true});
}

function endlessRecord(run, isCompleted = false) {
  return {
    id: run.id, mode: "endless", name: run.name, nameKey: run.nameKey, startedAt: run.startedAt,
    updatedAt: new Date().toISOString(), completedAt: isCompleted ? new Date().toISOString() : null,
    totalQuestions: run.totalQuestions, totalCorrect: run.totalCorrect,
    totalAccuracy: run.totalQuestions ? run.totalCorrect / run.totalQuestions : 0,
    finalCoins: run.coins, bestStreak: run.bestStreak, isCompleted,
  };
}

function queueEndlessCheckpoint(run, finished = false) {
  if (!run.totalQuestions) return;
  const checkpoint = {...endlessRecord(run, finished), checkpointKey: run.checkpointKey};
  state.pendingEndlessRuns = [...state.pendingEndlessRuns.filter(record => record.id !== run.id), checkpoint];
  saveStorage(STORAGE_KEYS.endlessOutbox, state.pendingEndlessRuns);
  void syncEndlessFromServer();
}

function handleEndlessChoice(choice) {
  const run = state.currentRun;
  if (run?.mode !== "endless" || run.phase !== "question" || !["track", "cascade"].includes(choice)) return;
  const video = ALL_VIDEOS_BY_ID[run.videoOrder[run.currentIndex]];
  if (!video) return;
  const correct = choice === video.correctChoice;
  const doubleDown = isDoubleDownSelected();
  const streakBonusApplied = correct && run.correctStreak >= 2;
  const coinsBefore = run.coins;
  const gain = correct ? (doubleDown ? (streakBonusApplied ? 3 : 2) : (streakBonusApplied ? 2 : 1)) : (doubleDown ? -2 : -1);
  run.coins += gain;
  run.totalQuestions++;
  run.totalCorrect += correct ? 1 : 0;
  run.correctStreak = correct ? run.correctStreak + 1 : 0;
  run.bestStreak = Math.max(run.bestStreak, run.correctStreak);
  if (correct) run[video.correctChoice === "track" ? "trackCorrect" : "cascadeCorrect"]++;
  run.answers = [...run.answers, {
    videoId: video.id, videoLabel: video.label, sourceGroup: video.sourceGroup,
    expectedChoice: video.correctChoice, choice, correct, questionNumber: run.totalQuestions,
    coinsBefore, coinsAfter: run.coins, doubleDown, streakBonusApplied, streakAfter: run.correctStreak,
    ...getCurrentQuestionTiming(run.questionStartedAt),
  }].slice(-10);
  run.phase = "feedback";
  evaluateAchievements(run);
  persistEndlessRun();
  queueEndlessCheckpoint(run);
  render();
}

function advanceEndlessRun() {
  const run = state.currentRun;
  if (run?.mode !== "endless" || run.phase !== "feedback") return;
  const previousId = run.videoOrder[run.currentIndex];
  run.currentIndex++;
  if (run.currentIndex >= run.videoOrder.length) {
    run.videoOrder = endlessDeck(previousId);
    run.currentIndex = 0;
  }
  run.phase = "question";
  run.questionStartedAt = new Date().toISOString();
  persistEndlessRun();
  render();
}

function pauseEndlessRun() {
  const run = state.currentRun;
  if (run?.mode !== "endless") return;
  persistEndlessRun();
  queueEndlessCheckpoint(run);
  state.currentRun = null;
  state.lastCompletedRun = null;
  state.selectedMode = "endless";
  localStorage.removeItem(STORAGE_KEYS.currentRun);
  render();
  if (typeof saveAccountProgress === "function") void saveAccountProgress();
}

function finishEndlessRun() {
  const run = state.currentRun?.mode === "endless" ? state.currentRun : state.savedEndlessRun;
  if (!run) return;
  if (run.totalQuestions) {
    evaluateAchievements(run, true);
    state.lastCompletedRun = {...endlessRecord(run, true), answers: run.answers};
    queueEndlessCheckpoint(run, true);
  } else state.lastCompletedRun = null;
  state.savedEndlessRun = null;
  state.currentRun = null;
  state.selectedMode = "endless";
  saveStorage(STORAGE_KEYS.savedEndlessRun, null);
  localStorage.removeItem(STORAGE_KEYS.currentRun);
  render();
}

function compareEndlessRuns(left, right) {
  return (right.totalCorrect || 0) - (left.totalCorrect || 0) ||
    (right.totalAccuracy || 0) - (left.totalAccuracy || 0) ||
    (right.finalCoins || 0) - (left.finalCoins || 0) ||
    `${left.name}`.localeCompare(`${right.name}`);
}

function mergeEndlessPlayers(players) {
  const runs = new Map();
  for (const player of players.filter(Boolean)) {
    const old = runs.get(player.id);
    if (!old || player.totalQuestions > old.totalQuestions ||
        (player.totalQuestions === old.totalQuestions && player.isCompleted)) runs.set(player.id, player);
  }
  const best = new Map();
  for (const player of runs.values()) {
    const old = best.get(player.nameKey);
    if (!old || compareEndlessRuns(player, old) < 0 || (compareEndlessRuns(player, old) === 0 && player.id === old.id && player.isCompleted)) best.set(player.nameKey, player);
  }
  return [...best.values()].sort(compareEndlessRuns);
}

async function syncEndlessFromServer({refresh = false} = {}) {
  if (state.endlessSyncing) { state.endlessRefreshRequested ||= refresh; return; }
  state.endlessSyncing = true;
  const owner = progressStorageOwner;
  let succeeded = false;
  try {
    for (const checkpoint of [...state.pendingEndlessRuns]) {
      const response = await fetch(API_ENDLESS_PLAYERS_URL, {method:"POST", headers:{"Content-Type":"application/json", "X-Neutrino-State-Epoch":GAME_STATE_EPOCH}, body:JSON.stringify(checkpoint)});
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not sync your Endless Mode checkpoint.");
      if (owner !== progressStorageOwner) return;
      state.endlessPlayers = mergeEndlessPlayers([...state.endlessPlayers, payload.record, payload.player]);
      state.pendingEndlessRuns = state.pendingEndlessRuns.filter(record => record.id !== checkpoint.id || JSON.stringify(record) !== JSON.stringify(checkpoint));
      saveStorage(STORAGE_KEYS.endlessOutbox, state.pendingEndlessRuns);
    }
    if (refresh || state.endlessRefreshRequested || !state.endlessLoaded) {
      state.endlessRefreshRequested = false;
      const payload = await fetchSharedJson(API_ENDLESS_PLAYERS_URL);
      state.endlessPlayers = mergeEndlessPlayers([...state.endlessPlayers, ...(payload.players || [])]);
    }
    state.endlessLoaded = true;
    state.endlessError = null;
    succeeded = true;
  } catch (error) {
    state.endlessLoaded = true;
    state.endlessError = error instanceof Error ? error.message : "Endless standings are temporarily unavailable.";
  } finally {
    state.endlessSyncing = false;
    if (!state.currentRun || state.showAnalysis) render();
    if (succeeded && owner === progressStorageOwner && (state.pendingEndlessRuns.length || state.endlessRefreshRequested)) window.setTimeout(() => { void syncEndlessFromServer(); }, 500);
  }
}

function renderEndlessSyncStatus() {
  if (state.endlessError) return `<p class="subtle-copy" role="status">${escapeHtml(state.endlessError)} Your run stays saved on this device. <button class="endless-text-button" data-endless-action="retry">Retry leaderboard sync</button></p>`;
  return `<p class="subtle-copy" role="status">${state.pendingEndlessRuns.length ? "Syncing saved checkpoints…" : "Best run per player · checkpoints count while you play"}</p>`;
}

function renderEndlessLandingContent() {
  const run = state.savedEndlessRun;
  return {
    hero: `<p class="eyebrow">Endless Mode</p><h2 class="hero-title">One more neutrino.</h2><p class="hero-copy">Keep calling Tracks and Cascades for as long as you like. Every full pass reshuffles the 100-video catalog. Pause whenever you need a break.</p><div class="demo-facts"><span>No question limit</span><span>Save &amp; resume</span><span>Own leaderboard</span></div>${run ? `<div class="endless-saved"><h3 class="card-title">Continue ${escapeHtml(run.name)}’s run</h3><p>${run.totalQuestions} answered · ${run.totalCorrect} correct · ${run.coins} coins</p><div class="button-row"><button class="primary-button" data-endless-action="resume">Resume saved run</button><button class="ghost-button" data-endless-action="finish">Finish saved run</button></div></div>` : renderStartForm({buttonLabel:"Start endless run",helperCopy:"Start with 10 coins. Correct calls add coins, mistakes subtract them, and streaks earn more. Your run continues even if your coins drop below zero."})}<p class="endless-save-note">${typeof accountState !== "undefined" && accountState.user ? "Saved to your account so you can continue on another device." : "Guest progress stays on this device. Log in to save and resume across devices."}</p>`,
    aside: `<div class="demo-aside-heading"><p class="eyebrow">Keep going</p><h3 class="card-title">Your best run counts.</h3></div><p class="hero-copy">Ranked by total correct calls, then accuracy and coins. Checkpoints update the Endless leaderboard while you play. Each player keeps their best run.</p><p class="subtle-copy">Pause &amp; save keeps the same run open. Finish run closes it and lets you start a new one. Endless results stay separate from the other leaderboards.</p>`,
  };
}

function renderEndlessLeaderboard(players = state.endlessPlayers) {
  const board = [...players].sort(compareEndlessRuns);
  return board.length ? `<div class="leaderboard-scroll"><table class="leaderboard-table endless-leaderboard-table"><thead><tr><th>Rank</th><th>Player</th><th>Correct</th><th>Accuracy</th><th>Coins</th></tr></thead><tbody>${board.map((player,index) => `<tr><td>#${index+1}</td><td>${escapeHtml(player.name)}<small>${player.isCompleted ? "Finished" : "In progress"}</small></td><td>${player.totalCorrect}<small>/ ${player.totalQuestions} answered</small></td><td>${formatPercent(player.totalAccuracy)}</td><td>${player.finalCoins}</td></tr>`).join("")}</tbody></table></div>` : `<p class="empty-note">${state.endlessLoaded ? "Make your first call to join the Endless leaderboard." : "Loading Endless standings…"}</p>`;
}

function renderEndlessToolbar(run) {
  return `<div class="endless-toolbar"><div><strong>${run.totalCorrect} correct / ${run.totalQuestions} answered</strong><span>${formatPercent(run.totalQuestions ? run.totalCorrect / run.totalQuestions : 0)} accuracy · Best streak ${run.bestStreak}</span></div><div class="button-row"><button class="secondary-button" data-endless-action="pause">Pause &amp; save</button><button class="ghost-button" data-endless-action="finish">Finish run</button><button class="ghost-button" data-action="open-analysis">Endless leaderboard</button></div></div>`;
}

function renderEndlessRunView(run) {
  const answer = run.answers[run.answers.length - 1];
  if (run.phase === "feedback" && answer) return `<section class="panel appear"><div class="panel-inner feedback-layout"><div><p class="eyebrow">Endless Mode · Question ${run.totalQuestions}</p><h2 class="hero-title">${escapeHtml(answer.videoLabel)}: locked in</h2><div class="feedback-pill ${answer.correct ? "" : "loss"}"><strong>${answer.correct ? "Correct call" : "Marked wrong"}</strong><span>Answer key: ${titleCase(answer.expectedChoice)}.</span></div></div><div class="feedback-grid"><div class="feedback-card"><span>Your call</span><strong>${titleCase(answer.choice)}</strong></div><div class="feedback-card"><span>Coins</span><strong>${run.coins} (${run.coins - answer.coinsBefore >= 0 ? "+" : ""}${run.coins - answer.coinsBefore})</strong></div><div class="feedback-card"><span>Current streak</span><strong>${run.correctStreak}</strong></div></div><button class="primary-button endless-next" data-endless-action="next">Next video</button>${renderEndlessToolbar(run)}</div></section>`;
  const video = ALL_VIDEOS_BY_ID[run.videoOrder[run.currentIndex]];
  return `<section class="panel appear game-panel"><div class="panel-inner game-panel-inner"><div class="game-header endless-game-header"><div><p class="eyebrow">Endless Mode</p><h2 class="hero-title">Keep reading the light.</h2><p class="game-copy">Question ${run.totalQuestions + 1} · ${escapeHtml(run.name)} · No finish line</p></div><div class="wallet-card"><span>Coin bank</span><strong>${run.coins}</strong></div></div>${renderEndlessToolbar(run)}<div class="play-stage"><div class="video-column"><div class="section-pill"><strong>${escapeHtml(video.label)}</strong><span>${escapeHtml(video.sourceGroup)}</span></div><div class="video-shell game-video-shell"><video controls autoplay loop muted playsinline preload="metadata" data-autoplay="true" src="${escapeHtml(video.src)}"></video></div></div><div class="decision-column"><div class="decision-card"><p class="subtle-copy">Correct: +1 coin. After two correct calls in a row, each next correct call earns +2. A mistake costs 1 coin and resets the streak.</p><label class="wager-toggle" for="double-down-toggle"><input id="double-down-toggle" type="checkbox" data-double-down /><span class="wager-copy"><strong>Double or Nothing</strong><span>Hit: +2, or +3 with a hot hand. Miss: −2.</span></span></label><div class="choice-grid">${renderChoiceButton({choice:"track",label:"Track",description:"An elongated trail.",variant:"track",percentage:null,totalResponses:0})}${renderChoiceButton({choice:"cascade",label:"Cascade",description:"A compact shower of light.",variant:"cascade",percentage:null,totalResponses:0})}</div><button class="ghost-button" data-action="open-help">Track vs Cascade help</button></div><p class="endless-save-note">Progress saves after every answer. Pause &amp; save to come back later.</p></div></div></div></section>`;
}

function renderEndlessResultsView(run) {
  return `<section class="results-layout appear"><article class="panel"><div class="panel-inner"><p class="eyebrow">Endless Mode · Run finished</p><h2 class="hero-title">${escapeHtml(run.name)}, that’s a run.</h2><div class="endless-saved"><strong>${run.totalCorrect} correct / ${run.totalQuestions} answered</strong><p>${formatPercent(run.totalAccuracy)} accuracy · ${run.finalCoins} coins · Best streak ${run.bestStreak}</p></div>${renderEndlessSyncStatus()}<div class="button-row"><button class="primary-button" data-action="play-again">Start another endless run</button><button class="ghost-button" data-action="go-home">Home</button></div></div></article><aside class="panel"><div class="panel-inner"><h2 class="card-title">Endless leaderboard</h2>${renderEndlessLeaderboard()}</div></aside></section>`;
}

document.addEventListener("click", event => {
  const button = event.target.closest("[data-endless-action]");
  if (!button) return;
  const actions = {resume:resumeEndlessRun, pause:pauseEndlessRun, finish:finishEndlessRun, next:advanceEndlessRun, retry:() => { void syncEndlessFromServer({refresh:true}); }};
  actions[button.dataset.endlessAction]?.();
});
window.addEventListener("online", () => { void syncEndlessFromServer({refresh:true}); });
