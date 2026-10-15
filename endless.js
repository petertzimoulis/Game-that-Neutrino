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

function endlessProfileName(rawName) {
  return (typeof accountState !== "undefined" && accountState.user ? accountState.user.username : rawName || state.lastName || "").trim();
}

function endlessProfileKey(name) {
  return `player:${normalizeName(endlessProfileName(name))}`;
}

function saveEndlessProfile(run) {
  if (!run || run.mode !== "endless") return;
  state.endlessProfiles = {...state.endlessProfiles, [endlessProfileKey(run.name)]: run};
  saveStorage(STORAGE_KEYS.endlessProfiles, state.endlessProfiles);
}

function getEndlessProfile(name) {
  // Adopt the previous single-profile save without ever assigning another guest's game.
  const saved = state.savedEndlessRun;
  if (saved && (normalizeName(saved.name) === normalizeName(endlessProfileName(name)) ||
      (typeof accountState !== "undefined" && accountState.user))) saveEndlessProfile(saved);
  return state.endlessProfiles?.[endlessProfileKey(name)] || null;
}

function beginEndlessRun(rawName) {
  const name = endlessProfileName(rawName);
  if (!name || !getCollaboratorVideos().length) return;
  if (state.currentRun?.mode === "endless") persistEndlessRun();
  if (getEndlessProfile(name)) { resumeEndlessRun(name); return; }
  state.lastName = name;
  state.selectedMode = "endless";
  state.lastCompletedRun = null;
  state.currentRun = {
    id: `endless-${Date.now()}-${createSessionId()}`, mode: "endless", name, nameKey: normalizeName(name),
    checkpointKey: endlessKey(), startedAt: new Date().toISOString(),
    videoOrder: endlessDeck(), currentIndex: 0, phase: "question", answers: [],
    totalQuestions: 0, totalCorrect: 0, trackCorrect: 0, cascadeCorrect: 0,
    coins: 10, walletResets: 0, correctStreak: 0, bestStreak: 0, questionStartedAt: new Date().toISOString(),
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
  saveEndlessProfile(run);
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

function resumeEndlessRun(rawName = state.savedEndlessRun?.name || state.lastName) {
  const run = getEndlessProfile(rawName);
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
  state.lastName = run.name;
  saveStorage(STORAGE_KEYS.lastName, run.name);
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
    finalCoins: run.coins, bestStreak: run.bestStreak, walletResets: run.walletResets || 0, isCompleted,
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

function resetEndlessWallet(rawName = state.lastName || state.savedEndlessRun?.name) {
  const run = state.currentRun?.mode === "endless" ? state.currentRun : getEndlessProfile(rawName);
  if (!run) return;
  const playing = state.currentRun?.mode === "endless";
  // Advance past an already answered clip before returning to the question view.
  if (run.phase === "feedback") {
    const previousId = run.videoOrder[run.currentIndex];
    run.currentIndex++;
    if (run.currentIndex >= run.videoOrder.length) { run.videoOrder = endlessDeck(previousId); run.currentIndex = 0; }
  }
  run.coins = 10;
  run.correctStreak = 0;
  run.walletResets = (run.walletResets || 0) + 1;
  run.phase = "question";
  run.questionStartedAt = new Date().toISOString();
  state.lastCompletedRun = null;
  if (playing) persistEndlessRun();
  else { state.savedEndlessRun = run; saveEndlessProfile(run); saveStorage(STORAGE_KEYS.savedEndlessRun, run); }
  queueEndlessCheckpoint(run);
  trackEvent("endless_wallet_reset", {mode:"endless",nameKey:run.nameKey,runId:run.id,walletResets:run.walletResets});
  render();
  if (typeof saveAccountProgress === "function") void saveAccountProgress();
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
    if (!old || (player.walletResets || 0) > (old.walletResets || 0) ||
        ((player.walletResets || 0) === (old.walletResets || 0) && (player.totalQuestions > old.totalQuestions ||
        (player.totalQuestions === old.totalQuestions && player.isCompleted)))) runs.set(player.id, player);
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
  return `<p class="subtle-copy" role="status">${state.pendingEndlessRuns.length ? "Syncing saved progress…" : "Lifetime progress per player · continues across visits"}</p>`;
}

function renderEndlessLandingContent() {
  const run = getEndlessProfile(state.lastName || state.savedEndlessRun?.name);
  const signedIn = typeof accountState !== "undefined" && accountState.user;
  const start = signedIn
    ? `<button class="primary-button" data-endless-action="start-profile" data-endless-name="${escapeHtml(accountState.user.username)}">Start as ${escapeHtml(accountState.user.username)}</button><p class="subtle-copy">Your account keeps one continuing Endless profile, starting with 10 coins.</p>`
    : renderStartForm({buttonLabel:"Continue or start Endless Mode",helperCopy:"Use the same player name to continue your saved coins and lifetime progress. A new player starts with 10 coins."});
  return {
    hero: `<p class="eyebrow">Endless Mode</p><h2 class="hero-title">One more neutrino.</h2><p class="hero-copy">One continuing journey per player. Your coins, questions, and accuracy carry over whenever you return. Every full pass reshuffles the 100-video catalog.</p><div class="demo-facts"><span>Lifetime progress</span><span>Coins carry over</span><span>Reset wallet to 10</span></div>${run ? `<div class="endless-saved"><h3 class="card-title">Continue ${escapeHtml(run.name)}’s progress</h3><p>${run.totalQuestions} answered · ${run.totalCorrect} correct · ${run.coins} coins</p><div class="button-row"><button class="primary-button" data-endless-action="resume" data-endless-name="${escapeHtml(run.name)}">Continue playing</button><button class="ghost-button" data-endless-action="reset-wallet" data-endless-name="${escapeHtml(run.name)}">Reset to 10 coins</button></div><p class="subtle-copy">Resetting the wallet clears your current streak. Lifetime questions, accuracy, best streak, and trophies stay saved.</p></div>${signedIn ? "" : `<details class="missed-review"><summary>Switch player</summary>${start}</details>`}` : start}<p class="endless-save-note">${signedIn ? "Your continuing progress saves to your account across visits and devices." : "Guest progress is saved separately for each player name on this browser. Accounts can continue across devices when supported by the host."}</p>`,
    aside: `<div class="demo-aside-heading"><p class="eyebrow">Keep going</p><h3 class="card-title">Your progress keeps counting.</h3></div><p class="hero-copy">Questions and correct calls belong to your player profile, across every visit. Pause whenever you need a break; there is no session finish line.</p><p class="subtle-copy">Reset to 10 coins gives your wallet a fresh start without erasing lifetime statistics or earned trophies. Endless results stay separate from the other leaderboards.</p>`,
  };
}

function renderEndlessLeaderboard(players = state.endlessPlayers) {
  const board = [...players].sort(compareEndlessRuns);
  return board.length ? `<div class="leaderboard-scroll"><table class="leaderboard-table endless-leaderboard-table"><thead><tr><th>Rank</th><th>Player</th><th>Correct</th><th>Accuracy</th><th>Coins</th></tr></thead><tbody>${board.map((player,index) => `<tr><td>#${index+1}</td><td>${escapeHtml(player.name)}<small>${player.isCompleted ? "Archived run" : "Lifetime progress"}</small></td><td>${player.totalCorrect}<small>/ ${player.totalQuestions} answered</small></td><td>${formatPercent(player.totalAccuracy)}</td><td>${player.finalCoins}</td></tr>`).join("")}</tbody></table></div>` : `<p class="empty-note">${state.endlessLoaded ? "Make your first call to join the Endless leaderboard." : "Loading Endless standings…"}</p>`;
}

function renderEndlessToolbar(run) {
  return `<div class="endless-toolbar"><div><strong>${run.totalCorrect} correct / ${run.totalQuestions} lifetime answers</strong><span>${formatPercent(run.totalQuestions ? run.totalCorrect / run.totalQuestions : 0)} accuracy · Best streak ${run.bestStreak} · ${run.walletResets || 0} wallet resets</span></div><div class="button-row"><button class="secondary-button" data-endless-action="pause">Pause &amp; save</button><button class="ghost-button" data-endless-action="reset-wallet">Reset to 10 coins</button><button class="ghost-button" data-action="open-analysis">Analysis &amp; Export</button></div><p class="subtle-copy">Resetting clears coins and the current streak; lifetime stats and trophies stay saved.</p></div>`;
}

function renderEndlessRunView(run) {
  const answer = run.answers[run.answers.length - 1];
  if (run.phase === "feedback" && answer) return `<section class="panel appear"><div class="panel-inner feedback-layout"><div><p class="eyebrow">Endless Mode · Question ${run.totalQuestions}</p><h2 class="hero-title">${escapeHtml(answer.videoLabel)}: locked in</h2><div class="feedback-pill ${answer.correct ? "" : "loss"}"><strong>${answer.correct ? "Correct call" : "Marked wrong"}</strong><span>Answer key: ${titleCase(answer.expectedChoice)}.</span></div></div><div class="feedback-grid"><div class="feedback-card"><span>Your call</span><strong>${titleCase(answer.choice)}</strong></div><div class="feedback-card"><span>Coins</span><strong>${run.coins} (${run.coins - answer.coinsBefore >= 0 ? "+" : ""}${run.coins - answer.coinsBefore})</strong></div><div class="feedback-card"><span>Current streak</span><strong>${run.correctStreak}</strong></div></div><button class="primary-button endless-next" data-endless-action="next">Next video</button>${renderEndlessToolbar(run)}</div></section>`;
  const video = ALL_VIDEOS_BY_ID[run.videoOrder[run.currentIndex]];
  return `<section class="panel appear game-panel"><div class="panel-inner game-panel-inner"><div class="game-header endless-game-header"><div><p class="eyebrow">Endless Mode</p><h2 class="hero-title">Keep reading the light.</h2><p class="game-copy">Question ${run.totalQuestions + 1} · ${escapeHtml(run.name)} · No finish line</p></div><div class="wallet-card"><span>Coin bank</span><strong>${run.coins}</strong></div></div>${renderEndlessToolbar(run)}<div class="play-stage"><div class="video-column"><div class="section-pill"><strong>${escapeHtml(video.label)}</strong><span>${escapeHtml(video.sourceGroup)}</span></div><div class="video-shell game-video-shell"><video controls autoplay loop muted playsinline preload="metadata" data-autoplay="true" src="${escapeHtml(video.src)}"></video></div></div><div class="decision-column"><div class="decision-card"><p class="subtle-copy">Correct: +1 coin. After two correct calls in a row, each next correct call earns +2. A mistake costs 1 coin and resets the streak.</p><label class="wager-toggle" for="double-down-toggle"><input id="double-down-toggle" type="checkbox" data-double-down /><span class="wager-copy"><strong>Double or Nothing</strong><span>Hit: +2, or +3 with a hot hand. Miss: −2.</span></span></label><div class="choice-grid">${renderChoiceButton({choice:"track",label:"Track",description:"An elongated trail.",variant:"track",percentage:null,totalResponses:0})}${renderChoiceButton({choice:"cascade",label:"Cascade",description:"A compact shower of light.",variant:"cascade",percentage:null,totalResponses:0})}</div><button class="ghost-button" data-action="open-help">Track vs Cascade help</button></div><p class="endless-save-note">Progress saves after every answer. Pause &amp; save to come back later.</p></div></div></div></section>`;
}

function renderEndlessResultsView(run) {
  return `<section class="results-layout appear"><article class="panel"><div class="panel-inner"><p class="eyebrow">Endless Mode · Run finished</p><h2 class="hero-title">${escapeHtml(run.name)}, that’s a run.</h2><div class="endless-saved"><strong>${run.totalCorrect} correct / ${run.totalQuestions} answered</strong><p>${formatPercent(run.totalAccuracy)} accuracy · ${run.finalCoins} coins · Best streak ${run.bestStreak}</p></div>${renderEndlessSyncStatus()}<div class="button-row"><button class="primary-button" data-action="play-again">Continue Endless Mode</button><button class="ghost-button" data-action="go-home">Home</button></div></div></article><aside class="panel"><div class="panel-inner"><h2 class="card-title">Endless leaderboard</h2>${renderEndlessLeaderboard()}</div></aside></section>`;
}

document.addEventListener("click", event => {
  const button = event.target.closest("[data-endless-action]");
  if (!button) return;
  const actions = {"start-profile":beginEndlessRun, resume:resumeEndlessRun, pause:pauseEndlessRun, "reset-wallet":resetEndlessWallet, next:advanceEndlessRun, retry:() => { void syncEndlessFromServer({refresh:true}); }};
  actions[button.dataset.endlessAction]?.(button.dataset.endlessName);
});
window.addEventListener("online", () => { void syncEndlessFromServer({refresh:true}); });
