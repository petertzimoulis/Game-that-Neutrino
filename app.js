const STORAGE_KEYS = {
  currentRun: "game-that-neutrino-current-run",
  lastName: "game-that-neutrino-last-name",
  selectedMode: "game-that-neutrino-selected-mode",
};

const API_PLAYERS_URL = "/api/players";
const API_QUIZ_PLAYERS_URL = "/api/quiz-players";
const API_ANALYTICS_URL = "/api/analytics";
const API_ANALYTICS_EVENTS_URL = "/api/analytics-events";
const COIN_ICON_SRC = "coin.png";
const VIDEO_PLAYBACK_RATE = 2;
const PLAYER_SYNC_INTERVAL_MS = 15000;
const ANALYTICS_FLUSH_INTERVAL_MS = 4000;
const RUN_VIDEO_COUNT = 15;
const QUIZ_VIDEO_COUNT = 10;
const QUIZ_TRACK_COUNT = 5;
const QUIZ_CASCADE_COUNT = 5;

const MANIFEST_SOURCES = [
  {
    folderName: "Group 1",
    manifestFile: "Group1Manifest.csv",
    sectionId: "market",
  },
  {
    folderName: "Group 2",
    manifestFile: "Group2Manifest.csv",
    sectionId: "market",
  },
  {
    folderName: "Group 3",
    manifestFile: "Group3Manifest.csv",
    sectionId: "market",
  },
  {
    folderName: "Group 4",
    manifestFile: "Group4Manifest.csv",
    sectionId: "market",
  },
];

const SECTION_TEMPLATES = [
  {
    id: "market",
    label: "Group 3",
    title: "Public Lines",
    coinMode: true,
    publicLines: true,
    description: (clipCount) =>
      `Each run samples ${clipCount} random clips from the full catalog. Every clip uses the public-lines format with live Track vs Cascade percentages, coin scoring, the hot-hand bonus, and the optional Double or Nothing wager.`,
  },
];

const SEEDED_PUBLIC_LINE_COUNTS = {};
const MODE_CONFIGS = {
  friday: {
    id: "friday",
    title: "Friday Lineup",
    leaderboardTitle: "Friday Leaderboard",
    startButtonLabel: "Start Friday lineup",
  },
  quiz: {
    id: "quiz",
    title: "Learning Quiz",
    leaderboardTitle: "Learning Quiz Leaderboard",
    startButtonLabel: "Start learning quiz",
  },
};

let ALL_VIDEOS = [];
let ALL_VIDEOS_BY_ID = {};
let SECTIONS = [];
let VIDEOS = [];
let VIDEOS_BY_ID = {};

const state = {
  players: [],
  playerHistory: [],
  quizPlayers: [],
  quizHistory: [],
  currentRun: normalizeStoredRun(loadStorage(STORAGE_KEYS.currentRun, null)),
  lastName: loadStorage(STORAGE_KEYS.lastName, ""),
  selectedMode: loadStorage(STORAGE_KEYS.selectedMode, "friday"),
  lastCompletedRun: null,
  showHelp: false,
  showAnalysis: false,
  catalogLoaded: false,
  catalogError: null,
  scheduleLoaded: false,
  scheduleError: null,
  quizLeaderboardLoaded: false,
  quizLeaderboardError: null,
  activeCycleStart: null,
  activeCycleEnd: null,
  activeVideoIds: [],
  catalogSize: 0,
  analyticsLoaded: false,
  analyticsError: null,
  analyticsSummary: null,
  recentAnalyticsEvents: [],
  analyticsSessionId: createSessionId(),
};

const appRoot = document.querySelector("#app");
const helpRoot = document.querySelector("#help-modal-root");
const analysisRoot = document.querySelector("#analysis-modal-root");
let playerSyncTimerId = null;
let analyticsFlushTimerId = null;
const analyticsQueue = [];
const videoAnalyticsTimestamps = new Map();

render();
void initializeVideoCatalog();
initializeSharedPlayers();
initializeAnalyticsTracking();

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

  const quizChoiceButton = event.target.closest("[data-quiz-choice]");

  if (quizChoiceButton) {
    setQuizChoice(
      quizChoiceButton.dataset.videoId,
      quizChoiceButton.dataset.quizChoice,
    );
    return;
  }

  const actionButton = event.target.closest("[data-action]");

  if (!actionButton) {
    return;
  }

  const { action } = actionButton.dataset;

  switch (action) {
    case "go-home":
      trackEvent("go_home", {
        mode: getActiveMode(),
      });
      goHome();
      break;
    case "select-mode":
      trackEvent("mode_selected", {
        previousMode: getActiveMode(),
        nextMode: actionButton.dataset.mode,
      });
      selectMode(actionButton.dataset.mode);
      break;
    case "open-help":
      trackEvent("help_opened", {
        mode: getActiveMode(),
      });
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
    case "submit-quiz":
      trackEvent("quiz_submit_clicked", {
        mode: "quiz",
        quizStatus: buildQuizStatus(state.currentRun || { videoOrder: [], quizChoices: {} }),
      });
      submitQuizRun();
      break;
    case "open-analysis":
      trackEvent("analysis_opened", {
        mode: getActiveMode(),
      });
      state.showHelp = false;
      state.showAnalysis = true;
      render();
      void syncAllDataFromServer();
      break;
    case "close-analysis":
      state.showAnalysis = false;
      render();
      break;
    case "download-csv":
      downloadCsv(actionButton.dataset.report);
      break;
    case "play-again":
      trackEvent("play_again_clicked", {
        mode: getActiveMode(),
      });
      state.lastCompletedRun = null;
      render();
      void syncAllDataFromServer();
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

  beginRun(rawName, state.selectedMode);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && (state.showAnalysis || state.showHelp)) {
    state.showHelp = false;
    state.showAnalysis = false;
    render();
  }
});

async function initializeVideoCatalog() {
  try {
    const catalog = await loadVideoCatalog();

    ALL_VIDEOS = catalog.videos;
    ALL_VIDEOS_BY_ID = Object.fromEntries(
      ALL_VIDEOS.map((video) => [video.id, video]),
    );
    state.catalogLoaded = true;
    state.catalogError = null;
    applyWeeklyVideoSelection();
  } catch (error) {
    console.error(error);
    state.catalogLoaded = true;
    state.catalogError = error instanceof Error
      ? error.message
      : "Couldn't load the video manifests.";
  }

  render();
}

async function loadVideoCatalog() {
  const sourceResults = await Promise.all(
    MANIFEST_SOURCES.map((source) => loadManifestSource(source)),
  );
  const videos = sourceResults.flatMap((result) => result.videos);

  if (!videos.length) {
    throw new Error("No manifest videos were found.");
  }

  return {
    videos,
  };
}

async function loadManifestSource(source) {
  const manifestUrl = buildAssetUrl("videos", source.folderName, source.manifestFile);
  const response = await fetch(manifestUrl);

  if (!response.ok) {
    throw new Error(`Failed to load manifest ${source.manifestFile}: ${response.status}`);
  }

  const manifestText = await response.text();
  const rows = parseCsv(manifestText);
  const videos = rows.map((row, index) => buildVideoFromManifestRow(row, source, index));

  return {
    ...source,
    videos: videos.filter(Boolean),
  };
}

function buildVideoFromManifestRow(row, source, index) {
  const fileName = `${row.video || row.Video || ""}`.trim();

  if (!fileName) {
    return null;
  }

  const interactionType = `${row["#InteractionType"] || row.InteractionType || ""}`.trim();
  const correctChoice = getChoiceFromInteractionType(interactionType);

  if (!correctChoice) {
    throw new Error(
      `Unsupported interaction type "${interactionType}" in ${source.manifestFile} for ${fileName}.`,
    );
  }

  const eventId = `${row["#EventID"] || row.EventID || extractEventId(fileName) || ""}`.trim();

  return {
    id: `${source.folderName}/${fileName}`,
    label: eventId ? `Event ${eventId}` : `${source.folderName} Clip ${index + 1}`,
    src: buildAssetUrl("videos", source.folderName, fileName),
    sourceGroup: source.folderName,
    sectionId: source.sectionId,
    manifestIndex: index + 1,
    interactionType,
    correctChoice,
  };
}

function buildSections(videos) {
  return SECTION_TEMPLATES.reduce((sections, template) => {
    const sectionVideos = videos.filter((video) => video.sectionId === template.id);
    const playableVideoCount = Math.min(RUN_VIDEO_COUNT, sectionVideos.length);

    if (!playableVideoCount) {
      return sections;
    }

    const section = {
      id: template.id,
      label: template.label,
      title: template.title,
      coinMode: template.coinMode,
      publicLines: template.publicLines,
      description: template.description(playableVideoCount),
      startIndex: 0,
      endIndex: playableVideoCount - 1,
      videoIds: sectionVideos.map((video) => video.id),
    };

    sections.push(section);
    return sections;
  }, []);
}

function applyWeeklyVideoSelection() {
  if (!state.catalogLoaded || !state.scheduleLoaded) {
    return;
  }

  const activeVideoIds = Array.isArray(state.activeVideoIds) ? state.activeVideoIds : [];
  const weeklyVideos = activeVideoIds
    .map((videoId) => ALL_VIDEOS_BY_ID[videoId])
    .filter(Boolean);

  if (!weeklyVideos.length) {
    state.scheduleError = "The server did not provide a playable Friday lineup.";
    VIDEOS = [];
    VIDEOS_BY_ID = {};
    SECTIONS = [];
    return;
  }

  VIDEOS = weeklyVideos;
  VIDEOS_BY_ID = Object.fromEntries(
    VIDEOS.map((video) => [video.id, video]),
  );
  SECTIONS = buildSections(VIDEOS);
  state.catalogSize = ALL_VIDEOS.length;
  state.scheduleError = null;
}

function parseCsv(csvText) {
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return [];
  }

  const headers = parseCsvLine(lines[0]);

  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);

    return headers.reduce((row, header, index) => {
      row[header] = values[index] ?? "";
      return row;
    }, {});
  });
}

function parseCsvLine(line) {
  const values = [];
  let currentValue = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const nextCharacter = line[index + 1];

    if (character === "\"") {
      if (inQuotes && nextCharacter === "\"") {
        currentValue += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }

      continue;
    }

    if (character === "," && !inQuotes) {
      values.push(currentValue);
      currentValue = "";
      continue;
    }

    currentValue += character;
  }

  values.push(currentValue);
  return values;
}

function getChoiceFromInteractionType(interactionType) {
  if (interactionType === "1") {
    return "track";
  }

  if (interactionType === "2") {
    return "cascade";
  }

  return null;
}

function extractEventId(fileName) {
  const match = fileName.match(/event(\d+)/i);
  return match ? match[1] : null;
}

function buildAssetUrl(...segments) {
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

function render() {
  const activeMode = getActiveMode();
  const activeModeError = activeMode === "quiz" ? state.quizLeaderboardError : state.scheduleError;
  const activeModeLoaded = activeMode === "quiz"
    ? state.quizLeaderboardLoaded
    : state.scheduleLoaded;

  if (!state.catalogLoaded || !state.scheduleLoaded || !state.quizLeaderboardLoaded || !activeModeLoaded) {
    appRoot.innerHTML = renderCatalogStateView({
      title: activeMode === "quiz" ? "Loading learning quiz" : "Loading Friday lineup",
      description:
        activeMode === "quiz"
          ? "Preparing the full catalog and separate learning-quiz leaderboard."
          : "Preparing the shared Friday 15-video lineup and weekly leaderboard reset state.",
    });
    helpRoot.innerHTML = "";
    analysisRoot.innerHTML = "";
    return;
  }

  if (state.catalogError || activeModeError) {
    appRoot.innerHTML = renderCatalogStateView({
      title: "Video catalog unavailable",
      description: state.catalogError || activeModeError,
    });
    helpRoot.innerHTML = "";
    analysisRoot.innerHTML = "";
    return;
  }

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

function renderCatalogStateView({ title, description }) {
  return `
    <section class="panel appear">
      <div class="panel-inner">
        <p class="eyebrow">Neutrino Catalog</p>
        <h2 class="hero-title">${escapeHtml(title)}</h2>
        <p class="hero-copy">${escapeHtml(description)}</p>
      </div>
    </section>
  `;
}

function renderLandingView() {
  if (state.lastCompletedRun) {
    return renderResultsView(state.lastCompletedRun);
  }

  const activeMode = getActiveMode();
  const leaderboard = buildLeaderboard(getPlayersForMode(activeMode), activeMode);
  const hasLeaderboard = leaderboard.length > 0;
  const marketSection = getSectionById("market");
  const marketClipCount = marketSection ? getSectionQuestionCount(marketSection) : 0;
  const cycleStartLabel = formatCycleDate(state.activeCycleStart);
  const cycleEndLabel = formatCycleDate(state.activeCycleEnd);

  const modeSpecificContent = activeMode === "quiz"
    ? renderQuizLandingContent({ leaderboard, hasLeaderboard })
    : renderFridayLandingContent({
      leaderboard,
      hasLeaderboard,
      marketClipCount,
      cycleStartLabel,
      cycleEndLabel,
    });

  return `
    <section class="welcome-layout appear">
      <article class="panel hero-card">
        <div class="panel-inner">
          <div class="mode-switcher">
            ${renderModeToggleButton("friday", "Friday Lineup", "Shared weekly run")}
            ${renderModeToggleButton("quiz", "Learning Quiz", "10 videos at once")}
          </div>
          ${modeSpecificContent.hero}
        </div>
      </article>

      <aside class="panel">
        <div class="panel-inner">
          <div class="table-caption">
            <div>
              <p class="eyebrow">${activeMode === "quiz" ? "Learning Board" : "Live Board"}</p>
              <h2 class="card-title">${MODE_CONFIGS[activeMode].leaderboardTitle}</h2>
            </div>
            <span class="pill-note">${hasLeaderboard ? `${leaderboard.length} completed player${leaderboard.length === 1 ? "" : "s"}` : "Waiting on first finish"}</span>
          </div>

          ${
            hasLeaderboard
              ? renderLeaderboardTable(leaderboard, null, activeMode)
              : `
                <div class="empty-state">
                  <p class="empty-state-copy">
                    ${activeMode === "quiz"
                      ? "Completed learning quizzes will land here with total correct, accuracy, and completion time."
                      : "Completed runs will land here with the player name, coin score, and accuracy."}
                    Analysis &amp; Export uses the same stored data for CSV downloads.
                  </p>
                </div>
              `
          }

          ${modeSpecificContent.aside}
        </div>
      </aside>
    </section>
  `;
}

function renderModeToggleButton(mode, label, caption) {
  const isActive = getActiveMode() === mode;

  return `
    <button
      type="button"
      class="mode-toggle ${isActive ? "is-active" : ""}"
      data-action="select-mode"
      data-mode="${mode}"
    >
      <strong>${label}</strong>
      <span>${caption}</span>
    </button>
  `;
}

function renderFridayLandingContent({
  leaderboard,
  hasLeaderboard,
  marketClipCount,
  cycleStartLabel,
  cycleEndLabel,
}) {
  return {
    hero: `
      <p class="eyebrow">${state.catalogSize || ALL_VIDEOS.length} videos in the catalog. Shared Friday set of ${marketClipCount}.</p>
      <h2 class="hero-title">Classify the event. Read the line. Build the board.</h2>
      <p class="hero-copy">
        Players enter a name, play the shared Friday lineup of ${marketClipCount} clips, and
        finish on a weekly leaderboard. Every question runs in the Group 3 public-lines format
        with live percentages, coin scoring, hot-hand bonuses, and optional Double or Nothing.
      </p>

      <p class="subtle-copy">
        Current Friday slate: ${cycleStartLabel}${cycleEndLabel ? ` through ${cycleEndLabel}` : ""}. A new 15-video set and a fresh leaderboard go live every Friday.
      </p>

      <div class="feature-strip">
        <div class="feature-chip">
          <strong>Run Format</strong>
          <span>Everyone sees the same ${marketClipCount} videos for the current Friday slate.</span>
        </div>
        <div class="feature-chip">
          <strong>Group 3 Rules</strong>
          <span>Every clip shows live public Track and Cascade lines and starts with the coin bank already active.</span>
        </div>
        <div class="feature-chip">
          <strong>Weekly Reset</strong>
          <span>Each Friday the lineup refreshes and the leaderboard resets for the new week.</span>
        </div>
      </div>

      ${renderStartForm({
        buttonLabel: `Start Friday lineup of ${marketClipCount} videos`,
        helperCopy: `
          Every clip now pulls its Track/Cascade answer from the manifest
          <code>#InteractionType</code>
          field, so scores, coins, leaderboard standings, and analysis accuracy stay aligned
          with the new folder layout.
        `,
      })}
    `,
    aside: `
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
    `,
  };
}

function renderQuizLandingContent({ leaderboard, hasLeaderboard }) {
  return {
    hero: `
      <p class="eyebrow">${state.catalogSize || ALL_VIDEOS.length} videos in the catalog. Each quiz draws 10 fresh clips.</p>
      <h2 class="hero-title">Study every clip at once, then submit one learning check.</h2>
      <p class="hero-copy">
        The learning quiz is a one-page review board. Every run draws 5 random Track clips and 5
        random Cascade clips with no repeats, shows all 10 videos at once, and keeps a separate
        leaderboard focused on accuracy instead of coin scoring.
      </p>

      <p class="subtle-copy">
        Choose Track, Cascade, or leave a clip as Undecided while reviewing. Correct answers stay
        hidden until you submit, then the app reveals the full answer key and lets you review all
        10 clips with your choices side by side.
      </p>

      <div class="feature-strip">
        <div class="feature-chip">
          <strong>10 Videos</strong>
          <span>Every quiz shows all 10 clips on one screen so it works like a study board instead of a step-by-step game.</span>
        </div>
        <div class="feature-chip">
          <strong>Balanced Draw</strong>
          <span>Each run pulls 5 Track and 5 Cascade examples from the full catalog with no repeating clips.</span>
        </div>
        <div class="feature-chip">
          <strong>Separate Board</strong>
          <span>Learning-mode accuracy saves to its own leaderboard and never mixes with the Friday coin mode.</span>
        </div>
      </div>

      ${renderStartForm({
        buttonLabel: "Start learning quiz of 10 videos",
        helperCopy: "This mode is designed as a learning tool, so you can rewatch every video before submitting and only see the answer key at the end.",
      })}
    `,
    aside: `
      <div class="mini-card-grid">
        <div class="mini-card">
          <span>Score</span>
          <strong>Accuracy-first</strong>
          <p>The quiz leaderboard ranks by total correct and accuracy instead of the Friday coin wallet.</p>
        </div>
        <div class="mini-card">
          <span>Review</span>
          <strong>Answer key at end</strong>
          <p>Submit once, then inspect each clip with your choice, the correct label, and full video review on the results screen.</p>
        </div>
      </div>
    `,
  };
}

function renderStartForm({ buttonLabel, helperCopy }) {
  return `
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
          <button type="submit" class="primary-button">${buttonLabel}</button>
          <button type="button" class="secondary-button" data-action="open-help">
            Learn Track vs Cascade
          </button>
        </div>
      </form>

      <p class="subtle-copy">${helperCopy}</p>
    </div>
  `;
}

function renderRunView(run) {
  if (run.mode === "quiz") {
    return run.phase === "quiz-results"
      ? renderQuizResultsView(run)
      : renderQuizBoardView(run);
  }

  return run.phase === "feedback" ? renderFeedbackView(run) : renderQuestionView(run);
}

function renderQuizBoardView(run) {
  const quizStatus = buildQuizStatus(run);

  return `
    <section class="panel appear quiz-board-panel">
      <div class="panel-inner quiz-layout">
        <div class="quiz-header">
          <div class="game-heading-block">
            <p class="eyebrow">Learning Quiz</p>
            <h2 class="hero-title">Review all 10 clips, then submit one score.</h2>
            <p class="game-copy">
              This learning board draws 5 Track and 5 Cascade clips with no repeats.
              Answers stay hidden until submission, and the status rail on the right tracks what
              you have marked as Track, Cascade, or Undecided.
            </p>
          </div>

          <div class="status-strip status-strip-compact">
            <div class="stat-card">
              <span>Player</span>
              <strong>${escapeHtml(run.name)}</strong>
            </div>
            <div class="stat-card">
              <span>Reviewed</span>
              <strong data-quiz-count="reviewed">${quizStatus.decidedCount} / ${getRunVideoCount(run)}</strong>
            </div>
            <div class="stat-card">
              <span>Undecided</span>
              <strong data-quiz-count="undecided">${quizStatus.undecidedCount}</strong>
            </div>
          </div>
        </div>

        <div class="quiz-stage">
          <div class="quiz-main-column">
            <div class="quiz-video-grid">
              ${run.videoOrder.map((videoId, index) => renderQuizVideoCard(run, videoId, index)).join("")}
            </div>

            <div class="quiz-submit-footer">
              <div class="mini-card quiz-submit-card">
                <span>Finished reviewing all 10?</span>
                <strong>Submit from the bottom too.</strong>
                <p>Use this button after you reach the end of the quiz page to reveal the answer key and save the score.</p>
                <div class="button-row">
                  <button type="button" class="primary-button" data-action="submit-quiz">
                    Submit score and reveal answer key
                  </button>
                </div>
              </div>
            </div>
          </div>

          <aside class="quiz-sidebar">
            <div class="decision-card quiz-sidebar-card">
              <div class="round-note">
                <strong>Submission rules</strong>
                <p class="subtle-copy decision-copy">
                  Undecided is useful while studying, but only Track and Cascade can be correct.
                  Any clip left Undecided will count as not yet solved when you submit.
                </p>
              </div>

              <div class="quiz-status-grid">
                <div class="mini-card compact-card">
                  <span>Track picks</span>
                  <strong data-quiz-count="track">${quizStatus.trackCount}</strong>
                  <p>Clips currently labeled Track.</p>
                </div>
                <div class="mini-card compact-card">
                  <span>Cascade picks</span>
                  <strong data-quiz-count="cascade">${quizStatus.cascadeCount}</strong>
                  <p>Clips currently labeled Cascade.</p>
                </div>
                <div class="mini-card compact-card">
                  <span>Undecided</span>
                  <strong data-quiz-count="sidebar-undecided">${quizStatus.undecidedCount}</strong>
                  <p>Clips that still need a final classification.</p>
                </div>
              </div>

              <div class="quiz-status-list">
                ${run.videoOrder.map((videoId, index) => renderQuizStatusItem(run, videoId, index)).join("")}
              </div>

              <div class="button-row">
                <button type="button" class="primary-button" data-action="submit-quiz">
                  Submit score and reveal answer key
                </button>
                <button type="button" class="ghost-button" data-action="open-help">
                  Need help spotting Track vs Cascade?
                </button>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </section>
  `;
}

function renderQuizVideoCard(run, videoId, index) {
  const video = ALL_VIDEOS_BY_ID[videoId];
  const selection = getQuizSelection(run, videoId);

  if (!video) {
    return "";
  }

  return `
    <article class="quiz-video-card">
      <div class="section-pill section-pill-compact">
        <strong>Video ${index + 1}</strong>
        <span>${video.label} • ${video.sourceGroup}</span>
      </div>

      <div class="video-shell quiz-video-shell">
        <video controls muted playsinline preload="metadata" src="${video.src}"></video>
      </div>

      <div class="quiz-choice-grid">
        ${renderQuizChoiceButton(videoId, "track", "Track", selection === "track")}
        ${renderQuizChoiceButton(videoId, "cascade", "Cascade", selection === "cascade")}
        ${renderQuizChoiceButton(videoId, "undecided", "Undecided", selection === "undecided")}
      </div>
    </article>
  `;
}

function renderQuizChoiceButton(videoId, choice, label, isSelected) {
  return `
    <button
      type="button"
      class="quiz-choice-button quiz-choice-button-${choice} ${isSelected ? "is-selected" : ""}"
      data-quiz-choice="${choice}"
      data-video-id="${videoId}"
      aria-pressed="${isSelected ? "true" : "false"}"
    >
      ${label}
    </button>
  `;
}

function renderQuizStatusItem(run, videoId, index) {
  const video = ALL_VIDEOS_BY_ID[videoId];
  const selection = getQuizSelection(run, videoId);

  return `
    <div class="quiz-status-item" data-quiz-status-item="${videoId}">
      <div>
        <strong>Video ${index + 1}</strong>
        <span>${escapeHtml(video?.label || "Unknown clip")}</span>
      </div>
      <span class="quiz-status-pill quiz-status-pill-${selection}" data-quiz-status-pill>${titleCase(selection)}</span>
    </div>
  `;
}

function renderQuizResultsView(run) {
  const leaderboard = buildLeaderboard(state.quizPlayers, "quiz");
  const stats = calculateRunStats(run.answers, "quiz");

  return `
    <section class="results-layout appear">
      <article class="panel">
        <div class="panel-inner score-panel">
          <div class="score-shell">
            <div>
              <p class="eyebrow">Learning Quiz Complete</p>
              <h2 class="score-title">${escapeHtml(run.name)} reviewed all ${getRunVideoCount(run)} quiz videos</h2>
              <p class="hero-copy">
                Your score is now stored on the separate learning leaderboard. The answer key
                below reveals each correct label and keeps all 10 clips available for review.
              </p>
            </div>

            <div class="score-stack">
              <div class="score-badge score-badge-quiz">
                <p class="score-value">${stats.totalCorrect} / ${stats.totalQuestions}</p>
              </div>
              <p class="score-caption">${formatPercent(stats.totalAccuracy)} accuracy</p>
            </div>
          </div>

          <div class="results-strip results-strip-quiz">
            <div class="summary-card">
              <span>Total correct</span>
              <strong>${stats.totalCorrect}</strong>
              <p>${stats.totalQuestions - stats.totalCorrect} clips were missed or left undecided.</p>
            </div>
            <div class="summary-card">
              <span>Accuracy</span>
              <strong>${formatPercent(stats.totalAccuracy)}</strong>
              <p>Quiz leaderboard ranking is based on total correct, then accuracy.</p>
            </div>
            <div class="summary-card">
              <span>Track pool</span>
              <strong>${stats.sectionStats.track.correct} / ${stats.sectionStats.track.total}</strong>
              <p>Track examples correctly identified in this run.</p>
            </div>
            <div class="summary-card">
              <span>Cascade pool</span>
              <strong>${stats.sectionStats.cascade.correct} / ${stats.sectionStats.cascade.total}</strong>
              <p>Cascade examples correctly identified in this run.</p>
            </div>
          </div>

          <div class="button-row">
            <button type="button" class="primary-button" data-action="play-again">Start another learning quiz</button>
            <button type="button" class="secondary-button" data-action="open-analysis">Open analysis</button>
          </div>

          <div class="quiz-review-grid">
            ${run.answers.map((answer) => renderQuizReviewCard(answer)).join("")}
          </div>
        </div>
      </article>

      <aside class="panel">
        <div class="panel-inner">
          <div class="table-caption">
            <div>
              <p class="eyebrow">Learning Standings</p>
              <h2 class="card-title">Learning Quiz Leaderboard</h2>
            </div>
            <span class="pill-note">${leaderboard.length} completed player${leaderboard.length === 1 ? "" : "s"}</span>
          </div>
          ${renderLeaderboardTable(leaderboard, run.nameKey, "quiz")}
        </div>
      </aside>
    </section>
  `;
}

function renderQuizReviewCard(answer) {
  const answerState = answer.correct
    ? "Correct"
    : answer.choice === "undecided"
      ? "Undecided"
      : "Incorrect";

  return `
    <article class="quiz-review-card">
      <div class="table-caption quiz-review-header">
        <div>
          <p class="eyebrow">${escapeHtml(answer.videoLabel)}</p>
          <h3 class="card-title">${escapeHtml(answer.sourceGroup)}</h3>
        </div>
        <span class="quiz-review-pill ${answer.correct ? "is-correct" : "is-wrong"}">${answerState}</span>
      </div>

      <div class="video-shell quiz-video-shell">
        <video controls muted playsinline preload="metadata" src="${answer.videoSrc}"></video>
      </div>

      <div class="quiz-review-meta">
        <div class="mini-card compact-card">
          <span>Your choice</span>
          <strong>${titleCase(answer.choice)}</strong>
          <p>${answer.choice === "undecided" ? "Left undecided at submit time." : "Stored exactly as submitted."}</p>
        </div>
        <div class="mini-card compact-card">
          <span>Correct answer</span>
          <strong>${titleCase(answer.expectedChoice)}</strong>
          <p>${answer.correct ? "You matched the answer key on this clip." : "Use the replay to compare the event shape again."}</p>
        </div>
      </div>
    </article>
  `;
}

function renderQuestionView(run) {
  const section = getSectionForIndex(run.currentIndex);
  const video = getVideoForRunIndex(run, run.currentIndex);
  const currentCoins = getVisibleCoins(run, section);
  const questionInSection = run.currentIndex - section.startIndex + 1;
  const sectionQuestionCount = getRunVideoCount(run);
  const overallQuestionNumber = run.currentIndex + 1;
  const lines = section.publicLines ? getPublicLines(video.id, state.players) : null;

  return `
    <section class="panel appear game-panel">
      <div class="panel-inner game-panel-inner">
        <div class="game-header game-header-compact">
          <div class="game-heading-block">
            <p class="eyebrow">${section.label}</p>
            <h2 class="hero-title">${section.title}</h2>
            <p class="game-copy">Clip ${overallQuestionNumber} of ${getRunVideoCount(run)} • Question ${questionInSection} of ${sectionQuestionCount} in this run</p>
          </div>

          <div class="status-strip status-strip-compact">
            <div class="stat-card">
              <span>Player</span>
              <strong>${escapeHtml(run.name)}</strong>
            </div>
            <div class="stat-card">
              <span>Question</span>
              <strong>${overallQuestionNumber} / ${getRunVideoCount(run)}</strong>
            </div>
            <div class="wallet-card">
              <span>Coin Bank</span>
              <strong>
                ${
                  currentCoins === null
                    ? "Starts at 10"
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
              <span>${video.sourceGroup} • Coins and public lines live</span>
            </div>

            <div class="video-shell game-video-shell">
              <video controls autoplay muted playsinline preload="metadata" data-autoplay="true" src="${video.src}"></video>
            </div>
          </div>

          <div class="decision-column">
            <div class="decision-card ${section.publicLines ? "decision-card-market" : ""}">
              <div class="round-note">
                <strong>${questionInSection === 1 ? "Run briefing" : "Run rules"}</strong>
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
                <strong>Group 3 live</strong>
                <p>Correct picks add 1 coin and wrong picks lose 1 coin. After 2 straight correct picks, each next consecutive correct pick earns 2 coins until the streak breaks. Double or Nothing changes one clip to -2 on a miss, +2 on a normal hit, or +3 on a streak hit.</p>
              </div>
              <div class="mini-card compact-card">
                <span>Public line</span>
                <strong>Built into each pick</strong>
                <p>Track and Cascade percentages are part of the answer cards and reflect the latest completed runs for that clip.</p>
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
  const isFinalQuestion = run.currentIndex === getRunVideoCount(run) - 1;
  const coinDelta = typeof answer.coinsAfter === "number" ? answer.coinsAfter - answer.coinsBefore : null;
  const nextLabel = isFinalQuestion ? "Finish and show leaderboard" : "Next video";
  const expectedChoice = getExpectedChoice(answer.videoId) || answer.choice;
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
      ? "Wallet did not change on this pick."
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
            <strong>${answer.questionNumber} / ${getRunVideoCount(run)}</strong>
            <p>${answer.sectionLabel}, question ${answer.sectionQuestionNumber} of ${sectionQuestionCount}.</p>
          </div>
          <div class="feedback-card">
            <span>Coin movement</span>
            <strong>${coinDelta === null ? "No change" : `${coinDelta > 0 ? "+" : ""}${coinDelta} coin${Math.abs(coinDelta) === 1 ? "" : "s"}`}</strong>
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
  if (run.mode === "quiz") {
    return renderQuizResultsView(run);
  }

  const leaderboard = buildLeaderboard(state.players);
  const stats = calculateRunStats(run.answers);
  const marketStats = stats.sectionStats.market || {
    correct: 0,
    total: 0,
    accuracy: 0,
  };

  return `
    <section class="results-layout appear">
      <article class="panel">
        <div class="panel-inner score-panel">
          <div class="score-shell">
            <div>
              <p class="eyebrow">Run Complete</p>
              <h2 class="score-title">${escapeHtml(run.name)} finished all ${getRunVideoCount(run)} sampled videos</h2>
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
              <span>Public lines</span>
              <strong>${formatPercent(marketStats.accuracy)}</strong>
              <p>${marketStats.correct} of ${marketStats.total} correct in Group 3 mode.</p>
            </div>
            <div class="summary-card">
              <span>Sample size</span>
              <strong>${getRunVideoCount(run)}</strong>
              <p>Random clips drawn from the ${VIDEOS.length}-video catalog.</p>
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
          ${renderLeaderboardTable(leaderboard, run.nameKey, "friday")}
        </div>
      </aside>
    </section>
  `;
}

function renderLeaderboardTable(leaderboard, highlightedNameKey, mode = "friday") {
  const isQuiz = mode === "quiz";

  return `
    <div class="leaderboard-scroll">
      <table class="leaderboard-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Player</th>
            <th>${isQuiz ? "Score" : "Coins"}</th>
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
                    ${
                      isQuiz
                        ? `<span class="score-pill">${player.totalCorrect} / ${player.totalQuestions}</span>`
                        : `
                          <span class="coin-badge">
                            <img class="coin-icon" src="${COIN_ICON_SRC}" alt="" aria-hidden="true" />
                            ${player.finalCoins}
                          </span>
                        `
                    }
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

  return getActiveMode() === "quiz"
    ? renderQuizAnalysisModal()
    : renderFridayAnalysisModal();
}

function renderFridayAnalysisModal() {
  const summaryRows = buildUserSummaryRows(state.players);
  const groupRows = buildGroupRows(state.players);
  const videoRows = buildVideoRows(state.players);
  const timingRows = buildTimingRows(state.players);
  const growthRows = buildGrowthRows(state.playerHistory, "friday");
  const weeklyTrendRows = buildFridayWeeklyTrendRows(state.playerHistory);
  const eventSummaryRows = buildEventSummaryRows(state.analyticsSummary);
  const recentEventRows = buildRecentEventRows(state.recentAnalyticsEvents);
  const hasFridayAnalysisData = Boolean(
    summaryRows.length ||
    growthRows.length ||
    weeklyTrendRows.length ||
    eventSummaryRows.length ||
    recentEventRows.length,
  );

  const averageCoins = summaryRows.length
    ? summaryRows.reduce((sum, row) => sum + row.finalCoins, 0) / summaryRows.length
    : 0;
  const averageAccuracy = summaryRows.length
    ? summaryRows.reduce((sum, row) => sum + row.totalAccuracy, 0) / summaryRows.length
    : 0;

  return renderAnalysisModalShell({
    eyebrow: "Owner View",
    title: "Analysis & Export",
    description:
      "This pulls from the shared Friday leaderboard and creates Excel-ready CSV tables for per-user, per-run, and per-video analysis.",
    body: hasFridayAnalysisData
      ? `
          <div class="summary-strip">
            <div class="summary-card">
              <span>Completed users</span>
              <strong>${summaryRows.length}</strong>
              <p>The live board still shows only the current Friday slate.</p>
            </div>
            <div class="summary-card">
              <span>Total attempts</span>
              <strong>${state.playerHistory.length}</strong>
              <p>Historical Friday attempts now persist across weekly lineup resets.</p>
            </div>
            <div class="summary-card">
              <span>Average coins</span>
              <strong>${averageCoins.toFixed(1)}</strong>
              <p>Average final wallet across all stored users.</p>
            </div>
            <div class="summary-card">
              <span>Average accuracy</span>
              <strong>${formatPercent(averageAccuracy)}</strong>
              <p>Overall correctness rate across the ${getRunVideoCount()}-video Group 3 format.</p>
            </div>
          </div>

          ${renderAnalysisTable({
            title: "Week-to-week Friday accuracy",
            note: "One row per player and Friday cycle, so you can see whether weekly accuracy improves over time even after the live leaderboard resets.",
            report: "weekly-growth",
            headers: ["Player", "Week", "Correct", "Total", "Accuracy", "Coins", "Completed"],
            rows: weeklyTrendRows.map((row) => [
              escapeHtml(row.name),
              row.weekLabel,
              row.totalCorrect,
              row.totalQuestions,
              formatPercent(row.totalAccuracy),
              row.finalCoins ?? "n/a",
              formatDate(row.completedAt),
            ]),
          })}

          ${renderAnalysisTable({
            title: "Per-user growth over time",
            note: "Tracks first week, latest week, best week, and overall improvement for each returning Friday player.",
            report: "user-growth",
            headers: ["Player", "Weeks", "First Week", "Latest Week", "Best Accuracy", "Growth", "Latest Coins"],
            rows: growthRows.map((row) => [
              escapeHtml(row.name),
              row.attempts,
              `${row.firstWeekLabel} • ${formatPercent(row.firstAccuracy)}`,
              `${row.latestWeekLabel} • ${formatPercent(row.latestAccuracy)}`,
              formatPercent(row.bestAccuracy),
              formatSignedPercent(row.accuracyGrowth),
              row.latestCoins ?? "n/a",
            ]),
          })}

          ${renderAnalysisTable({
            title: "Per-user summary",
            note: "Use this table for total user performance, final coin score, public-lines accuracy, and average decision timing.",
            report: "user-summary",
            headers: ["Player", "Coins", "Total Accuracy", "Public Lines Accuracy", "Avg Response Time", "Avg Clip Time At Pick", "After Half Rate", "Completed"],
            rows: summaryRows.map((row) => [
              escapeHtml(row.name),
              row.finalCoins,
              formatPercent(row.totalAccuracy),
              formatPercent(row.marketAccuracy),
              formatSeconds(row.averageResponseSeconds),
              formatSeconds(row.averageClipTimeAtChoiceSeconds),
              formatPercent(row.afterHalfRate),
              formatDate(row.completedAt),
            ]),
          })}

          ${renderAnalysisTable({
            title: "Per-user group breakdown",
            note: "One row per user for the single Group 3 public-lines format.",
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
            note: "Tracks completed live picks, then shows Track percentage, Cascade percentage, and overall pick accuracy for every video.",
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

          ${renderAnalysisTable({
            title: "Engagement telemetry summary",
            note: "Aggregates client listeners like help opens, video plays, seeks, answer locks, mode switches, and submissions.",
            report: "event-summary",
            headers: ["Event", "Count"],
            rows: eventSummaryRows.map((row) => [
              escapeHtml(row.eventType),
              row.count,
            ]),
          })}

          ${renderAnalysisTable({
            title: "Recent telemetry events",
            note: "Recent client-side listener events across the app, useful for understanding how users interact with clips and study flow.",
            report: "recent-events",
            headers: ["When", "Mode", "Event", "Player", "Run", "Video", "Detail"],
            rows: recentEventRows.map((row) => [
              formatDate(row.timestamp),
              row.mode,
              row.type,
              escapeHtml(row.nameKey || "n/a"),
              escapeHtml(row.runId || "n/a"),
              escapeHtml(row.videoRef || "n/a"),
              escapeHtml(row.detail),
            ]),
          })}
        `
      : renderEmptyAnalysisState(`There are no completed Friday runs yet. Once a player finishes a weekly lineup, the week-to-week growth tables will appear here automatically.`),
  });
}

function renderQuizAnalysisModal() {
  const summaryRows = buildQuizSummaryRows(state.quizPlayers);
  const detailRows = buildQuizAnswerRows(state.quizPlayers);
  const growthRows = buildGrowthRows(state.quizHistory, "quiz");
  const eventSummaryRows = buildEventSummaryRows(state.analyticsSummary);
  const recentEventRows = buildRecentEventRows(state.recentAnalyticsEvents);
  const averageAccuracy = summaryRows.length
    ? summaryRows.reduce((sum, row) => sum + row.totalAccuracy, 0) / summaryRows.length
    : 0;
  const averageScore = summaryRows.length
    ? summaryRows.reduce((sum, row) => sum + row.totalCorrect, 0) / summaryRows.length
    : 0;

  return renderAnalysisModalShell({
    eyebrow: "Owner View",
    title: "Learning Quiz Analysis",
    description:
      "This view pulls from the separate learning-quiz leaderboard and exports accuracy-first study results without mixing them into the Friday coin mode.",
    body: summaryRows.length
      ? `
          <div class="summary-strip">
            <div class="summary-card">
              <span>Completed users</span>
              <strong>${summaryRows.length}</strong>
              <p>Each name stores the latest completed learning quiz for that player.</p>
            </div>
            <div class="summary-card">
              <span>Total attempts</span>
              <strong>${state.quizHistory.length}</strong>
              <p>Every quiz attempt is preserved so improvement can be tracked over time.</p>
            </div>
            <div class="summary-card">
              <span>Average correct</span>
              <strong>${averageScore.toFixed(1)} / ${QUIZ_VIDEO_COUNT}</strong>
              <p>Average number of correct answers across quiz submissions.</p>
            </div>
            <div class="summary-card">
              <span>Average accuracy</span>
              <strong>${formatPercent(averageAccuracy)}</strong>
              <p>Overall correctness rate for the one-page learning quiz.</p>
            </div>
          </div>

          ${renderAnalysisTable({
            title: "Per-user quiz growth",
            note: "Shows how each learner improves across multiple quiz attempts over time.",
            report: "quiz-growth",
            headers: ["Player", "Attempts", "First Score", "Latest Score", "Best Score", "First Accuracy", "Latest Accuracy", "Growth"],
            rows: growthRows.map((row) => [
              escapeHtml(row.name),
              row.attempts,
              `${row.firstCorrect} / ${row.totalQuestions}`,
              `${row.latestCorrect} / ${row.totalQuestions}`,
              `${row.bestCorrect} / ${row.totalQuestions}`,
              formatPercent(row.firstAccuracy),
              formatPercent(row.latestAccuracy),
              formatSignedPercent(row.accuracyGrowth),
            ]),
          })}

          ${renderAnalysisTable({
            title: "Per-user quiz summary",
            note: "Use this table for total correct, total accuracy, and average decision timing in the learning mode.",
            report: "quiz-user-summary",
            headers: ["Player", "Correct", "Accuracy", "Avg Response Time", "Avg Clip Time At Pick", "After Half Rate", "Completed"],
            rows: summaryRows.map((row) => [
              escapeHtml(row.name),
              `${row.totalCorrect} / ${row.totalQuestions}`,
              formatPercent(row.totalAccuracy),
              formatSeconds(row.averageResponseSeconds),
              formatSeconds(row.averageClipTimeAtChoiceSeconds),
              formatPercent(row.afterHalfRate),
              formatDate(row.completedAt),
            ]),
          })}

          ${renderAnalysisTable({
            title: "Per-answer learning review",
            note: "One row per answered quiz clip, including undecided submissions, the expected answer, and response timing.",
            report: "quiz-answer-detail",
            headers: ["Player", "Video", "Your Choice", "Correct Answer", "Correct", "Response Time", "Clip Time At Pick", "Completed"],
            rows: detailRows.map((row) => [
              escapeHtml(row.name),
              escapeHtml(row.videoLabel),
              titleCase(row.choice),
              titleCase(row.expectedChoice),
              row.correct ? "Yes" : "No",
              formatSeconds(row.responseSeconds),
              formatSeconds(row.videoCurrentTimeSeconds),
              formatDate(row.completedAt),
            ]),
          })}

          ${renderAnalysisTable({
            title: "Engagement telemetry summary",
            note: "Aggregates client listeners like quiz choice changes, help opens, video plays, seeks, and submissions.",
            report: "event-summary",
            headers: ["Event", "Count"],
            rows: eventSummaryRows.map((row) => [
              escapeHtml(row.eventType),
              row.count,
            ]),
          })}

          ${renderAnalysisTable({
            title: "Recent telemetry events",
            note: "Recent client-side listener events across both modes for studying behavior and feature usage.",
            report: "recent-events",
            headers: ["When", "Mode", "Event", "Player", "Run", "Video", "Detail"],
            rows: recentEventRows.map((row) => [
              formatDate(row.timestamp),
              row.mode,
              row.type,
              escapeHtml(row.nameKey || "n/a"),
              escapeHtml(row.runId || "n/a"),
              escapeHtml(row.videoRef || "n/a"),
              escapeHtml(row.detail),
            ]),
          })}
        `
      : renderEmptyAnalysisState("There are no completed learning quizzes yet. Once someone submits a 10-video quiz, the separate export tables will appear here automatically."),
  });
}

function renderAnalysisModalShell({ eyebrow, title, description, body }) {
  return `
    <div class="modal-backdrop is-open" role="dialog" aria-modal="true">
      <section class="modal-panel">
        <div class="modal-inner">
          <div class="modal-header">
            <div>
              <p class="eyebrow">${eyebrow}</p>
              <h2 class="modal-title">${title}</h2>
              <p class="hero-copy">${description}</p>
            </div>

            <button type="button" class="ghost-button" data-action="close-analysis">Close</button>
          </div>

          ${body}
        </div>
      </section>
    </div>
  `;
}

function renderEmptyAnalysisState(message) {
  return `
    <div class="empty-state">
      <p class="empty-state-copy">${message}</p>
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
    const shouldAutoplay = video.dataset.autoplay === "true";
    const applyPlaybackRate = () => {
      video.defaultPlaybackRate = VIDEO_PLAYBACK_RATE;
      video.playbackRate = VIDEO_PLAYBACK_RATE;
    };

    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    applyPlaybackRate();

    video.onloadedmetadata = applyPlaybackRate;
    video.onplay = applyPlaybackRate;
    video.autoplay = shouldAutoplay;

    if (shouldAutoplay) {
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
    } else {
      video.oncanplay = applyPlaybackRate;
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
  void syncAllDataFromServer();
}

function initializeSharedPlayers() {
  void syncAllDataFromServer();

  if (!playerSyncTimerId) {
    playerSyncTimerId = window.setInterval(() => {
      if (!state.currentRun) {
        void syncAllDataFromServer();
      }
    }, PLAYER_SYNC_INTERVAL_MS);
  }

  window.addEventListener("focus", () => {
    if (!state.currentRun) {
      void syncAllDataFromServer();
    }
  });
}

async function syncAllDataFromServer() {
  await Promise.all([
    syncPlayersFromServer(),
    syncQuizPlayersFromServer(),
    syncAnalyticsFromServer(),
  ]);
}

async function syncLeaderboardsFromServer() {
  await Promise.all([syncPlayersFromServer(), syncQuizPlayersFromServer()]);
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
    applyFridayPayload(payload);
    state.scheduleLoaded = true;
    state.scheduleError = null;
    applyWeeklyVideoSelection();
    const runBecameInvalid = Boolean(
      state.currentRun && !isCurrentRunCompatible(state.currentRun),
    );

    if (!state.currentRun || state.showAnalysis || state.lastCompletedRun || runBecameInvalid) {
      render();
    }
  } catch (error) {
    console.error(error);
    state.scheduleLoaded = true;
    state.scheduleError = error instanceof Error
      ? error.message
      : "Couldn't load the shared Friday lineup.";
    render();
  }
}

async function syncQuizPlayersFromServer() {
  try {
    const response = await fetch(`${API_QUIZ_PLAYERS_URL}?t=${Date.now()}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Failed to load learning-quiz players: ${response.status}`);
    }

    const payload = await response.json();
    applyQuizPayload(payload);
    state.quizLeaderboardLoaded = true;
    state.quizLeaderboardError = null;

    if (!state.currentRun || state.showAnalysis || state.lastCompletedRun || getActiveMode() === "quiz") {
      render();
    }
  } catch (error) {
    console.error(error);
    state.quizLeaderboardLoaded = true;
    state.quizLeaderboardError = error instanceof Error
      ? error.message
      : "Couldn't load the learning quiz leaderboard.";
    render();
  }
}

async function syncAnalyticsFromServer() {
  try {
    const response = await fetch(`${API_ANALYTICS_URL}?t=${Date.now()}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Failed to load analytics: ${response.status}`);
    }

    const payload = await response.json();
    applyAnalyticsPayload(payload);
    state.analyticsLoaded = true;
    state.analyticsError = null;
  } catch (error) {
    console.error(error);
    state.analyticsLoaded = true;
    state.analyticsError = error instanceof Error
      ? error.message
      : "Couldn't load analytics telemetry.";
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
    let message = `Failed to upload player record: ${response.status}`;

    try {
      const payload = await response.json();

      if (typeof payload.error === "string" && payload.error) {
        message = payload.error;
      }
    } catch (error) {
      console.error(error);
    }

    throw new Error(message);
  }

  return response.json();
}

async function uploadQuizPlayerRecord(playerRecord) {
  const response = await fetch(API_QUIZ_PLAYERS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(playerRecord),
  });

  if (!response.ok) {
    let message = `Failed to upload quiz player record: ${response.status}`;

    try {
      const payload = await response.json();

      if (typeof payload.error === "string" && payload.error) {
        message = payload.error;
      }
    } catch (error) {
      console.error(error);
    }

    throw new Error(message);
  }

  return response.json();
}

function applyFridayPayload(payload) {
  state.players = Array.isArray(payload.players) ? payload.players : [];
  state.playerHistory = Array.isArray(payload.history) ? payload.history : [];
  state.activeCycleStart = typeof payload.activeCycleStart === "string"
    ? payload.activeCycleStart
    : null;
  state.activeCycleEnd = typeof payload.activeCycleEnd === "string"
    ? payload.activeCycleEnd
    : null;
  state.activeVideoIds = Array.isArray(payload.activeVideoIds)
    ? payload.activeVideoIds.filter((videoId) => typeof videoId === "string")
    : [];
  state.catalogSize = typeof payload.catalogSize === "number"
    ? payload.catalogSize
    : state.catalogSize;
}

function applyQuizPayload(payload) {
  state.quizPlayers = Array.isArray(payload.players) ? payload.players : [];
  state.quizHistory = Array.isArray(payload.history) ? payload.history : [];
  state.catalogSize = typeof payload.catalogSize === "number"
    ? payload.catalogSize
    : state.catalogSize;
}

function applyAnalyticsPayload(payload) {
  state.analyticsSummary = payload?.summary && typeof payload.summary === "object"
    ? payload.summary
    : null;
  state.recentAnalyticsEvents = Array.isArray(payload?.recentEvents)
    ? payload.recentEvents
    : [];
}

function beginRun(rawName, mode = "friday") {
  const name = rawName.trim();
  const questionStartedAt = new Date().toISOString();
  const normalizedMode = mode === "quiz" ? "quiz" : "friday";

  state.lastName = name;
  saveStorage(STORAGE_KEYS.lastName, name);
  state.selectedMode = normalizedMode;
  saveStorage(STORAGE_KEYS.selectedMode, normalizedMode);

  state.lastCompletedRun = null;
  state.currentRun = normalizedMode === "quiz"
    ? {
      id: `quiz-run-${Date.now()}`,
      mode: "quiz",
      name,
      nameKey: normalizeName(name),
      videoOrder: buildQuizRunVideoOrder(),
      quizChoices: {},
      currentIndex: 0,
      phase: "quiz-board",
      answers: [],
      startedAt: new Date().toISOString(),
      questionStartedAt,
    }
    : {
      id: `run-${Date.now()}`,
      mode: "friday",
      name,
      nameKey: normalizeName(name),
      cycleStart: state.activeCycleStart,
      videoOrder: buildRunVideoOrder("friday"),
      currentIndex: 0,
      phase: "question",
      answers: [],
      coins: null,
      startedAt: new Date().toISOString(),
      questionStartedAt,
    };

  saveStorage(STORAGE_KEYS.currentRun, state.currentRun);
  trackEvent("run_started", {
    mode: normalizedMode,
    nameKey: state.currentRun.nameKey,
    runId: state.currentRun.id,
    videoCount: getRunVideoCount(state.currentRun),
  });
  render();
}

function handleChoice(choice) {
  const run = state.currentRun;

  if (!run || run.mode === "quiz" || run.phase !== "question") {
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

  trackEvent("friday_answer_locked", {
    mode: "friday",
    runId: run.id,
    nameKey: run.nameKey,
    videoId: video.id,
    choice,
    correct,
    doubleDown,
    responseSeconds: timing.responseSeconds,
    videoCurrentTimeSeconds: timing.videoCurrentTimeSeconds,
    questionNumber: run.currentIndex + 1,
  });

  run.phase = "feedback";
  saveStorage(STORAGE_KEYS.currentRun, run);
  render();
}

function setQuizChoice(videoId, choice) {
  const run = state.currentRun;

  if (!run || run.mode !== "quiz") {
    return;
  }

  const previousChoice = getQuizSelection(run, videoId);

  if (previousChoice === choice) {
    return;
  }

  run.quizChoices = {
    ...(run.quizChoices || {}),
    [videoId]: choice,
  };
  saveStorage(STORAGE_KEYS.currentRun, run);
  trackEvent("quiz_choice_updated", {
    mode: "quiz",
    runId: run.id,
    nameKey: run.nameKey,
    videoId,
    previousChoice,
    nextChoice: choice,
    decidedCount: buildQuizStatus(run).decidedCount,
  });
  updateQuizSelectionUi(run, videoId);
}

async function advanceRun() {
  const run = state.currentRun;

  if (!run || run.phase !== "feedback") {
    return;
  }

  if (run.currentIndex >= getRunVideoCount(run) - 1) {
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

  if (run.mode === "quiz") {
    await finalizeQuizRun(run);
    return;
  }

  const stats = calculateRunStats(run.answers);
  const completedAt = new Date().toISOString();

  const playerRecord = {
    id: run.id,
    mode: "friday",
    name: run.name,
    nameKey: run.nameKey,
    cycleStart: run.cycleStart || state.activeCycleStart,
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
    const payload = await uploadPlayerRecord(playerRecord);
    applyFridayPayload(payload);
    trackEvent("run_completed", {
      mode: "friday",
      runId: run.id,
      nameKey: run.nameKey,
      totalCorrect: stats.totalCorrect,
      totalQuestions: stats.totalQuestions,
      totalAccuracy: stats.totalAccuracy,
      finalCoins: playerRecord.finalCoins,
    });
    state.lastCompletedRun = playerRecord;
    state.currentRun = null;
    localStorage.removeItem(STORAGE_KEYS.currentRun);
    render();
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "";

    if (message.includes("Weekly lineup changed")) {
      state.currentRun = null;
      localStorage.removeItem(STORAGE_KEYS.currentRun);
      void syncPlayersFromServer();
      window.alert("The Friday lineup changed while this run was in progress. Start a fresh run from the new weekly slate.");
      return;
    }

    window.alert(
      "Couldn't upload this run to the shared server yet. The entry is still open on this device, so please try again in a moment.",
    );
  }
}

function submitQuizRun() {
  const run = state.currentRun;

  if (!run || run.mode !== "quiz") {
    return;
  }

  void finalizeRun();
}

async function finalizeQuizRun(run) {
  const completedAt = new Date().toISOString();
  const answers = run.videoOrder.map((videoId, index) => {
    const video = ALL_VIDEOS_BY_ID[videoId];
    const choice = getQuizSelection(run, videoId);
    const expectedChoice = getExpectedChoice(videoId);
    const timing = getCurrentQuestionTiming(run.questionStartedAt);

    return {
      videoId,
      videoLabel: video?.label || `Video ${index + 1}`,
      videoSrc: video?.src || "",
      sourceGroup: video?.sourceGroup || "",
      questionNumber: index + 1,
      sectionId: expectedChoice,
      sectionLabel: titleCase(expectedChoice),
      sectionQuestionNumber: index + 1,
      choice,
      expectedChoice,
      correct: choice === expectedChoice,
      publicLines: null,
      questionStartedAt: timing.questionStartedAt,
      answeredAt: timing.answeredAt,
      responseSeconds: timing.responseSeconds,
      videoCurrentTimeSeconds: timing.videoCurrentTimeSeconds,
      videoDurationSeconds: timing.videoDurationSeconds,
      videoHalfSeconds: timing.videoHalfSeconds,
      secondsFromHalf: timing.secondsFromHalf,
      halfComparison: timing.halfComparison,
      videoProgress: timing.videoProgress,
    };
  });

  run.answers = answers;
  run.phase = "quiz-results";

  const stats = calculateRunStats(answers, "quiz");
  const playerRecord = {
    id: run.id,
    mode: "quiz",
    name: run.name,
    nameKey: run.nameKey,
    startedAt: run.startedAt,
    completedAt,
    finalCoins: null,
    totalCorrect: stats.totalCorrect,
    totalQuestions: stats.totalQuestions,
    totalAccuracy: stats.totalAccuracy,
    sectionStats: stats.sectionStats,
    answers,
  };

  try {
    const payload = await uploadQuizPlayerRecord(playerRecord);
    applyQuizPayload(payload);
    trackEvent("run_completed", {
      mode: "quiz",
      runId: run.id,
      nameKey: run.nameKey,
      totalCorrect: stats.totalCorrect,
      totalQuestions: stats.totalQuestions,
      totalAccuracy: stats.totalAccuracy,
    });
    state.lastCompletedRun = playerRecord;
    state.currentRun = null;
    localStorage.removeItem(STORAGE_KEYS.currentRun);
    render();
  } catch (error) {
    console.error(error);
    window.alert(
      "Couldn't upload this learning quiz yet. The finished review stays on this device, so please try again in a moment.",
    );
    state.currentRun = run;
    saveStorage(STORAGE_KEYS.currentRun, run);
  }
}

function calculateRunStats(answers, mode = "friday") {
  const totalQuestions = answers.length;
  const totalCorrect = answers.filter((answer) => answer.correct).length;
  const totalAccuracy = totalQuestions ? totalCorrect / totalQuestions : 0;

  const sectionDefinitions = mode === "quiz"
    ? [
      { id: "track" },
      { id: "cascade" },
    ]
    : SECTIONS;
  const sectionStats = sectionDefinitions.reduce((stats, section) => {
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

function buildLeaderboard(players, mode = "friday") {
  return [...players].sort((left, right) => {
    if (mode === "quiz") {
      if (right.totalCorrect !== left.totalCorrect) {
        return right.totalCorrect - left.totalCorrect;
      }

      if (right.totalAccuracy !== left.totalAccuracy) {
        return right.totalAccuracy - left.totalAccuracy;
      }

      return new Date(left.completedAt).getTime() - new Date(right.completedAt).getTime();
    }

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
  return buildLeaderboard(players, "friday").map((player) => ({
    name: player.name,
    finalCoins: player.finalCoins,
    totalAccuracy: player.totalAccuracy,
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

function buildQuizSummaryRows(players) {
  return buildLeaderboard(players, "quiz").map((player) => ({
    name: player.name,
    totalCorrect: player.totalCorrect,
    totalQuestions: player.totalQuestions,
    totalAccuracy: player.totalAccuracy,
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

function buildGrowthRows(history, mode) {
  const groupedHistory = history.reduce((groups, record) => {
    const nameKey = record?.nameKey;

    if (!nameKey) {
      return groups;
    }

    groups[nameKey] = groups[nameKey] || [];
    groups[nameKey].push(record);
    return groups;
  }, {});

  return Object.values(groupedHistory)
    .map((records) => {
      const sortedRecords = [...records].sort(
        (left, right) => new Date(left.completedAt).getTime() - new Date(right.completedAt).getTime(),
      );
      const first = sortedRecords[0];
      const latest = sortedRecords[sortedRecords.length - 1];
      const best = sortedRecords.reduce((currentBest, record) => {
        if (!currentBest) {
          return record;
        }

        if ((record.totalAccuracy || 0) > (currentBest.totalAccuracy || 0)) {
          return record;
        }

        if ((record.totalAccuracy || 0) === (currentBest.totalAccuracy || 0) &&
          (record.totalCorrect || 0) > (currentBest.totalCorrect || 0)) {
          return record;
        }

        return currentBest;
      }, null);

      return {
        name: latest.name,
        attempts: sortedRecords.length,
        totalQuestions: latest.totalQuestions || first.totalQuestions || 0,
        firstAccuracy: first.totalAccuracy || 0,
        latestAccuracy: latest.totalAccuracy || 0,
        bestAccuracy: best?.totalAccuracy || 0,
        accuracyGrowth: (latest.totalAccuracy || 0) - (first.totalAccuracy || 0),
        firstCorrect: first.totalCorrect || 0,
        latestCorrect: latest.totalCorrect || 0,
        bestCorrect: best?.totalCorrect || 0,
        latestCoins: mode === "friday" ? latest.finalCoins : null,
        firstWeekLabel: formatCycleDate(first.cycleStart) || "n/a",
        latestWeekLabel: formatCycleDate(latest.cycleStart) || "n/a",
      };
    })
    .sort((left, right) => {
      if (right.latestAccuracy !== left.latestAccuracy) {
        return right.latestAccuracy - left.latestAccuracy;
      }

      if (right.attempts !== left.attempts) {
        return right.attempts - left.attempts;
      }

      return left.name.localeCompare(right.name);
    });
}

function buildFridayWeeklyTrendRows(history) {
  return [...history]
    .filter((record) => record?.cycleStart)
    .sort((left, right) => {
      const cycleComparison = `${left.cycleStart}`.localeCompare(`${right.cycleStart}`);

      if (cycleComparison !== 0) {
        return cycleComparison;
      }

      return `${left.name}`.localeCompare(`${right.name}`);
    })
    .map((record) => ({
      name: record.name,
      cycleStart: record.cycleStart,
      weekLabel: formatCycleDate(record.cycleStart),
      totalCorrect: record.totalCorrect || 0,
      totalQuestions: record.totalQuestions || 0,
      totalAccuracy: record.totalAccuracy || 0,
      finalCoins: record.finalCoins,
      completedAt: record.completedAt,
    }));
}

function buildQuizAnswerRows(players) {
  return buildLeaderboard(players, "quiz").flatMap((player) =>
    player.answers.map((answer) => ({
      name: player.name,
      videoLabel: answer.videoLabel,
      choice: answer.choice,
      expectedChoice: answer.expectedChoice || getExpectedChoice(answer.videoId),
      correct: answer.correct,
      responseSeconds: answer.responseSeconds ?? null,
      videoCurrentTimeSeconds: answer.videoCurrentTimeSeconds ?? null,
      completedAt: player.completedAt,
    })),
  );
}

function buildEventSummaryRows(summary) {
  const eventCounts = summary?.eventCounts && typeof summary.eventCounts === "object"
    ? summary.eventCounts
    : {};

  return Object.entries(eventCounts).map(([eventType, count]) => ({
    eventType,
    count,
  }));
}

function buildRecentEventRows(events) {
  return [...events]
    .slice()
    .reverse()
    .map((event) => ({
      timestamp: event.timestamp,
      mode: event.mode || "unknown",
      type: event.type || "unknown",
      nameKey: event.nameKey || null,
      runId: event.runId || null,
      videoRef: simplifyVideoRef(event.videoId || event.videoSrc || null),
      detail: buildEventDetail(event),
    }));
}

function buildGroupRows(players) {
  return buildLeaderboard(players, "friday").flatMap((player) =>
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
  return buildLeaderboard(players, "friday").flatMap((player) =>
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
  if (section.id === "market") {
    return getConfiguredRunVideoCount();
  }

  return section.endIndex - section.startIndex + 1;
}

function ensureCurrentRunVideoOrder() {
  if (!state.currentRun) {
    return;
  }

  if (isCurrentRunCompatible(state.currentRun)) {
    return;
  }

  state.currentRun = null;
  localStorage.removeItem(STORAGE_KEYS.currentRun);
}

function getVideoForRunIndex(run, index) {
  const videoId = Array.isArray(run?.videoOrder) ? run.videoOrder[index] : null;
  if (run?.mode === "quiz") {
    return ALL_VIDEOS_BY_ID[videoId] || ALL_VIDEOS[index];
  }

  return VIDEOS_BY_ID[videoId] || VIDEOS[index];
}

function getRunVideoCount(run = state.currentRun) {
  const configuredCount = run?.mode === "quiz"
    ? QUIZ_VIDEO_COUNT
    : getConfiguredRunVideoCount();

  if (Array.isArray(run?.videoOrder) && run.videoOrder.length) {
    return Math.min(run.videoOrder.length, configuredCount);
  }

  return configuredCount;
}

function getConfiguredRunVideoCount() {
  return Math.min(RUN_VIDEO_COUNT, VIDEOS.length);
}

function buildRunVideoOrder(mode = "friday") {
  if (mode === "quiz") {
    return buildQuizRunVideoOrder();
  }

  return VIDEOS.map((video) => video.id);
}

function isCurrentRunCompatible(run) {
  if (!run) {
    return false;
  }

  if (run.mode === "quiz") {
    return Array.isArray(run.videoOrder) &&
      run.videoOrder.length === QUIZ_VIDEO_COUNT &&
      run.videoOrder.every((videoId) => Boolean(ALL_VIDEOS_BY_ID[videoId]));
  }

  if (run.cycleStart !== state.activeCycleStart) {
    return false;
  }

  if (!Array.isArray(run.videoOrder) || run.videoOrder.length !== VIDEOS.length) {
    return false;
  }

  return run.videoOrder.every((videoId, index) => videoId === VIDEOS[index]?.id);
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
  const expected = getExpectedChoice(videoId);

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

function buildQuizRunVideoOrder() {
  const trackVideos = shuffleList(
    ALL_VIDEOS.filter((video) => video.correctChoice === "track"),
  ).slice(0, QUIZ_TRACK_COUNT);
  const cascadeVideos = shuffleList(
    ALL_VIDEOS.filter((video) => video.correctChoice === "cascade"),
  ).slice(0, QUIZ_CASCADE_COUNT);

  return shuffleList([...trackVideos, ...cascadeVideos]).map((video) => video.id);
}

function getQuizSelection(run, videoId) {
  return run.quizChoices?.[videoId] || "undecided";
}

function buildQuizStatus(run) {
  return run.videoOrder.reduce((summary, videoId) => {
    const selection = getQuizSelection(run, videoId);

    if (selection === "track") {
      summary.trackCount += 1;
      summary.decidedCount += 1;
    } else if (selection === "cascade") {
      summary.cascadeCount += 1;
      summary.decidedCount += 1;
    } else {
      summary.undecidedCount += 1;
    }

    return summary;
  }, {
    trackCount: 0,
    cascadeCount: 0,
    undecidedCount: 0,
    decidedCount: 0,
  });
}

function getPlayersForMode(mode) {
  return mode === "quiz" ? state.quizPlayers : state.players;
}

function getActiveMode() {
  if (state.currentRun?.mode) {
    return state.currentRun.mode;
  }

  if (state.lastCompletedRun?.mode) {
    return state.lastCompletedRun.mode;
  }

  return state.selectedMode === "quiz" ? "quiz" : "friday";
}

function selectMode(mode) {
  if (!MODE_CONFIGS[mode] || state.currentRun) {
    return;
  }

  state.selectedMode = mode;
  saveStorage(STORAGE_KEYS.selectedMode, mode);
  render();
}

function updateQuizSelectionUi(run, videoId) {
  const selection = getQuizSelection(run, videoId);
  const quizStatus = buildQuizStatus(run);

  document.querySelectorAll("[data-video-id]").forEach((button) => {
    if (button.dataset.videoId !== videoId || !button.dataset.quizChoice) {
      return;
    }

    const isSelected = button.dataset.quizChoice === selection;
    button.classList.toggle("is-selected", isSelected);
    button.setAttribute("aria-pressed", isSelected ? "true" : "false");
  });

  document.querySelectorAll("[data-quiz-status-item]").forEach((item) => {
    if (item.dataset.quizStatusItem !== videoId) {
      return;
    }

    const pill = item.querySelector("[data-quiz-status-pill]");

    if (!pill) {
      return;
    }

    pill.className = `quiz-status-pill quiz-status-pill-${selection}`;
    pill.textContent = titleCase(selection);
  });

  const countValues = {
    reviewed: `${quizStatus.decidedCount} / ${getRunVideoCount(run)}`,
    undecided: `${quizStatus.undecidedCount}`,
    track: `${quizStatus.trackCount}`,
    cascade: `${quizStatus.cascadeCount}`,
    "sidebar-undecided": `${quizStatus.undecidedCount}`,
  };

  document.querySelectorAll("[data-quiz-count]").forEach((element) => {
    const nextValue = countValues[element.dataset.quizCount];

    if (typeof nextValue === "string") {
      element.textContent = nextValue;
    }
  });
}

function initializeAnalyticsTracking() {
  trackEvent("page_opened", {
    mode: getActiveMode(),
  });

  document.addEventListener("play", (event) => {
    handleVideoAnalyticsEvent("video_play", event);
  }, true);
  document.addEventListener("pause", (event) => {
    handleVideoAnalyticsEvent("video_pause", event);
  }, true);
  document.addEventListener("ended", (event) => {
    handleVideoAnalyticsEvent("video_ended", event);
  }, true);
  document.addEventListener("seeking", (event) => {
    handleVideoAnalyticsEvent("video_seek", event);
  }, true);
  document.addEventListener("ratechange", (event) => {
    handleVideoAnalyticsEvent("video_rate_change", event);
  }, true);

  document.addEventListener("visibilitychange", () => {
    trackEvent("visibility_changed", {
      mode: getActiveMode(),
      visibilityState: document.visibilityState,
    });

    if (document.visibilityState === "hidden") {
      flushAnalyticsEvents({ useBeacon: true });
    }
  });

  window.addEventListener("beforeunload", () => {
    flushAnalyticsEvents({ useBeacon: true });
  });
}

function handleVideoAnalyticsEvent(type, event) {
  const video = event.target;

  if (!(video instanceof HTMLVideoElement)) {
    return;
  }

  const eventKey = `${type}:${video.currentSrc || video.src || video.getAttribute("src") || "unknown"}`;
  const now = Date.now();
  const lastSentAt = videoAnalyticsTimestamps.get(eventKey) || 0;
  const minimumGap = type === "video_seek" ? 1200 : 400;

  if (now - lastSentAt < minimumGap) {
    return;
  }

  videoAnalyticsTimestamps.set(eventKey, now);

  trackEvent(type, {
    mode: getActiveMode(),
    runId: state.currentRun?.id || null,
    nameKey: state.currentRun?.nameKey || state.lastCompletedRun?.nameKey || null,
    videoSrc: video.currentSrc || video.src || video.getAttribute("src") || null,
    currentTimeSeconds: getFiniteNumber(video.currentTime),
    durationSeconds: getFiniteNumber(video.duration),
    playbackRate: getFiniteNumber(video.playbackRate),
    paused: video.paused,
  });
}

function trackEvent(type, details = {}) {
  const eventRecord = {
    id: createSessionId(),
    sessionId: state.analyticsSessionId,
    type,
    timestamp: new Date().toISOString(),
    mode: details.mode || getActiveMode(),
    nameKey: details.nameKey || state.currentRun?.nameKey || state.lastCompletedRun?.nameKey || null,
    ...details,
  };

  analyticsQueue.push(eventRecord);
  scheduleAnalyticsFlush();
}

function scheduleAnalyticsFlush() {
  if (analyticsFlushTimerId) {
    return;
  }

  analyticsFlushTimerId = window.setTimeout(() => {
    analyticsFlushTimerId = null;
    void flushAnalyticsEvents();
  }, ANALYTICS_FLUSH_INTERVAL_MS);
}

async function flushAnalyticsEvents({ useBeacon = false } = {}) {
  if (!analyticsQueue.length) {
    return;
  }

  const events = analyticsQueue.splice(0, analyticsQueue.length);
  const payload = JSON.stringify({ events });

  if (useBeacon && navigator.sendBeacon) {
    const sent = navigator.sendBeacon(
      API_ANALYTICS_EVENTS_URL,
      new Blob([payload], { type: "application/json" }),
    );

    if (!sent) {
      analyticsQueue.unshift(...events);
    }

    return;
  }

  try {
    const response = await fetch(API_ANALYTICS_EVENTS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: payload,
      keepalive: true,
    });

    if (!response.ok) {
      throw new Error(`Failed to persist analytics events: ${response.status}`);
    }

    const analyticsPayload = await response.json();
    applyAnalyticsPayload(analyticsPayload);
    state.analyticsLoaded = true;
    state.analyticsError = null;
  } catch (error) {
    console.error(error);
    analyticsQueue.unshift(...events);
  }
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
  if (getExpectedChoice(videoId) === "track") {
    return seededCounts.trackCount;
  }

  if (getExpectedChoice(videoId) === "cascade") {
    return seededCounts.cascadeCount;
  }

  return 0;
}

function getExpectedChoice(videoId) {
  return ALL_VIDEOS_BY_ID[videoId]?.correctChoice || VIDEOS_BY_ID[videoId]?.correctChoice || null;
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

  const playerCount = getPlayersForMode(getActiveMode()).length;
  button.disabled = false;
  button.textContent = playerCount
    ? `Analysis & Export (${playerCount})`
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
    "user-growth": {
      fileName: "neutrino-user-growth.csv",
      rows: buildGrowthRows(state.playerHistory, "friday").map((row) => ({
        player: row.name,
        attempts: row.attempts,
        first_week: row.firstWeekLabel,
        latest_week: row.latestWeekLabel,
        first_accuracy: decimalPercent(row.firstAccuracy),
        latest_accuracy: decimalPercent(row.latestAccuracy),
        best_accuracy: decimalPercent(row.bestAccuracy),
        accuracy_growth: decimalPercent(row.accuracyGrowth),
        first_correct: row.firstCorrect,
        latest_correct: row.latestCorrect,
        best_correct: row.bestCorrect,
        latest_coins: row.latestCoins,
      })),
    },
    "weekly-growth": {
      fileName: "neutrino-weekly-growth.csv",
      rows: buildFridayWeeklyTrendRows(state.playerHistory).map((row) => ({
        player: row.name,
        cycle_start: row.cycleStart,
        week: row.weekLabel,
        total_correct: row.totalCorrect,
        total_questions: row.totalQuestions,
        total_accuracy: decimalPercent(row.totalAccuracy),
        final_coins: row.finalCoins,
        completed_at: row.completedAt,
      })),
    },
    "quiz-user-summary": {
      fileName: "neutrino-quiz-user-summary.csv",
      rows: buildQuizSummaryRows(state.quizPlayers).map((row) => ({
        player: row.name,
        total_correct: row.totalCorrect,
        total_questions: row.totalQuestions,
        total_accuracy: decimalPercent(row.totalAccuracy),
        average_response_seconds: row.averageResponseSeconds,
        average_clip_time_at_pick_seconds: row.averageClipTimeAtChoiceSeconds,
        after_half_rate: decimalPercent(row.afterHalfRate),
        completed_at: row.completedAt,
      })),
    },
    "quiz-answer-detail": {
      fileName: "neutrino-quiz-answer-detail.csv",
      rows: buildQuizAnswerRows(state.quizPlayers).map((row) => ({
        player: row.name,
        video: row.videoLabel,
        choice: row.choice,
        correct_answer: row.expectedChoice,
        correct: row.correct,
        response_seconds: row.responseSeconds,
        clip_time_at_pick_seconds: row.videoCurrentTimeSeconds,
        completed_at: row.completedAt,
      })),
    },
    "quiz-growth": {
      fileName: "neutrino-quiz-growth.csv",
      rows: buildGrowthRows(state.quizHistory, "quiz").map((row) => ({
        player: row.name,
        attempts: row.attempts,
        total_questions: row.totalQuestions,
        first_correct: row.firstCorrect,
        latest_correct: row.latestCorrect,
        best_correct: row.bestCorrect,
        first_accuracy: decimalPercent(row.firstAccuracy),
        latest_accuracy: decimalPercent(row.latestAccuracy),
        best_accuracy: decimalPercent(row.bestAccuracy),
        accuracy_growth: decimalPercent(row.accuracyGrowth),
      })),
    },
    "event-summary": {
      fileName: "neutrino-event-summary.csv",
      rows: buildEventSummaryRows(state.analyticsSummary).map((row) => ({
        event_type: row.eventType,
        count: row.count,
      })),
    },
    "recent-events": {
      fileName: "neutrino-recent-events.csv",
      rows: buildRecentEventRows(state.recentAnalyticsEvents).map((row) => ({
        timestamp: row.timestamp,
        mode: row.mode,
        event_type: row.type,
        player: row.nameKey,
        run_id: row.runId,
        video: row.videoRef,
        detail: row.detail,
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

function formatSignedPercent(value) {
  const numericValue = typeof value === "number" ? value : 0;
  const percent = Math.round(numericValue * 100);
  return `${percent > 0 ? "+" : ""}${percent}%`;
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

function formatCycleDate(isoDate) {
  if (!isoDate) {
    return "";
  }

  return new Date(`${isoDate}T12:00:00`).toLocaleDateString([], {
    dateStyle: "medium",
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

function simplifyVideoRef(value) {
  if (!value) {
    return null;
  }

  const stringValue = `${value}`;
  const normalizedValue = stringValue.split("/").slice(-2).join("/");

  try {
    return decodeURIComponent(normalizedValue);
  } catch (error) {
    return normalizedValue;
  }
}

function buildEventDetail(event) {
  const detailParts = [];

  if (event.nextChoice) {
    detailParts.push(`${event.previousChoice || "none"} -> ${event.nextChoice}`);
  } else if (event.choice) {
    detailParts.push(`choice ${event.choice}`);
  }

  if (typeof event.currentTimeSeconds === "number") {
    detailParts.push(`at ${event.currentTimeSeconds.toFixed(2)}s`);
  }

  if (typeof event.responseSeconds === "number") {
    detailParts.push(`responded in ${event.responseSeconds.toFixed(2)}s`);
  }

  if (typeof event.totalCorrect === "number" && typeof event.totalQuestions === "number") {
    detailParts.push(`score ${event.totalCorrect}/${event.totalQuestions}`);
  }

  if (typeof event.finalCoins === "number") {
    detailParts.push(`coins ${event.finalCoins}`);
  }

  if (event.visibilityState) {
    detailParts.push(`visibility ${event.visibilityState}`);
  }

  return detailParts.join(" • ") || "n/a";
}

function escapeHtml(value) {
  return `${value ?? ""}`
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeStoredRun(run) {
  if (!run || typeof run !== "object") {
    return null;
  }

  return {
    ...run,
    mode: run.mode === "quiz" ? "quiz" : "friday",
  };
}

function createSessionId() {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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

function shuffleList(list) {
  const nextList = [...list];

  for (let index = nextList.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [nextList[index], nextList[swapIndex]] = [nextList[swapIndex], nextList[index]];
  }

  return nextList;
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
