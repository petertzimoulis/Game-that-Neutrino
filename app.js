const STORAGE_KEYS = {
  currentRun: "game-that-neutrino-current-run",
  lastName: "game-that-neutrino-last-name",
};

const API_PLAYERS_URL = "/api/players";
const COIN_ICON_SRC = "coin.png";
const VIDEO_PLAYBACK_RATE = 2;
const PLAYER_SYNC_INTERVAL_MS = 15000;

const ANSWER_KEY = {
  Video1: "cascade",
  Video2: "track",
  Video3: "track",
  Video4: "cascade",
  Video5: "track",
  Video6: "cascade",
  Video7: "track",
  Video8: "track",
  Video9: "track",
  Video10: "track",
  Video11: "track",
  Video12: "track",
  Video13: "track",
  Video14: "cascade",
  Video15: "cascade",
};

const SEEDED_PUBLIC_LINE_COUNTS = {
  // Historical test picks supplied by the user to open the public lines with a real baseline.
  Video1: { trackCount: 9, cascadeCount: 5 },
  Video2: { trackCount: 3, cascadeCount: 11 },
  Video3: { trackCount: 7, cascadeCount: 7 },
  Video4: { trackCount: 7, cascadeCount: 7 },
  Video5: { trackCount: 7, cascadeCount: 7 },
  Video6: { trackCount: 8, cascadeCount: 6 },
  Video7: { trackCount: 7, cascadeCount: 7 },
  Video8: { trackCount: 7, cascadeCount: 7 },
  Video9: { trackCount: 6, cascadeCount: 8 },
  Video10: { trackCount: 2, cascadeCount: 12 },
  Video11: { trackCount: 10, cascadeCount: 4 },
  Video12: { trackCount: 6, cascadeCount: 8 },
  Video13: { trackCount: 11, cascadeCount: 3 },
  Video14: { trackCount: 10, cascadeCount: 4 },
  Video15: { trackCount: 11, cascadeCount: 3 },
};

const SECTIONS = [
  {
    id: "tutorial",
    label: "Group 1",
    title: "Control Round",
    startIndex: 0,
    endIndex: 2,
    coinMode: false,
    publicLines: false,
    description:
      "Three control clips appear first in a shuffled run order. Players choose Track or Cascade and get immediate correctness feedback, but the coin bank stays closed.",
  },
  {
    id: "coins",
    label: "Group 2",
    title: "Coin Round",
    startIndex: 3,
    endIndex: 8,
    coinMode: true,
    publicLines: false,
    description:
      "Six shuffled clips with the coin bank live. The player starts this round with 10 coins, every correct answer adds 1 coin, every wrong answer removes 1, after 2 straight correct coin picks the hot-hand bonus pays 2 coins on each next consecutive correct pick, and players can check Double or Nothing to risk bigger swings on a single clip.",
  },
  {
    id: "market",
    label: "Group 3",
    title: "Public Lines",
    startIndex: 9,
    endIndex: 14,
    coinMode: true,
    publicLines: true,
    description:
      "The final six shuffled clips keep the coin rules, continue the hot-hand bonus, allow the same Double or Nothing wager, and also show the public Track vs Cascade split, seeded with historical test picks and updated by live completed runs.",
  },
];

const VIDEOS = Array.from({ length: 15 }, (_, index) => {
  const videoNumber = index + 1;

  return {
    id: `Video${videoNumber}`,
    label: `Video ${videoNumber}`,
    src: `videos/Video${videoNumber}.mp4`,
    questionNumber: videoNumber,
  };
});

const VIDEOS_BY_ID = Object.fromEntries(
  VIDEOS.map((video) => [video.id, video]),
);

const state = {
  players: [],
  currentRun: loadStorage(STORAGE_KEYS.currentRun, null),
  lastName: loadStorage(STORAGE_KEYS.lastName, ""),
  lastCompletedRun: null,
  showHelp: false,
  showAnalysis: false,
};

const appRoot = document.querySelector("#app");
const helpRoot = document.querySelector("#help-modal-root");
const analysisRoot = document.querySelector("#analysis-modal-root");
let playerSyncTimerId = null;

render();
initializeSharedPlayers();

document.addEventListener("click", (event) => {
  if (event.target.classList.contains("modal-backdrop")) {
    state.showHelp = false;
    state.showAnalysis = false;
    render();
    return;
  }

  const choiceButton = event.target.closest("[data-choice]");

  if (choiceButton) {
    handleChoice(choiceButton.dataset.choice);
    return;
  }

  const actionButton = event.target.closest("[data-action]");

  if (!actionButton) {
    return;
  }

  const { action } = actionButton.dataset;

  switch (action) {
    case "go-home":
      goHome();
      break;
    case "open-help":
      state.showHelp = true;
      state.showAnalysis = false;
      render();
      break;
    case "close-help":
      state.showHelp = false;
      render();
      break;
    case "continue":
      advanceRun();
      break;
    case "open-analysis":
      state.showHelp = false;
      state.showAnalysis = true;
      render();
      void syncPlayersFromServer();
      break;
    case "close-analysis":
      state.showAnalysis = false;
      render();
      break;
    case "download-csv":
      downloadCsv(actionButton.dataset.report);
      break;
    case "play-again":
      state.lastCompletedRun = null;
      render();
      void syncPlayersFromServer();
      break;
    default:
      break;
  }
});

document.addEventListener("submit", (event) => {
  if (event.target.id !== "start-form") {
    return;
  }

  event.preventDefault();

  const form = new FormData(event.target);
  const rawName = `${form.get("player-name") || ""}`.trim();

  if (!rawName) {
    const input = event.target.querySelector('input[name="player-name"]');

    if (input) {
      input.focus();
    }

    return;
  }

  beginRun(rawName);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && (state.showAnalysis || state.showHelp)) {
    state.showHelp = false;
    state.showAnalysis = false;
    render();
  }
});

function render() {
  ensureCurrentRunVideoOrder();
  ensureQuestionStartedAt();
  updateAnalysisButton();
  appRoot.innerHTML = state.currentRun
    ? renderRunView(state.currentRun)
    : renderLandingView();
  helpRoot.innerHTML = renderHelpModal();
  analysisRoot.innerHTML = renderAnalysisModal();
  initializeAutoplayVideos();
}

function renderLandingView() {
  if (state.lastCompletedRun) {
    return renderResultsView(state.lastCompletedRun);
  }

  const leaderboard = buildLeaderboard(state.players);
  const hasLeaderboard = leaderboard.length > 0;

  return `
    <section class="welcome-layout appear">
      <article class="panel hero-card">
        <div class="panel-inner">
          <p class="eyebrow">15 videos. 3 escalating rounds.</p>
          <h2 class="hero-title">Classify the event. Read the line. Build the board.</h2>
          <p class="hero-copy">
            Players enter a name, get a fresh shuffled order of all 15 neutrino clips, and finish
            on a shared leaderboard. The first 3 clips are control only, the next 6 open the coin
            wallet, and the final 6 layer in public percentage lines seeded from past test picks.
          </p>

          <div class="feature-strip">
            <div class="feature-chip">
              <strong>Group 1</strong>
              <span>3 control clips with simple Track or Cascade choices and no coin movement.</span>
            </div>
            <div class="feature-chip">
              <strong>Group 2</strong>
              <span>6 shuffled coin clips. Start with 10 coins, gain 1 for right picks, lose 1 for wrong ones, hit a hot-hand bonus after 2 straight coin wins, and optionally wager Double or Nothing.</span>
            </div>
            <div class="feature-chip">
              <strong>Group 3</strong>
              <span>6 shuffled market clips with coin scoring, the same streak bonus, an optional Double or Nothing wager, and seeded Track and Cascade public lines.</span>
            </div>
          </div>

          <div class="form-shell">
            <form class="name-form" id="start-form">
              <label for="player-name" class="subtle-copy">Enter a name to save results to the leaderboard.</label>
              <input
                class="text-input"
                id="player-name"
                name="player-name"
                type="text"
                maxlength="40"
                autocomplete="name"
                placeholder="Your classifier name"
                value="${escapeHtml(state.lastName)}"
                required
              />
              <div class="button-row">
                <button type="submit" class="primary-button">Start randomized 15-video run</button>
                <button type="button" class="secondary-button" data-action="open-help">
                  Learn Track vs Cascade
                </button>
              </div>
            </form>

            <p class="subtle-copy">
              The full 15-video answer key is live, so scores, coins, leaderboard standings, and
              analysis accuracy now use the real Track/Cascade labels.
            </p>
          </div>
        </div>
      </article>

      <aside class="panel">
        <div class="panel-inner">
          <div class="table-caption">
            <div>
              <p class="eyebrow">Live Board</p>
              <h2 class="card-title">Leaderboard Preview</h2>
            </div>
            <span class="pill-note">${hasLeaderboard ? `${leaderboard.length} completed player${leaderboard.length === 1 ? "" : "s"}` : "Waiting on first finish"}</span>
          </div>

          ${
            hasLeaderboard
              ? renderLeaderboardTable(leaderboard, null)
              : `
                <div class="empty-state">
                  <p class="empty-state-copy">
                    Completed runs will land here with the player name, coin score, and accuracy.
                    Analysis &amp; Export uses the same stored data for CSV downloads.
                  </p>
                </div>
              `
          }

          <div class="mini-card-grid">
            <div class="mini-card">
              <span>Storage</span>
              <strong>Shared server</strong>
              <p>Completed runs upload to the server so leaderboard and analysis stay visible across devices.</p>
            </div>
            <div class="mini-card">
              <span>Analytics</span>
              <strong>Excel-ready</strong>
              <p>Use the Analysis &amp; Export button to download shared CSV tables for graphing later.</p>
            </div>
          </div>
        </div>
      </aside>
    </section>
  `;
}

function renderRunView(run) {
  return run.phase === "feedback" ? renderFeedbackView(run) : renderQuestionView(run);
}

function renderQuestionView(run) {
  const section = getSectionForIndex(run.currentIndex);
  const video = getVideoForRunIndex(run, run.currentIndex);
  const currentCoins = getVisibleCoins(run, section);
  const questionInSection = run.currentIndex - section.startIndex + 1;
  const sectionQuestionCount = getSectionQuestionCount(section);
  const overallQuestionNumber = run.currentIndex + 1;
  const lines = section.publicLines ? getPublicLines(video.id, state.players) : null;

  return `
    <section class="panel appear game-panel">
      <div class="panel-inner game-panel-inner">
        <div class="game-header game-header-compact">
          <div class="game-heading-block">
            <p class="eyebrow">${section.label}</p>
            <h2 class="hero-title">${section.title}</h2>
            <p class="game-copy">Clip ${overallQuestionNumber} of ${VIDEOS.length} • Question ${questionInSection} of ${sectionQuestionCount} in this group</p>
          </div>

          <div class="status-strip status-strip-compact">
            <div class="stat-card">
              <span>Player</span>
              <strong>${escapeHtml(run.name)}</strong>
            </div>
            <div class="stat-card">
              <span>Question</span>
              <strong>${overallQuestionNumber} / ${VIDEOS.length}</strong>
            </div>
            <div class="wallet-card">
              <span>Coin Bank</span>
              <strong>
                ${
                  currentCoins === null
                    ? "Opens in Group 2"
                    : `<span class="wallet-display"><img class="coin-icon" src="${COIN_ICON_SRC}" alt="" aria-hidden="true" />${currentCoins}</span>`
                }
              </strong>
            </div>
          </div>
        </div>

        <div class="play-stage ${section.publicLines ? "play-stage-market" : ""}">
          <div class="video-column">
            <div class="section-pill section-pill-compact">
              <strong>${video.label}</strong>
              <span>${section.publicLines ? "Coins and public line live" : section.coinMode ? "Coin scoring live" : "Control round"}</span>
            </div>

            <div class="video-shell game-video-shell">
              <video controls autoplay muted playsinline preload="metadata" src="${video.src}"></video>
            </div>
          </div>

          <div class="decision-column">
            <div class="decision-card ${section.publicLines ? "decision-card-market" : ""}">
              <div class="round-note">
                <strong>${questionInSection === 1 ? "Round briefing" : "Round rules"}</strong>
                <p class="subtle-copy decision-copy">${section.description}</p>
              </div>

              ${
                section.coinMode
                  ? `
                    <label class="wager-toggle" for="double-down-toggle">
                      <input id="double-down-toggle" type="checkbox" data-double-down />
                      <span class="wager-copy">
                        <strong>Double or Nothing</strong>
                        <span>Wrong: -2 coins. Correct: +2 coins. Hot-hand correct: +3 coins.</span>
                      </span>
                    </label>
                  `
                  : ""
              }

              <div class="choice-grid choice-grid-compact">
                ${renderChoiceButton({
                  choice: "track",
                  label: "Track",
                  description: "Choose the elongated neutrino event class.",
                  variant: "track",
                  percentage: lines?.trackPercentage ?? null,
                  totalResponses: lines?.totalResponses ?? 0,
                })}
                ${renderChoiceButton({
                  choice: "cascade",
                  label: "Cascade",
                  description: "Choose the compact shower-like neutrino event class.",
                  variant: "cascade",
                  percentage: lines?.cascadePercentage ?? null,
                  totalResponses: lines?.totalResponses ?? 0,
                })}
              </div>

              <div class="button-row button-row-tight">
                <button type="button" class="ghost-button help-inline-button" data-action="open-help">
                  Need help spotting Track vs Cascade?
                </button>
              </div>
            </div>

            <div class="decision-meta-grid">
              <div class="mini-card compact-card">
                <span>Scoring mode</span>
                <strong>${section.coinMode ? "Coin round live" : "Control only"}</strong>
                <p>${section.coinMode ? "Correct picks add 1 coin and wrong picks lose 1 coin. After 2 straight correct coin picks, each next consecutive correct pick earns 2 coins until the streak breaks. Double or Nothing changes one clip to -2 on a miss, +2 on a normal hit, or +3 on a streak hit." : "This opening control section checks classification without changing the coin bank."}</p>
              </div>
              <div class="mini-card compact-card">
                <span>${section.publicLines ? "Public line" : "Answer key"}</span>
                <strong>${section.publicLines ? "Built into each pick" : "Live scoring"}</strong>
                <p>${section.publicLines ? "Track and Cascade percentages are part of the answer cards and open with the seeded historical baseline for that clip." : "Each pick is checked against the saved answer key for the current clip."}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderFeedbackView(run) {
  const answer = run.answers[run.answers.length - 1];
  const isFinalQuestion = run.currentIndex === VIDEOS.length - 1;
  const coinDelta = typeof answer.coinsAfter === "number" ? answer.coinsAfter - answer.coinsBefore : null;
  const nextLabel = isFinalQuestion ? "Finish and show leaderboard" : "Next video";
  const expectedChoice = ANSWER_KEY[answer.videoId] || answer.choice;
  const answerSection = getSectionById(answer.sectionId);
  const sectionQuestionCount = answerSection
    ? getSectionQuestionCount(answerSection)
    : answer.sectionQuestionNumber;
  const feedbackSummary = answer.correct
    ? `${titleCase(answer.choice)} matches the answer key.`
    : `Correct answer: ${titleCase(expectedChoice)}.`;
  const wagerCopy = answer.doubleDown
    ? answer.streakBonusApplied
      ? "Double or Nothing and the hot-hand streak were both active."
      : "Double or Nothing was active on this pick."
    : "";
  const coinMovementCopy =
    coinDelta === null
      ? "Control-round answers do not touch the wallet."
      : answer.streakBonusApplied
        ? `Wallet moved from ${answer.coinsBefore} to ${answer.coinsAfter}. Hot-hand bonus activated on ${formatOrdinal(answer.streakAfter)} straight correct coin pick.${wagerCopy ? ` ${wagerCopy}` : ""}`
        : `Wallet moved from ${answer.coinsBefore} to ${answer.coinsAfter}.${wagerCopy ? ` ${wagerCopy}` : ""}`;

  return `
    <section class="panel appear">
      <div class="panel-inner feedback-layout">
        <div>
          <p class="eyebrow">${answer.sectionLabel}</p>
          <h2 class="hero-title">${answer.videoLabel}: locked in</h2>
          <div class="feedback-pill ${answer.correct ? "" : "loss"}">
            <strong>${answer.correct ? "Correct call" : "Marked wrong"}</strong>
            <span>${feedbackSummary}</span>
          </div>
        </div>

        <div class="feedback-grid">
          <div class="feedback-card">
            <span>Player choice</span>
            <strong>${titleCase(answer.choice)}</strong>
            <p>${escapeHtml(run.name)} committed the ${titleCase(answer.choice)} call for ${answer.videoLabel}.</p>
          </div>
          <div class="feedback-card">
            <span>Question progress</span>
            <strong>${answer.questionNumber} / ${VIDEOS.length}</strong>
            <p>${answer.sectionLabel}, question ${answer.sectionQuestionNumber} of ${sectionQuestionCount}.</p>
          </div>
          <div class="feedback-card">
            <span>Coin movement</span>
            <strong>${coinDelta === null ? "No wallet yet" : `${coinDelta > 0 ? "+" : ""}${coinDelta} coin${Math.abs(coinDelta) === 1 ? "" : "s"}`}</strong>
            <p>${coinMovementCopy}</p>
          </div>
        </div>

        ${
          answer.publicLines
            ? `
              <div class="line-grid">
                ${renderLineCard("Track line before your pick", answer.publicLines.trackPercentage, "line-fill-track", answer.publicLines.totalResponses)}
                ${renderLineCard("Cascade line before your pick", answer.publicLines.cascadePercentage, "line-fill-cascade", answer.publicLines.totalResponses)}
              </div>
            `
            : ""
        }

        <div class="button-row">
          <button type="button" class="primary-button" data-action="continue">${nextLabel}</button>
          <button type="button" class="ghost-button" data-action="open-analysis">Open analysis</button>
        </div>
      </div>
    </section>
  `;
}

function renderResultsView(run) {
  const leaderboard = buildLeaderboard(state.players);
  const stats = calculateRunStats(run.answers);

  return `
    <section class="results-layout appear">
      <article class="panel">
        <div class="panel-inner score-panel">
          <div class="score-shell">
            <div>
              <p class="eyebrow">Run Complete</p>
              <h2 class="score-title">${escapeHtml(run.name)} finished all 15 videos</h2>
              <p class="hero-copy">
                The score below has been written into the shared leaderboard, and the full answer
                breakdown is available in the analysis export modal.
              </p>
            </div>

            <div class="score-badge">
              <img class="coin-icon" src="${COIN_ICON_SRC}" alt="" aria-hidden="true" />
              <p class="score-value">${run.finalCoins}</p>
            </div>
          </div>

          <div class="results-strip">
            <div class="summary-card">
              <span>Total accuracy</span>
              <strong>${formatPercent(stats.totalAccuracy)}</strong>
              <p>${stats.totalCorrect} of ${stats.totalQuestions} correct.</p>
            </div>
            <div class="summary-card">
              <span>Control</span>
              <strong>${formatPercent(stats.sectionStats.tutorial.accuracy)}</strong>
              <p>${stats.sectionStats.tutorial.correct} of ${stats.sectionStats.tutorial.total} correct.</p>
            </div>
            <div class="summary-card">
              <span>Coin round</span>
              <strong>${formatPercent(stats.sectionStats.coins.accuracy)}</strong>
              <p>${stats.sectionStats.coins.correct} of ${stats.sectionStats.coins.total} correct.</p>
            </div>
            <div class="summary-card">
              <span>Public lines</span>
              <strong>${formatPercent(stats.sectionStats.market.accuracy)}</strong>
              <p>${stats.sectionStats.market.correct} of ${stats.sectionStats.market.total} correct.</p>
            </div>
          </div>

          <div class="button-row">
            <button type="button" class="primary-button" data-action="play-again">Start another run</button>
            <button type="button" class="secondary-button" data-action="open-analysis">Open analysis</button>
          </div>
        </div>
      </article>

      <aside class="panel">
        <div class="panel-inner">
          <div class="table-caption">
            <div>
              <p class="eyebrow">Final Standings</p>
              <h2 class="card-title">Leaderboard</h2>
            </div>
            <span class="pill-note">${leaderboard.length} completed player${leaderboard.length === 1 ? "" : "s"}</span>
          </div>
          ${renderLeaderboardTable(leaderboard, run.nameKey)}
        </div>
      </aside>
    </section>
  `;
}

function renderLeaderboardTable(leaderboard, highlightedNameKey) {
  return `
    <div class="leaderboard-scroll">
      <table class="leaderboard-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Player</th>
            <th>Coins</th>
            <th>Accuracy</th>
            <th>Completed</th>
          </tr>
        </thead>
        <tbody>
          ${leaderboard
            .map((player, index) => {
              const isHighlighted = player.nameKey === highlightedNameKey;

              return `
                <tr>
                  <td class="${index === 0 ? "rank-highlight" : ""}">#${index + 1}</td>
                  <td>${isHighlighted ? "<strong>" : ""}${escapeHtml(player.name)}${isHighlighted ? "</strong>" : ""}</td>
                  <td>
                    <span class="coin-badge">
                      <img class="coin-icon" src="${COIN_ICON_SRC}" alt="" aria-hidden="true" />
                      ${player.finalCoins}
                    </span>
                  </td>
                  <td>${formatPercent(player.totalAccuracy)}</td>
                  <td>${formatDate(player.completedAt)}</td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderAnalysisModal() {
  if (!state.showAnalysis) {
    return "";
  }

  const summaryRows = buildUserSummaryRows(state.players);
  const groupRows = buildGroupRows(state.players);
  const videoRows = buildVideoRows(state.players);
  const timingRows = buildTimingRows(state.players);

  const averageCoins = summaryRows.length
    ? summaryRows.reduce((sum, row) => sum + row.finalCoins, 0) / summaryRows.length
    : 0;
  const averageAccuracy = summaryRows.length
    ? summaryRows.reduce((sum, row) => sum + row.totalAccuracy, 0) / summaryRows.length
    : 0;

  return `
    <div class="modal-backdrop is-open" role="dialog" aria-modal="true">
      <section class="modal-panel">
        <div class="modal-inner">
          <div class="modal-header">
            <div>
              <p class="eyebrow">Owner View</p>
              <h2 class="modal-title">Analysis &amp; Export</h2>
              <p class="hero-copy">
                This pulls from the shared server leaderboard and creates
                Excel-ready CSV tables for per-user, per-group, and per-video analysis.
              </p>
            </div>

            <button type="button" class="ghost-button" data-action="close-analysis">Close</button>
          </div>

          ${
            summaryRows.length
              ? `
                <div class="summary-strip">
                  <div class="summary-card">
                    <span>Completed users</span>
                    <strong>${summaryRows.length}</strong>
                    <p>Each name stores the latest completed run for that player.</p>
                  </div>
                  <div class="summary-card">
                    <span>Average coins</span>
                    <strong>${averageCoins.toFixed(1)}</strong>
                    <p>Average final wallet across all stored users.</p>
                  </div>
                  <div class="summary-card">
                    <span>Average accuracy</span>
                    <strong>${formatPercent(averageAccuracy)}</strong>
                    <p>Overall correctness rate across the full 15-video flow.</p>
                  </div>
                </div>

                ${renderAnalysisTable({
                  title: "Per-user summary",
                  note: "Use this table for total user performance, final coin score, section accuracy, and average decision timing.",
                  report: "user-summary",
                  headers: ["Player", "Coins", "Total Accuracy", "Control Accuracy", "Coin Round Accuracy", "Public Lines Accuracy", "Avg Response Time", "Avg Clip Time At Pick", "After Half Rate", "Completed"],
                  rows: summaryRows.map((row) => [
                    escapeHtml(row.name),
                    row.finalCoins,
                    formatPercent(row.totalAccuracy),
                    formatPercent(row.controlAccuracy),
                    formatPercent(row.coinAccuracy),
                    formatPercent(row.marketAccuracy),
                    formatSeconds(row.averageResponseSeconds),
                    formatSeconds(row.averageClipTimeAtChoiceSeconds),
                    formatPercent(row.afterHalfRate),
                    formatDate(row.completedAt),
                  ]),
                })}

                ${renderAnalysisTable({
                  title: "Per-user group breakdown",
                  note: "One row per user per section so you can graph the 3-control, 6-coin, and 6-public-line groups separately.",
                  report: "group-breakdown",
                  headers: ["Player", "Group", "Correct", "Total", "Accuracy", "Completed"],
                  rows: groupRows.map((row) => [
                    escapeHtml(row.name),
                    row.groupLabel,
                    row.correct,
                    row.total,
                    formatPercent(row.accuracy),
                    formatDate(row.completedAt),
                  ]),
                })}

                ${renderAnalysisTable({
                  title: "Per-video public response lines",
                  note: "Tracks seeded test picks plus completed live picks, then shows Track percentage, Cascade percentage, and overall pick accuracy for every video.",
                  report: "video-lines",
                  headers: ["Video", "Track Picks", "Cascade Picks", "Track %", "Cascade %", "Attempts", "Accuracy"],
                  rows: videoRows.map((row) => [
                    escapeHtml(row.videoLabel),
                    row.trackCount,
                    row.cascadeCount,
                    formatPercent(row.trackPercentage),
                    formatPercent(row.cascadePercentage),
                    row.totalResponses,
                    formatPercent(row.accuracy),
                  ]),
                })}

                ${renderAnalysisTable({
                  title: "Per-answer response timing",
                  note: "Shows when each player answered relative to the clip halfway point, using both wall-clock response time and the video timestamp at click.",
                  report: "response-timing",
                  headers: ["Player", "Group", "Video", "Choice", "Response Time", "Clip Time At Pick", "Halfway Point", "Delta Vs Half", "Half Position", "Clip Progress", "Completed"],
                  rows: timingRows.map((row) => [
                    escapeHtml(row.name),
                    row.groupLabel,
                    escapeHtml(row.videoLabel),
                    titleCase(row.choice),
                    formatSeconds(row.responseSeconds),
                    formatSeconds(row.videoCurrentTimeSeconds),
                    formatSeconds(row.videoHalfSeconds),
                    formatSignedSeconds(row.secondsFromHalf),
                    row.halfPositionLabel,
                    formatDetailedPercent(row.videoProgress),
                    formatDate(row.completedAt),
                  ]),
                })}
              `
              : `
                <div class="empty-state">
                  <p class="empty-state-copy">
                    There are no completed runs yet. Once a player finishes all 15 videos, the CSV
                    tables will appear here automatically.
                  </p>
                </div>
              `
          }
        </div>
      </section>
    </div>
  `;
}

function renderHelpModal() {
  if (!state.showHelp) {
    return "";
  }

  return `
    <div class="modal-backdrop is-open" role="dialog" aria-modal="true" aria-label="Track versus Cascade tutorial">
      <section class="modal-panel help-modal-panel">
        <div class="modal-inner help-modal-inner">
          <div class="modal-header">
            <div>
              <p class="eyebrow">Player Guide</p>
              <h2 class="modal-title">Track vs Cascade tutorial</h2>
              <p class="hero-copy">
                Use this quick guide whenever a player is unsure what shape they are seeing in the
                detector. The goal is to spot whether the signal stretches like a line or blooms
                outward from one center.
              </p>
            </div>

            <button type="button" class="ghost-button" data-action="close-help">Close</button>
          </div>

          <section class="panel">
            <div class="panel-inner help-section-grid">
              <div class="help-copy-block">
                <p class="eyebrow">What Players Are Seeing</p>
                <h3 class="card-title">IceCube is recording light in the South Pole ice</h3>
                <p class="subtle-copy">
                  Each video shows a particle signal as glowing bubbles inside the detector. The
                  main job is to classify the shape of that signal, not every stray bubble in the scene.
                </p>
                <p class="subtle-copy">
                  The color sequence shows timing: red appears earliest, then yellow, then green,
                  with blue arriving latest.
                </p>
              </div>

              <div class="help-detector-card">
                <div class="help-detector-visual">
                  <span class="help-detector-string"></span>
                  <span class="help-detector-string"></span>
                  <span class="help-detector-string"></span>
                  <span class="help-detector-string"></span>
                  <span class="help-detector-string"></span>
                  <span class="help-detector-string"></span>
                  <span class="help-detector-glow help-detector-glow-red"></span>
                  <span class="help-detector-glow help-detector-glow-yellow"></span>
                  <span class="help-detector-glow help-detector-glow-green"></span>
                  <span class="help-detector-glow help-detector-glow-blue"></span>
                </div>
                <p class="help-visual-caption">Think of the clustered bubbles as the signal and the colors as the order the light arrived.</p>
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-inner">
              <div class="table-caption">
                <div>
                  <p class="eyebrow">Quick Compare</p>
                  <h3 class="card-title">How to tell Track from Cascade</h3>
                </div>
                <span class="pill-note">Ask: line or burst?</span>
              </div>

              <div class="help-compare-grid">
                <article class="help-compare-card">
                  <div class="help-visual-box help-visual-track">
                    <span class="help-wire"></span>
                    <span class="help-wire"></span>
                    <span class="help-wire"></span>
                    <span class="help-wire"></span>
                    <span class="help-dot help-dot-red"></span>
                    <span class="help-dot help-dot-yellow"></span>
                    <span class="help-dot help-dot-green"></span>
                    <span class="help-dot help-dot-blue"></span>
                    <span class="help-track-streak"></span>
                  </div>
                  <h3 class="card-title">Track</h3>
                  <p class="subtle-copy">
                    The bubbles line up in a mostly straight path. The signal feels like it is
                    traveling through the detector in one direction.
                  </p>
                </article>

                <article class="help-compare-card">
                  <div class="help-visual-box help-visual-cascade">
                    <span class="help-wire"></span>
                    <span class="help-wire"></span>
                    <span class="help-wire"></span>
                    <span class="help-wire"></span>
                    <span class="help-burst-core"></span>
                    <span class="help-burst-ring help-burst-ring-red"></span>
                    <span class="help-burst-ring help-burst-ring-yellow"></span>
                    <span class="help-burst-ring help-burst-ring-green"></span>
                    <span class="help-burst-ring help-burst-ring-blue"></span>
                  </div>
                  <h3 class="card-title">Cascade</h3>
                  <p class="subtle-copy">
                    The bubbles start near one center and expand outward like a growing balloon or
                    spherical burst rather than a long line.
                  </p>
                </article>
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-inner help-tips-grid">
              <div class="help-tip-card">
                <p class="eyebrow">What To Ask</p>
                <h3 class="card-title">Two fast questions</h3>
                <ul class="help-list">
                  <li>Does the main cluster move in a straight line? That points to Track.</li>
                  <li>Does it begin near the middle and spread outward? That points to Cascade.</li>
                </ul>
              </div>

              <div class="help-tip-card">
                <p class="eyebrow">When It Gets Messy</p>
                <h3 class="card-title">How to handle hard clips</h3>
                <ul class="help-list">
                  <li>Replay the video a few times if needed.</li>
                  <li>Use the browser video controls to slow down or scrub through the clip.</li>
                  <li>Ignore random noise bubbles and focus on the densest signal cluster.</li>
                  <li>If most of the action looks outside the detector, focus on the clearest in-detector shape.</li>
                </ul>
              </div>
            </div>
          </section>
        </div>
      </section>
    </div>
  `;
}

function renderAnalysisTable({ title, note, report, headers, rows }) {
  return `
    <section class="panel">
      <div class="panel-inner">
        <div class="table-caption">
          <div>
            <h3 class="card-title">${title}</h3>
            <p class="table-note">${note}</p>
          </div>
          <button type="button" class="secondary-button" data-action="download-csv" data-report="${report}">
            Download CSV
          </button>
        </div>

        <div class="table-shell">
          <table class="analysis-table">
            <thead>
              <tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr>
            </thead>
            <tbody>
              ${rows
                .map(
                  (row) => `
                    <tr>
                      ${row.map((value) => `<td>${value}</td>`).join("")}
                    </tr>
                  `,
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  `;
}

function renderChoiceButton({
  choice,
  label,
  description,
  variant,
  percentage,
  totalResponses,
}) {
  const hasPublicLine = typeof percentage === "number";
  const responsesLabel = totalResponses
    ? `${totalResponses} public pick${totalResponses === 1 ? "" : "s"}`
    : "opens at 50/50 if no public picks are stored yet";

  return `
    <button
      type="button"
      class="choice-button choice-button-${variant} ${hasPublicLine ? "choice-button-live-line" : ""}"
      data-choice="${choice}"
    >
      <div class="choice-topline">
        <strong>${label}</strong>
        ${hasPublicLine ? `<span class="choice-percent">${formatPercent(percentage)}</span>` : ""}
      </div>
      <span class="choice-description">${description}</span>
      ${
        hasPublicLine
          ? `
            <span class="choice-line-meta">Public line • ${responsesLabel}</span>
            <span class="choice-line-bar" aria-hidden="true">
              <span class="choice-line-fill choice-line-fill-${variant}" style="width: ${Math.max(percentage * 100, 8)}%;"></span>
            </span>
          `
          : ""
      }
    </button>
  `;
}

function initializeAutoplayVideos() {
  const videos = document.querySelectorAll("video");

  videos.forEach((video) => {
    const applyPlaybackRate = () => {
      video.defaultPlaybackRate = VIDEO_PLAYBACK_RATE;
      video.playbackRate = VIDEO_PLAYBACK_RATE;
    };

    video.muted = true;
    video.defaultMuted = true;
    video.autoplay = true;
    video.playsInline = true;
    applyPlaybackRate();

    video.onloadedmetadata = applyPlaybackRate;
    video.onplay = applyPlaybackRate;
    video.oncanplay = () => {
      applyPlaybackRate();

      const playPromise = video.play();

      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {});
      }
    };

    const playPromise = video.play();

    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {});
    }
  });
}

function renderLineCard(label, percentage, fillClass, totalResponses) {
  const responseLabel = totalResponses
    ? `${totalResponses} public response${totalResponses === 1 ? "" : "s"}`
    : "No completed public picks yet";

  return `
    <div class="line-card">
      <div class="line-card-header">
        <strong>${label}</strong>
        <span class="line-card-badge">${formatPercent(percentage)}</span>
      </div>
      <p>${responseLabel}</p>
      <div class="line-card-bar" aria-hidden="true">
        <span class="line-fill ${fillClass}" style="width: ${Math.max(percentage * 100, 6)}%;"></span>
      </div>
    </div>
  `;
}

function goHome() {
  state.showHelp = false;
  state.showAnalysis = false;
  state.lastCompletedRun = null;

  if (state.currentRun) {
    state.currentRun = null;
    localStorage.removeItem(STORAGE_KEYS.currentRun);
  }

  render();
  void syncPlayersFromServer();
}

function initializeSharedPlayers() {
  void syncPlayersFromServer();

  if (!playerSyncTimerId) {
    playerSyncTimerId = window.setInterval(() => {
      if (!state.currentRun) {
        void syncPlayersFromServer();
      }
    }, PLAYER_SYNC_INTERVAL_MS);
  }

  window.addEventListener("focus", () => {
    if (!state.currentRun) {
      void syncPlayersFromServer();
    }
  });
}

async function syncPlayersFromServer() {
  try {
    const response = await fetch(`${API_PLAYERS_URL}?t=${Date.now()}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Failed to load shared players: ${response.status}`);
    }

    const payload = await response.json();
    state.players = Array.isArray(payload.players) ? payload.players : [];

    if (!state.currentRun || state.showAnalysis || state.lastCompletedRun) {
      render();
    }
  } catch (error) {
    console.error(error);
  }
}

async function uploadPlayerRecord(playerRecord) {
  const response = await fetch(API_PLAYERS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(playerRecord),
  });

  if (!response.ok) {
    throw new Error(`Failed to upload player record: ${response.status}`);
  }

  const payload = await response.json();
  return Array.isArray(payload.players) ? payload.players : [];
}

function beginRun(rawName) {
  const name = rawName.trim();
  const questionStartedAt = new Date().toISOString();

  state.lastName = name;
  saveStorage(STORAGE_KEYS.lastName, name);

  state.lastCompletedRun = null;
  state.currentRun = {
    id: `run-${Date.now()}`,
    name,
    nameKey: normalizeName(name),
    videoOrder: shuffleArray(VIDEOS.map((video) => video.id)),
    currentIndex: 0,
    phase: "question",
    answers: [],
    coins: null,
    startedAt: new Date().toISOString(),
    questionStartedAt,
  };

  saveStorage(STORAGE_KEYS.currentRun, state.currentRun);
  render();
}

function handleChoice(choice) {
  const run = state.currentRun;

  if (!run || run.phase !== "question") {
    return;
  }

  const section = getSectionForIndex(run.currentIndex);
  const video = getVideoForRunIndex(run, run.currentIndex);
  const correct = isAnswerCorrect(video.id, choice);
  const publicLines = section.publicLines ? getPublicLines(video.id, state.players) : null;
  const timing = getCurrentQuestionTiming(run.questionStartedAt);
  const doubleDown = section.coinMode ? isDoubleDownSelected() : false;

  let coinsBefore = null;
  let coinsAfter = null;
  let streakBefore = null;
  let streakAfter = null;
  let streakBonusApplied = false;

  if (section.coinMode) {
    streakBefore = getCoinCorrectStreak(run.answers);
    coinsBefore = typeof run.coins === "number" ? run.coins : 10;

    if (correct) {
      streakBonusApplied = streakBefore >= 2;
      streakAfter = streakBefore + 1;
      coinsAfter = coinsBefore + (
        doubleDown
          ? (streakBonusApplied ? 3 : 2)
          : (streakBonusApplied ? 2 : 1)
      );
    } else {
      streakAfter = 0;
      coinsAfter = coinsBefore - (doubleDown ? 2 : 1);
    }

    run.coins = coinsAfter;
  }

  run.answers.push({
    videoId: video.id,
    videoLabel: video.label,
    questionNumber: run.currentIndex + 1,
    sectionId: section.id,
    sectionLabel: `${section.label}: ${section.title}`,
    sectionQuestionNumber: run.currentIndex - section.startIndex + 1,
    choice,
    correct,
    coinsBefore,
    coinsAfter,
    doubleDown,
    streakBefore,
    streakAfter,
    streakBonusApplied,
    publicLines,
    questionStartedAt: timing.questionStartedAt,
    answeredAt: timing.answeredAt,
    responseSeconds: timing.responseSeconds,
    videoCurrentTimeSeconds: timing.videoCurrentTimeSeconds,
    videoDurationSeconds: timing.videoDurationSeconds,
    videoHalfSeconds: timing.videoHalfSeconds,
    secondsFromHalf: timing.secondsFromHalf,
    halfComparison: timing.halfComparison,
    videoProgress: timing.videoProgress,
  });

  run.phase = "feedback";
  saveStorage(STORAGE_KEYS.currentRun, run);
  render();
}

async function advanceRun() {
  const run = state.currentRun;

  if (!run || run.phase !== "feedback") {
    return;
  }

  if (run.currentIndex >= VIDEOS.length - 1) {
    finalizeRun();
    return;
  }

  run.currentIndex += 1;
  run.phase = "question";
  run.questionStartedAt = new Date().toISOString();
  saveStorage(STORAGE_KEYS.currentRun, run);
  render();
}

async function finalizeRun() {
  const run = state.currentRun;

  if (!run) {
    return;
  }

  const stats = calculateRunStats(run.answers);
  const completedAt = new Date().toISOString();

  const playerRecord = {
    id: run.id,
    name: run.name,
    nameKey: run.nameKey,
    startedAt: run.startedAt,
    completedAt,
    finalCoins: typeof run.coins === "number" ? run.coins : 10,
    totalCorrect: stats.totalCorrect,
    totalQuestions: stats.totalQuestions,
    totalAccuracy: stats.totalAccuracy,
    sectionStats: stats.sectionStats,
    answers: run.answers,
  };

  try {
    state.players = await uploadPlayerRecord(playerRecord);
    state.lastCompletedRun = playerRecord;
    state.currentRun = null;
    localStorage.removeItem(STORAGE_KEYS.currentRun);
    render();
  } catch (error) {
    console.error(error);
    window.alert(
      "Couldn't upload this run to the shared server yet. The entry is still open on this device, so please try again in a moment.",
    );
  }
}

function calculateRunStats(answers) {
  const totalQuestions = answers.length;
  const totalCorrect = answers.filter((answer) => answer.correct).length;
  const totalAccuracy = totalQuestions ? totalCorrect / totalQuestions : 0;

  const sectionStats = SECTIONS.reduce((stats, section) => {
    const sectionAnswers = answers.filter((answer) => answer.sectionId === section.id);
    const correct = sectionAnswers.filter((answer) => answer.correct).length;
    const total = sectionAnswers.length;

    stats[section.id] = {
      correct,
      total,
      accuracy: total ? correct / total : 0,
    };

    return stats;
  }, {});

  return {
    totalCorrect,
    totalQuestions,
    totalAccuracy,
    sectionStats,
  };
}

function buildLeaderboard(players) {
  return [...players].sort((left, right) => {
    if (right.finalCoins !== left.finalCoins) {
      return right.finalCoins - left.finalCoins;
    }

    if (right.totalAccuracy !== left.totalAccuracy) {
      return right.totalAccuracy - left.totalAccuracy;
    }

    return left.name.localeCompare(right.name);
  });
}

function buildUserSummaryRows(players) {
  return buildLeaderboard(players).map((player) => ({
    name: player.name,
    finalCoins: player.finalCoins,
    totalAccuracy: player.totalAccuracy,
    controlAccuracy: getPlayerSectionStat(player, "tutorial").accuracy,
    coinAccuracy: getPlayerSectionStat(player, "coins").accuracy,
    marketAccuracy: getPlayerSectionStat(player, "market").accuracy,
    averageResponseSeconds: averageOfValues(
      player.answers.map((answer) => answer.responseSeconds),
    ),
    averageClipTimeAtChoiceSeconds: averageOfValues(
      player.answers.map((answer) => answer.videoCurrentTimeSeconds),
    ),
    afterHalfRate: calculateAfterHalfRate(player.answers),
    completedAt: player.completedAt,
  }));
}

function buildGroupRows(players) {
  return buildLeaderboard(players).flatMap((player) =>
    SECTIONS.map((section) => ({
      name: player.name,
      groupLabel: `${section.label}: ${section.title}`,
      correct: getPlayerSectionStat(player, section.id).correct,
      total: getPlayerSectionStat(player, section.id).total,
      accuracy: getPlayerSectionStat(player, section.id).accuracy,
      completedAt: player.completedAt,
    })),
  );
}

function buildVideoRows(players) {
  return VIDEOS.map((video) => {
    const summary = getCombinedVideoLineStats(video.id, players);

    return {
      videoLabel: video.label,
      trackCount: summary.trackCount,
      cascadeCount: summary.cascadeCount,
      trackPercentage: summary.trackPercentage,
      cascadePercentage: summary.cascadePercentage,
      totalResponses: summary.totalResponses,
      accuracy: summary.accuracy,
    };
  });
}

function buildTimingRows(players) {
  return buildLeaderboard(players).flatMap((player) =>
    player.answers.map((answer) => ({
      name: player.name,
      groupLabel: answer.sectionLabel,
      videoLabel: answer.videoLabel,
      choice: answer.choice,
      responseSeconds: answer.responseSeconds ?? null,
      videoCurrentTimeSeconds: answer.videoCurrentTimeSeconds ?? null,
      videoHalfSeconds: answer.videoHalfSeconds ?? null,
      secondsFromHalf: answer.secondsFromHalf ?? null,
      halfPositionLabel: describeHalfComparison(answer.halfComparison),
      videoProgress: answer.videoProgress ?? null,
      completedAt: player.completedAt,
    })),
  );
}

function getPublicLines(videoId, players) {
  const summary = getCombinedVideoLineStats(videoId, players);

  return {
    trackPercentage: summary.trackPercentage,
    cascadePercentage: summary.cascadePercentage,
    totalResponses: summary.totalResponses,
  };
}

function getSectionForIndex(index) {
  return SECTIONS.find(
    (section) => index >= section.startIndex && index <= section.endIndex,
  );
}

function getSectionById(sectionId) {
  return SECTIONS.find((section) => section.id === sectionId) || null;
}

function isDoubleDownSelected() {
  return Boolean(document.querySelector("[data-double-down]")?.checked);
}

function getVisibleCoins(run, section) {
  if (!section.coinMode && typeof run.coins !== "number") {
    return null;
  }

  return typeof run.coins === "number" ? run.coins : 10;
}

function getSectionQuestionCount(section) {
  return section.endIndex - section.startIndex + 1;
}

function ensureCurrentRunVideoOrder() {
  if (!state.currentRun) {
    return;
  }

  if (
    Array.isArray(state.currentRun.videoOrder) &&
    state.currentRun.videoOrder.length === VIDEOS.length
  ) {
    return;
  }

  state.currentRun.videoOrder = VIDEOS.map((video) => video.id);
  saveStorage(STORAGE_KEYS.currentRun, state.currentRun);
}

function getVideoForRunIndex(run, index) {
  const videoId = Array.isArray(run?.videoOrder) ? run.videoOrder[index] : null;
  return VIDEOS_BY_ID[videoId] || VIDEOS[index];
}

function shuffleArray(items) {
  const nextItems = [...items];

  for (let index = nextItems.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const currentItem = nextItems[index];
    nextItems[index] = nextItems[swapIndex];
    nextItems[swapIndex] = currentItem;
  }

  return nextItems;
}

function ensureQuestionStartedAt() {
  if (!state.currentRun || state.currentRun.phase !== "question") {
    return;
  }

  if (state.currentRun.questionStartedAt) {
    return;
  }

  state.currentRun.questionStartedAt = new Date().toISOString();
  saveStorage(STORAGE_KEYS.currentRun, state.currentRun);
}

function getCurrentQuestionTiming(questionStartedAt) {
  const video = document.querySelector(".game-video-shell video");
  const answeredAt = new Date().toISOString();
  const questionStartedMs = questionStartedAt
    ? new Date(questionStartedAt).getTime()
    : Date.now();
  const responseSeconds = roundSeconds((Date.now() - questionStartedMs) / 1000);
  const videoCurrentTimeSeconds = getFiniteNumber(video?.currentTime);
  const videoDurationSeconds = getFiniteNumber(video?.duration);
  const videoHalfSeconds =
    typeof videoDurationSeconds === "number"
      ? roundSeconds(videoDurationSeconds / 2)
      : null;
  const secondsFromHalf =
    typeof videoCurrentTimeSeconds === "number" &&
    typeof videoHalfSeconds === "number"
      ? roundSeconds(videoCurrentTimeSeconds - videoHalfSeconds)
      : null;
  const halfComparison =
    typeof secondsFromHalf !== "number"
      ? "unknown"
      : Math.abs(secondsFromHalf) < 0.1
        ? "at-half"
        : secondsFromHalf < 0
          ? "before-half"
          : "after-half";
  const videoProgress =
    typeof videoCurrentTimeSeconds === "number" &&
    typeof videoDurationSeconds === "number" &&
    videoDurationSeconds > 0
      ? roundRatio(videoCurrentTimeSeconds / videoDurationSeconds)
      : null;

  return {
    questionStartedAt: questionStartedAt ?? answeredAt,
    answeredAt,
    responseSeconds,
    videoCurrentTimeSeconds,
    videoDurationSeconds,
    videoHalfSeconds,
    secondsFromHalf,
    halfComparison,
    videoProgress,
  };
}

function isAnswerCorrect(videoId, choice) {
  const expected = ANSWER_KEY[videoId];

  if (!expected) {
    return true;
  }

  return expected === choice;
}

function getCoinCorrectStreak(answers) {
  let streak = 0;

  for (let index = answers.length - 1; index >= 0; index -= 1) {
    const answer = answers[index];

    if (typeof answer.coinsAfter !== "number") {
      continue;
    }

    if (!answer.correct) {
      break;
    }

    streak += 1;
  }

  return streak;
}

function getPlayerSectionStat(player, sectionId) {
  return player.sectionStats?.[sectionId] || {
    correct: 0,
    total: 0,
    accuracy: 0,
  };
}

function getSeededLineCounts(videoId) {
  return SEEDED_PUBLIC_LINE_COUNTS[videoId] || {
    trackCount: 0,
    cascadeCount: 0,
  };
}

function getCombinedVideoLineStats(videoId, players) {
  const seededCounts = getSeededLineCounts(videoId);
  const answers = players.flatMap((player) =>
    player.answers.filter((answer) => answer.videoId === videoId),
  );
  const liveTrackCount = answers.filter((answer) => answer.choice === "track").length;
  const liveCascadeCount = answers.filter((answer) => answer.choice === "cascade").length;
  const trackCount = seededCounts.trackCount + liveTrackCount;
  const cascadeCount = seededCounts.cascadeCount + liveCascadeCount;
  const totalResponses = trackCount + cascadeCount;
  const liveCorrectCount = answers.filter((answer) => answer.correct).length;
  const seededCorrectCount = getSeededCorrectCount(videoId, seededCounts);

  return {
    trackCount,
    cascadeCount,
    totalResponses,
    trackPercentage: totalResponses ? trackCount / totalResponses : 0.5,
    cascadePercentage: totalResponses ? cascadeCount / totalResponses : 0.5,
    accuracy: totalResponses
      ? (seededCorrectCount + liveCorrectCount) / totalResponses
      : 0,
  };
}

function getSeededCorrectCount(videoId, seededCounts) {
  if (ANSWER_KEY[videoId] === "track") {
    return seededCounts.trackCount;
  }

  if (ANSWER_KEY[videoId] === "cascade") {
    return seededCounts.cascadeCount;
  }

  return 0;
}

function upsertPlayerRecord(players, playerRecord) {
  const existingIndex = players.findIndex(
    (player) => player.nameKey === playerRecord.nameKey,
  );

  if (existingIndex === -1) {
    return [...players, playerRecord];
  }

  const nextPlayers = [...players];
  nextPlayers[existingIndex] = playerRecord;
  return nextPlayers;
}

function updateAnalysisButton() {
  const button = document.querySelector("#analysis-button");

  if (!button) {
    return;
  }

  button.disabled = false;
  button.textContent = state.players.length
    ? `Analysis & Export (${state.players.length})`
    : "Analysis & Export";
}

function downloadCsv(report) {
  const definitions = {
    "user-summary": {
      fileName: "neutrino-user-summary.csv",
      rows: buildUserSummaryRows(state.players).map((row) => ({
        player: row.name,
        coins: row.finalCoins,
        total_accuracy: decimalPercent(row.totalAccuracy),
        control_accuracy: decimalPercent(row.controlAccuracy),
        coin_round_accuracy: decimalPercent(row.coinAccuracy),
        public_lines_accuracy: decimalPercent(row.marketAccuracy),
        average_response_seconds: row.averageResponseSeconds,
        average_clip_time_at_pick_seconds: row.averageClipTimeAtChoiceSeconds,
        after_half_rate: decimalPercent(row.afterHalfRate),
        completed_at: row.completedAt,
      })),
    },
    "group-breakdown": {
      fileName: "neutrino-group-breakdown.csv",
      rows: buildGroupRows(state.players).map((row) => ({
        player: row.name,
        group: row.groupLabel,
        correct: row.correct,
        total: row.total,
        accuracy: decimalPercent(row.accuracy),
        completed_at: row.completedAt,
      })),
    },
    "video-lines": {
      fileName: "neutrino-video-lines.csv",
      rows: buildVideoRows(state.players).map((row) => ({
        video: row.videoLabel,
        track_picks: row.trackCount,
        cascade_picks: row.cascadeCount,
        track_percent: decimalPercent(row.trackPercentage),
        cascade_percent: decimalPercent(row.cascadePercentage),
        attempts: row.totalResponses,
        accuracy: decimalPercent(row.accuracy),
      })),
    },
    "response-timing": {
      fileName: "neutrino-response-timing.csv",
      rows: buildTimingRows(state.players).map((row) => ({
        player: row.name,
        group: row.groupLabel,
        video: row.videoLabel,
        choice: row.choice,
        response_seconds: row.responseSeconds,
        clip_time_at_pick_seconds: row.videoCurrentTimeSeconds,
        halfway_point_seconds: row.videoHalfSeconds,
        delta_vs_half_seconds: row.secondsFromHalf,
        half_position: row.halfPositionLabel,
        clip_progress_percent: typeof row.videoProgress === "number"
          ? decimalPercent(row.videoProgress)
          : null,
        completed_at: row.completedAt,
      })),
    },
  };

  const definition = definitions[report];

  if (!definition) {
    return;
  }

  const csv = serializeCsv(definition.rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = definition.fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function serializeCsv(rows) {
  if (!rows.length) {
    return "";
  }

  const headers = Object.keys(rows[0]);
  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      headers
        .map((header) => csvEscape(row[header]))
        .join(","),
    ),
  ];

  return lines.join("\n");
}

function csvEscape(value) {
  const stringValue = `${value ?? ""}`;

  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

function decimalPercent(value) {
  return Number((value * 100).toFixed(2));
}

function formatOrdinal(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return "";
  }

  const modHundred = numericValue % 100;

  if (modHundred >= 11 && modHundred <= 13) {
    return `${numericValue}th`;
  }

  switch (numericValue % 10) {
    case 1:
      return `${numericValue}st`;
    case 2:
      return `${numericValue}nd`;
    case 3:
      return `${numericValue}rd`;
    default:
      return `${numericValue}th`;
  }
}

function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

function formatDetailedPercent(value) {
  return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "n/a";
}

function formatSeconds(value) {
  return typeof value === "number" ? `${value.toFixed(2)}s` : "n/a";
}

function formatSignedSeconds(value) {
  return typeof value === "number"
    ? `${value > 0 ? "+" : ""}${value.toFixed(2)}s`
    : "n/a";
}

function formatDate(isoValue) {
  return new Date(isoValue).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function describeHalfComparison(value) {
  switch (value) {
    case "before-half":
      return "Before half";
    case "at-half":
      return "At half";
    case "after-half":
      return "After half";
    default:
      return "n/a";
  }
}

function normalizeName(value) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function escapeHtml(value) {
  return `${value ?? ""}`
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function loadStorage(key, fallbackValue) {
  try {
    const storedValue = localStorage.getItem(key);

    if (!storedValue) {
      return fallbackValue;
    }

    return JSON.parse(storedValue);
  } catch (error) {
    return fallbackValue;
  }
}

function saveStorage(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function getFiniteNumber(value) {
  return Number.isFinite(value) ? roundSeconds(value) : null;
}

function roundSeconds(value) {
  return Number(value.toFixed(2));
}

function roundRatio(value) {
  return Number(value.toFixed(4));
}

function averageOfValues(values) {
  const numericValues = values.filter((value) => typeof value === "number");

  if (!numericValues.length) {
    return null;
  }

  return roundSeconds(
    numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length,
  );
}

function calculateAfterHalfRate(answers) {
  const comparableAnswers = answers.filter(
    (answer) => typeof answer.videoHalfSeconds === "number",
  );

  if (!comparableAnswers.length) {
    return 0;
  }

  const afterHalfCount = comparableAnswers.filter(
    (answer) => answer.halfComparison === "after-half" || answer.halfComparison === "at-half",
  ).length;

  return afterHalfCount / comparableAnswers.length;
}
