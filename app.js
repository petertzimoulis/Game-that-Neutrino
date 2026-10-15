// Bump for an intentional site-wide reset so old saves and upload queues stay retired.
const GAME_STATE_EPOCH = "reset-20261015-1";
const STORAGE_KEYS = {
  currentRun: "game-that-neutrino-current-run",
  lastName: "game-that-neutrino-last-name",
  selectedMode: "game-that-neutrino-selected-mode",
  demoPlayers: "game-that-neutrino-demo-players",
  pendingCollaboratorRuns: "game-that-neutrino-collaborator-pending",
  collaboratorMigration: "game-that-neutrino-collaborator-migrated-v1",
  trophies: "game-that-neutrino-trophies-v1",
  lastCompletedRun: "game-that-neutrino-last-completed",
  completedRuns: "game-that-neutrino-recent-runs",
  accountRevision: "game-that-neutrino-save-revision",
  accountDirty: "game-that-neutrino-save-dirty",
  savedEndlessRun: "game-that-neutrino-endless-run",
  endlessOutbox: "game-that-neutrino-endless-outbox",
  endlessProfiles: "game-that-neutrino-endless-profiles",
};
for (const key of Object.keys(STORAGE_KEYS)) STORAGE_KEYS[key] += `-${GAME_STATE_EPOCH}`;
const GUEST_STORAGE_KEYS = {...STORAGE_KEYS};
const ACCOUNT_OWNER_KEY = `game-that-neutrino-storage-owner-${GAME_STATE_EPOCH}`;
let progressStorageOwner = loadStorage(ACCOUNT_OWNER_KEY, null);
configureProgressStorage(progressStorageOwner);

function configureProgressStorage(owner) {
  progressStorageOwner = typeof owner === "string" && /^[A-Za-z0-9_-]{3,32}$/.test(owner) ? owner : null;
  for (const key of Object.keys(STORAGE_KEYS)) {
    STORAGE_KEYS[key] = GUEST_STORAGE_KEYS[key] + (progressStorageOwner ? `-account-${progressStorageOwner.toLowerCase()}` : "");
  }
  localStorage.setItem(ACCOUNT_OWNER_KEY, JSON.stringify(progressStorageOwner));
}

function getRequestedMode() {
  const requestedMode = new URLSearchParams(window.location.search).get("mode");

  return ["demo", "friday", "quiz", "quick", "endless"].includes(requestedMode)
    ? requestedMode
    : null;
}

function getInitialSelectedMode() {
  const requestedMode = getRequestedMode();

  if (requestedMode) {
    return requestedMode;
  }

  return "demo";
}

function getInitialRun() {
  const storedRun = normalizeStoredRun(loadStorage(STORAGE_KEYS.currentRun, null));
  const requestedMode = getRequestedMode();

  // A direct mode link should always open that mode. Keep another mode's saved
  // in-progress run in storage so it can be resumed by returning to its mode.
  if (storedRun?.mode !== (requestedMode || getInitialSelectedMode())) {
    return null;
  }

  return storedRun;
}

const API_PLAYERS_URL = "/api/players";
const API_COLLABORATOR_PLAYERS_URL = "/api/collaborator-players";
const API_QUIZ_PLAYERS_URL = "/api/quiz-players";
const API_QUICK_QUIZ_PLAYERS_URL = "/api/quick-quiz-players";
const API_ANALYTICS_URL = "/api/analytics";
const API_ANALYTICS_EVENTS_URL = "/api/analytics-events";
const COIN_ICON_SRC = "coin.png";
const VIDEO_PLAYBACK_RATE = 2;
const PLAYER_SYNC_INTERVAL_MS = 90000;
const ANALYTICS_FLUSH_INTERVAL_MS = 30000;
const RUN_VIDEO_COUNT = 15;
const DEMO_VIDEO_COUNT = 5;
const ACHIEVEMENTS = [
  {id: "first-call", title: "First light", description: "Make your first correct call."},
  {id: "hot-hand", title: "Hot hand", description: "Get three correct calls in a row."},
  {id: "independent", title: "Against the crowd", description: "Earn a crowd bonus with a correct minority call."},
  {id: "keen-eye", title: "Eye for both", description: "Correctly identify a Track and a Cascade in one run."},
  {id: "demo-complete", title: "Collaborator", description: "Finish the five-question collaborator demo, whatever your score."},
  {id: "perfect-demo", title: "Perfect five", description: "Finish a five-question collaborator game with every answer correct."},
  {id: "finisher", title: "Mission complete", description: "Finish a run in any mode."},
  {id: "explorer", title: "Ice explorer", description: "Finish a collaborator game covering all four video sets."},
  {id: "endless-10", title: "Getting into orbit", description: "Answer 10 questions in Endless Mode across your visits."},
  {id: "endless-50", title: "Deep in the ice", description: "Answer 50 questions in Endless Mode across your visits."},
  {id: "endless-100", title: "Full rotation", description: "Answer 100 questions in Endless Mode across your visits."},
  {id: "endless-250", title: "Beyond the horizon", description: "Answer 250 questions in Endless Mode across your visits."},
  {id: "endless-streak-10", title: "Unbroken signal", description: "Make 10 correct calls in a row in Endless Mode."},
  {id: "endless-correct-100", title: "Willem Trophy", description: "Make 100 correct calls in Endless Mode across your visits."},
];
const CROWD_BONUS_COINS = 2;
const DEMO_SECTION = {
  id: "market", label: "Collaborator Game", title: "Trust your eye. Make the call.",
  startIndex: 0, endIndex: DEMO_VIDEO_COUNT - 1, coinMode: true, publicLines: true,
  description: "Watch the light pattern, then choose Track or Cascade. Public votes show the crowd’s opinion; your own observation makes the call.",
};
const QUIZ_VIDEO_COUNT = 10;
const QUIZ_TRACK_COUNT = 5;
const QUIZ_CASCADE_COUNT = 5;
const QUICK_QUIZ_VIDEO_COUNT = 21;
const QUICK_QUIZ_GROUP_SIZE = 7;
const QUICK_QUIZ_MIN_SUCCESS_RATE = 0.55;
const QUICK_QUIZ_FIFTY_PERCENT_EVENT_IDS = new Set(["3101", "19202"]);
const QUICK_QUIZ_GROUPS = [
  { id: "pid-good", label: "PID did well", description: "PID made a confident, correct classification." },
  { id: "pid-uncertain", label: "PID was uncertain", description: "PID was closest to the decision boundary." },
  { id: "pid-bad", label: "PID did poorly", description: "PID made a confident, incorrect classification." },
];

const MANIFEST_SOURCES = [
  {
    folderName: "ntn_4.0_100_videos (1)",
    manifestFile: "manifest.csv",
    sectionId: "market",
  },
  {
    folderName: "Low Energy Quiz",
    manifestFile: "LowEnergyQuizManifest.csv",
    sectionId: "low-energy",
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

const QUICK_QUIZ_BASELINE_RESULTS = {
  "3012": { correct: 6, total: 8 },
  "5177": { correct: 3, total: 8 },
  "3622": { correct: 1, total: 8 },
  "3101": { correct: 4, total: 8 },
  "3250": { correct: 2, total: 8 },
  "3076": { correct: 8, total: 8 },
  "3020": { correct: 3, total: 8 },
  "3228": { correct: 5, total: 8 },
  "19202": { correct: 4, total: 8 },
  "37327": { correct: 2, total: 8 },
  "3785": { correct: 4, total: 8 },
  "14600": { correct: 6, total: 8 },
  "3910": { correct: 4, total: 8 },
  "4905": { correct: 6, total: 8 },
  "5318": { correct: 6, total: 8 },
  "3281": { correct: 1, total: 8 },
  "3342": { correct: 6, total: 8 },
  "3448": { correct: 2, total: 8 },
  "20540": { correct: 1, total: 8 },
  "15108": { correct: 6, total: 8 },
  "3628": { correct: 3, total: 8 },
};
const SEEDED_PUBLIC_LINE_COUNTS = {};
const MODE_CONFIGS = {
  endless: {id:"endless",title:"Endless Mode",leaderboardTitle:"Endless leaderboard",startButtonLabel:"Continue Endless Mode"},
  demo: { id: "demo", title: "Collaborator Game", leaderboardTitle: "Global collaborator leaderboard", startButtonLabel: "Start collaborator game" },
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
  quick: {
    id: "quick",
    title: "4.0 Quick Quiz",
    leaderboardTitle: "4.0 Quick Quiz Leaderboard",
    startButtonLabel: "Start 4.0 quick quiz",
  },
};

let ALL_VIDEOS = [];
let ALL_VIDEOS_BY_ID = {};
let SECTIONS = [];
let VIDEOS = [];
let VIDEOS_BY_ID = {};

const state = {
  showIntro: true,
  showAchievements: false,
  trophyProfiles: [],
  localTrophies: loadStorage(STORAGE_KEYS.trophies, {}),
  trophiesLoaded: false,
  trophiesError: false,
  trophyNotice: [],
  demoPlayers: [],
  demoHistory: [],
  collaboratorLeaderboardLoaded: false,
  collaboratorLeaderboardError: null,
  collaboratorDataVersion: null,
  pendingCollaboratorRuns: loadPendingCollaboratorRuns(),
  players: [],
  playerHistory: [],
  quizPlayers: [],
  quizHistory: [],
  quickQuizPlayers: [],
  quickQuizHistory: [],
  endlessPlayers: [],
  endlessHistory: [],
  endlessCrowdStats: {},
  endlessLoaded: false,
  endlessError: null,
  savedEndlessRun: loadStorage(STORAGE_KEYS.savedEndlessRun, null),
  endlessProfiles: loadStorage(STORAGE_KEYS.endlessProfiles, {}),
  pendingEndlessRuns: loadStorage(STORAGE_KEYS.endlessOutbox, []),
  currentRun: getInitialRun(),
  lastName: loadStorage(STORAGE_KEYS.lastName, ""),
  selectedMode: getInitialSelectedMode(),
  lastCompletedRun: loadStorage(STORAGE_KEYS.lastCompletedRun, null)?.mode === getInitialSelectedMode() ? loadStorage(STORAGE_KEYS.lastCompletedRun, null) : null,
  showHelp: false,
  showAnalysis: false,
  catalogLoaded: false,
  catalogError: null,
  scheduleLoaded: false,
  scheduleError: null,
  fridayDataVersion: null,
  quizLeaderboardLoaded: false,
  quizLeaderboardError: null,
  quizDataVersion: null,
  quickQuizLoaded: false,
  quickQuizError: null,
  quickQuizDataVersion: null,
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
const sharedRequests = new Map();
const sharedRetryAfter = new Map();
const lastModeSync = new Map();
const recentlyAcceptedPlayers = new Map();
let analyticsFlushing = false;

render();
void initializeVideoCatalog();
initializeSharedPlayers();
initializeAnalyticsTracking();
if (Object.values(state.localTrophies).some(profile => !profile.synced)) void syncAchievements();

document.addEventListener("click", (event) => {
  if (event.target.classList.contains("modal-backdrop")) {
    if (state.showAchievements) { closeAchievements(); return; }
    state.showHelp = false;
    state.showAnalysis = false;
    render();
    return;
  }

  const choiceButton = event.target.closest("[data-choice]");

  if (choiceButton) {
    if (state.currentRun?.mode === "quick") {
      answerQuizQuestion(choiceButton.dataset.choice);
    } else {
      handleChoice(choiceButton.dataset.choice);
    }
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

  const quizAnswerButton = event.target.closest("[data-quiz-answer]");

  if (quizAnswerButton) {
    answerQuizQuestion(quizAnswerButton.dataset.quizAnswer);
    return;
  }

  const actionButton = event.target.closest("[data-action]");

  if (!actionButton) {
    return;
  }

  const { action } = actionButton.dataset;

  switch (action) {
    case "open-achievements":
      state.showAchievements = true;
      state.achievementReturnFocus = actionButton;
      renderAchievementOverlays();
      document.querySelector("#achievement-dialog")?.focus();
      void syncAchievements();
      break;
    case "close-achievements":
      closeAchievements();
      break;
    case "dismiss-trophies":
      state.trophyNotice = [];
      renderAchievementOverlays();
      break;
    case "open-intro":
      state.showIntro = true;
      render();
      break;
    case "close-intro":
      state.showIntro = false;
      render();
      (document.querySelector("#player-name") || document.querySelector("#home-button"))?.focus();
      break;
    case "go-home":
      trackEvent("go_home", {
        mode: getActiveMode(),
      });
      goHome();
      break;
    case "select-mode":
      event.preventDefault();
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
      state.analysisMode = getActiveMode();
      state.showAnalysis = true;
      render();
      void syncAllDataFromServer({force: true});
      break;
    case "select-analysis-mode":
      if (!["demo", "friday", "quiz", "quick", "endless"].includes(actionButton.dataset.mode)) break;
      state.analysisMode = actionButton.dataset.mode;
      render();
      void syncAllDataFromServer({force: true});
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
  if (state.showIntro) {
    if (event.key === "Escape") {
      state.showIntro = false;
      render();
      (document.querySelector("#player-name") || document.querySelector("#home-button"))?.focus();
    } else if (event.key === "Tab") {
      const buttons = [...document.querySelectorAll("#intro-modal-root button, #intro-modal-root a")];
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    return;
  }
  if (state.showAchievements) {
    if (event.key === "Escape") closeAchievements();
    if (event.key === "Tab") {
      const items = [...document.querySelectorAll("#achievement-dialog button, #achievement-dialog a")];
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement.id === "achievement-dialog")) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    return;
  }
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
  const pidValue = Number.parseFloat(`${row["#PID"] || row.PID || ""}`.trim());
  const pidGroup = `${row["#PIDGroup"] || row.PIDGroup || ""}`.trim().toLowerCase();

  return {
    id: `${source.folderName}/${fileName}`,
    label: eventId ? `Event ${eventId}` : `${source.folderName} Clip ${index + 1}`,
    src: buildVideoUrl(source.folderName, fileName),
    sourceGroup: `${row.VideoSet || source.folderName}`.trim(),
    sectionId: source.sectionId,
    manifestIndex: index + 1,
    interactionType,
    correctChoice,
    pid: Number.isFinite(pidValue) ? pidValue : null,
    pidGroup: ["good", "uncertain", "bad"].includes(pidGroup) ? pidGroup : null,
  };
}

function buildVideoUrl(folderName, fileName) {
  const base = window.NEUTRINO_CONFIG?.videoBaseUrl;
  const asset = buildAssetUrl("videos", folderName, fileName);
  // The same video paths work on the origin or a separately configured media CDN.
  return typeof base === "string" && /^https:\/\//.test(base)
    ? `${base.replace(/\/$/, "")}/${asset.replace(/^\.\//, "").replace(/^\//, "")}`
    : asset;
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
  return segments.flatMap((segment) => segment.split("/")).map(encodeURIComponent).join("/");
}

function render() {
  if (typeof captureAccountProgress === "function") captureAccountProgress();
  const viewKey = state.currentRun ? `${state.currentRun.id}:${state.currentRun.phase}:${state.currentRun.currentIndex}` : state.lastCompletedRun?.id || "home";
  if (viewKey !== state.lastRenderedViewKey) { window.scrollTo?.({top: 0, behavior: "instant"}); state.lastRenderedViewKey = viewKey; }
  renderIntro();
  renderAchievementOverlays();
  if (typeof renderAccountControls === "function") renderAccountControls();
  document.body.classList.toggle("is-playing", Boolean(state.currentRun && ["question", "quick-question", "feedback", "quick-feedback"].includes(state.currentRun.phase)));
  const activeMode = getActiveMode();
  const activeModeError = ["demo", "endless"].includes(activeMode) ? null : activeMode === "quiz"
    ? state.quizLeaderboardError
    : activeMode === "quick"
      ? state.quickQuizError
      : state.scheduleError;
  const activeModeLoaded = ["demo", "endless"].includes(activeMode) ? true : activeMode === "quiz"
    ? state.quizLeaderboardLoaded
    : activeMode === "quick"
      ? state.quickQuizLoaded
      : state.scheduleLoaded;

  if (!state.catalogLoaded || !activeModeLoaded) {
    appRoot.innerHTML = renderCatalogStateView({
      title: activeMode === "endless" ? "Preparing Endless Mode" : activeMode === "demo" ? "Preparing collaborator game" : activeMode === "quick" ? "Loading 4.0 quick quiz" : activeMode === "quiz" ? "Loading learning quiz" : "Loading Friday lineup",
      description:
        activeMode === "quick"
          ? "Preparing the selected 4.0 quiz videos and its separate statistics category."
          : activeMode === "quiz"
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
    <section class="panel appear quick-quiz-feedback-panel">
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

  const modeSpecificContent = activeMode === "endless"
    ? renderEndlessLandingContent()
    : activeMode === "demo"
    ? renderDemoLandingContent()
    : activeMode === "quiz"
    ? renderLearningQuizLandingContent({ leaderboard, hasLeaderboard })
    : activeMode === "quick"
      ? renderQuickQuizLandingContent({ leaderboard, hasLeaderboard })
      : renderFridayLandingContent({
      leaderboard,
      hasLeaderboard,
      marketClipCount,
      cycleStartLabel,
      cycleEndLabel,
    });

  return `
    <section class="welcome-layout appear ${activeMode === "quick" ? "quick-quiz-landing" : ""}">
      <article class="panel hero-card">
        <div class="panel-inner">
          <div class="mode-switcher">
            ${renderModeToggleButton("demo", "Collaborator Game", "All sets • full game experience")}
            ${renderModeToggleButton("endless", "Endless Mode", "Keep going • save & resume")}
            ${renderModeToggleButton("friday", "Friday Lineup", "Shared weekly run")}
            ${renderModeToggleButton("quiz", "Learning Quiz", "10 videos at once")}
            ${renderModeToggleButton("quick", "4.0 Quick Quiz", "Selected videos, one at a time")}
          </div>
          ${modeSpecificContent.hero}
        </div>
      </article>

      <aside class="panel">
        <div class="panel-inner">
          <div class="table-caption">
            <div>
              <p class="eyebrow">${activeMode === "demo" ? "Global standings" : activeMode === "quick" ? "4.0 Standings" : activeMode === "quiz" ? "Learning Board" : "Live Board"}</p>
              <h2 class="card-title">${MODE_CONFIGS[activeMode].leaderboardTitle}</h2>
            </div>
            <span class="pill-note">${activeMode === "demo" && !state.collaboratorLeaderboardLoaded ? (state.collaboratorLeaderboardError ? "Unavailable" : "Loading") : hasLeaderboard
              ? `${leaderboard.length} ${activeMode === "endless" ? "" : "completed "}player${leaderboard.length === 1 ? "" : "s"}`
              : activeMode === "endless" ? "Waiting on first call" : "Waiting on first finish"}</span>
          </div>

          ${activeMode === "demo" ? renderCollaboratorSyncStatus() : activeMode === "endless" ? renderEndlessSyncStatus() : ""}
          ${
            hasLeaderboard
              ? (activeMode === "endless" ? renderEndlessLeaderboard(leaderboard) : renderLeaderboardTable(leaderboard, null, activeMode))
              : `
                <div class="empty-state">
                  <p class="empty-state-copy">
                    ${activeMode === "endless" ? "Make your first call to join the Endless leaderboard. Your lifetime progress carries over every time you return." : activeMode === "demo"
                      ? "Finish a collaborator game to add your name, coin score, and accuracy to the global leaderboard."
                      : activeMode === "quick"
                      ? "Completed 4.0 quizzes will land here with their coin total, correct answers, accuracy, and completion time. This board stays separate from Friday and Learning Quiz results."
                      : activeMode === "quiz"
                        ? "Completed learning quizzes will land here with total correct, accuracy, and completion time."
                      : "Completed runs will land here with the player name, coin score, and accuracy."}
                    ${activeMode === "demo" ? "Everyone sees the same collaborator standings across devices." : activeMode === "endless" ? "Endless scores stay separate from all other game modes." : "Analysis &amp; Export uses the same stored data for CSV downloads."}
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
    <a
      class="mode-toggle ${isActive ? "is-active" : ""}"
      href="?mode=${mode}"
      data-action="select-mode"
      data-mode="${mode}"
    >
      <strong>${label}</strong>
      <span>${caption}</span>
    </a>
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

function renderLearningQuizLandingContent({ leaderboard, hasLeaderboard }) {
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
        <div class="feature-chip"><strong>10 Videos</strong><span>Every quiz shows all 10 clips on one screen so it works like a study board instead of a step-by-step game.</span></div>
        <div class="feature-chip"><strong>Balanced Draw</strong><span>Each run pulls 5 Track and 5 Cascade examples from the full catalog with no repeating clips.</span></div>
        <div class="feature-chip"><strong>Separate Board</strong><span>Learning-mode accuracy saves to its own leaderboard and never mixes with the Friday coin mode.</span></div>
      </div>
      ${renderStartForm({
        buttonLabel: "Start learning quiz of 10 videos",
        helperCopy: "This mode is designed as a learning tool, so you can rewatch every video before submitting and only see the answer key at the end.",
      })}
    `,
    aside: `
      <div class="mini-card-grid">
        <div class="mini-card"><span>Score</span><strong>Accuracy-first</strong><p>The quiz leaderboard ranks by total correct and accuracy instead of the Friday coin wallet.</p></div>
        <div class="mini-card"><span>Review</span><strong>Answer key at end</strong><p>Submit once, then inspect each clip with your choice, the correct label, and full video review on the results screen.</p></div>
      </div>
    `,
  };
}

function renderQuickQuizLandingContent({ leaderboard, hasLeaderboard }) {
  const activeVideoCount = getQuickQuizVideoCount();

  return {
    hero: `
      <p class="eyebrow">4.0 • Low-energy set • selected videos</p>
      <h2 class="hero-title">Make a call, build your coin bank.</h2>
      <p class="hero-copy">
        Watch a video, select <strong>Track</strong> or <strong>Cascade</strong>, and continue to the next one.
        Each answer is saved with your name for the separate 4.0 leaderboard and exports.
      </p>

      <div class="feature-strip">
        <div class="feature-chip">
          <strong>${activeVideoCount} Videos</strong>
          <span>Every run uses eight high-performing clips plus two balanced 50% clips.</span>
        </div>
        <div class="feature-chip">
          <strong>Coin play</strong>
          <span>Start with 10 coins. Correct calls earn coins; wrong calls lose them.</span>
        </div>
        <div class="feature-chip">
          <strong>Double or Nothing</strong>
          <span>Choose the wager before a call to double that video’s risk and reward.</span>
        </div>
      </div>

      ${renderStartForm({
        buttonLabel: `Start 4.0 quiz of ${activeVideoCount} videos`,
        helperCopy: "Answer each clip once. Your answer key, coin total, and leaderboard result appear after the final video.",
      })}
    `,
    aside: `
      <div class="mini-card-grid">
        <div class="mini-card">
          <span>Separate board</span>
          <strong>4.0 coin standings</strong>
          <p>4.0 ranks its own players by coin total and never mixes with Friday or Learning Quiz results.</p>
        </div>
        <div class="mini-card">
          <span>Live pick lines</span>
          <strong>Community calls</strong>
          <p>Each choice card shows how earlier 4.0 players called that same video.</p>
        </div>
      </div>
    `,
  };
}

function renderStartForm({ buttonLabel, helperCopy }) {
  const nameLabel = "Enter your name";

  return `
    <div class="form-shell">
      <form class="name-form" id="start-form">
        <label for="player-name" class="subtle-copy">${nameLabel}</label>
        <input
          class="text-input"
          id="player-name"
          name="player-name"
          type="text"
          maxlength="40"
          autocomplete="name"
          placeholder="Your name"
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
  if (run.mode === "endless") return renderEndlessRunView(run);
  if (run.mode === "quiz") {
    return run.phase === "quiz-results"
      ? renderLearningQuizResultsView(run)
      : renderQuizBoardView(run);
  }

  if (run.mode === "quick") {
    return run.phase === "quick-results"
      ? renderQuickQuizResultsView(run)
      : run.phase === "quick-feedback"
        ? renderQuickQuizFeedbackView(run)
        : renderQuickQuizQuestionView(run);
  }

  return run.phase === "feedback" ? renderFeedbackView(run) : renderQuestionView(run);
}

function renderQuickQuizQuestionView(run) {
  const video = getVideoForRunIndex(run, run.currentIndex);
  const completedCount = run.answers.length;
  const questionNumber = run.currentIndex + 1;
  const currentCoins = getVisibleCoins(run, { coinMode: true });
  const lines = getPublicLines(video.id, state.quickQuizPlayers);

  if (!video) {
    return renderCatalogStateView({
      title: "Quiz video unavailable",
      description: "This quiz could not find its current video. Return home and start a new 4.0 quiz.",
    });
  }

  return `
    <section class="panel appear game-panel quick-quiz-panel">
      <div class="panel-inner game-panel-inner">
        <div class="game-header game-header-compact">
          <div class="game-heading-block">
            <p class="eyebrow">4.0 Quick Quiz</p>
            <h2 class="hero-title">Video ${questionNumber} of ${getRunVideoCount(run)}</h2>
          </div>

          <div class="status-strip status-strip-compact">
            <div class="stat-card">
              <span>Answers saved</span>
              <strong>${completedCount} of ${getRunVideoCount(run)}</strong>
            </div>
            <div class="wallet-card">
              <span>Coin Bank</span>
              <strong><span class="wallet-display"><img class="coin-icon" src="${COIN_ICON_SRC}" alt="" aria-hidden="true" />${currentCoins}</span></strong>
            </div>
          </div>
        </div>

        <div class="play-stage quick-quiz-stage">
          <div class="video-shell game-video-shell">
            <video controls autoplay loop muted playsinline preload="metadata" data-autoplay="true" src="${video.src}"></video>

          </div>

          <div class="decision-card quick-quiz-decision">

            ${renderMobileVoteContext(lines)}
            <div class="round-note">
              <strong>What type of event is this?</strong>
            </div>
            <label class="wager-toggle" for="double-down-toggle">
              <input id="double-down-toggle" type="checkbox" data-double-down />
              <span class="wager-copy">
                <strong>Double or Nothing</strong>
                <span>Wrong: -2 coins. Correct: +2 coins. A hot-hand correct earns +3.</span>
              </span>
            </label>
            <div class="choice-grid quick-quiz-choice-grid">
              ${renderChoiceButton({ choice: "track", label: "Track", description: "Choose the elongated neutrino event class.", variant: "track", percentage: lines.trackPercentage, totalResponses: lines.totalResponses })}
              ${renderChoiceButton({ choice: "cascade", label: "Cascade", description: "Choose the compact shower-like neutrino event class.", variant: "cascade", percentage: lines.cascadePercentage, totalResponses: lines.totalResponses })}
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderQuickQuizFeedbackView(run) {
  const answer = run.answers[run.answers.length - 1];
  const isFinalQuestion = answer.questionNumber === getRunVideoCount(run);
  const coinDelta = answer.coinsAfter - answer.coinsBefore;
  const hotStreakStarted = answer.correct && answer.streakAfter === 2;

  return `
    <section class="panel appear quick-quiz-feedback-panel">
      <div class="panel-inner feedback-layout">
        <div>
          <p class="eyebrow">4.0 • Video ${answer.questionNumber} of ${getRunVideoCount(run)}</p>
          <h2 class="hero-title">Correct answer: ${titleCase(answer.expectedChoice)}</h2>
          <div class="feedback-pill ${answer.correct ? "" : "loss"}">
            <strong>${answer.correct ? "Correct" : "Not quite"}</strong>
            <span>You chose ${titleCase(answer.choice)}.</span>
          </div>
        </div>

        ${
          hotStreakStarted
            ? `
              <div class="hot-streak-celebration" role="status" aria-live="polite">
                <span class="hot-streak-sparks" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
                <div>
                  <p class="eyebrow">Hot Streak</p>
                  <strong>Two correct calls in a row.</strong>
                  <span>Your next correct call can earn the hot-hand bonus.</span>
                </div>
              </div>
            `
            : ""
        }

        ${renderCrowdBonusFeedback(answer)}
        <div class="feedback-grid">
          <div class="feedback-card"><span>Coin movement</span><strong>${coinDelta > 0 ? "+" : ""}${coinDelta} coins</strong><p>Your bank is now ${answer.coinsAfter} coins.</p></div>
          <div class="feedback-card"><span>Wager</span><strong>${answer.doubleDown ? "Double or Nothing" : "Standard"}</strong><p>${answer.streakBonusApplied ? "Hot-hand bonus applied." : "One video at a time."}</p></div>
        </div>

        <div class="line-grid">
          ${renderLineCard("Track line before your pick", answer.publicLines.trackPercentage, "line-fill-track", answer.publicLines.totalResponses)}
          ${renderLineCard("Cascade line before your pick", answer.publicLines.cascadePercentage, "line-fill-cascade", answer.publicLines.totalResponses)}
        </div>

        <div class="button-row">
          <button type="button" class="primary-button" data-action="continue">
            ${isFinalQuestion ? "Finish quiz" : `Continue to video ${answer.questionNumber + 1}`}
          </button>
        </div>
      </div>
    </section>
  `;
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
        <video controls loop muted playsinline preload="metadata" src="${video.src}"></video>

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

function renderLearningQuizResultsView(run) {
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
              <p class="hero-copy">Your score is now stored on the separate learning leaderboard. The answer key below reveals each correct label and keeps all 10 clips available for review.</p>
            </div>
            <div class="score-stack"><div class="score-badge score-badge-quiz"><p class="score-value">${stats.totalCorrect} / ${stats.totalQuestions}</p></div><p class="score-caption">${formatPercent(stats.totalAccuracy)} accuracy</p></div>
          </div>
          <div class="results-strip results-strip-quiz">
            <div class="summary-card"><span>Total correct</span><strong>${stats.totalCorrect}</strong><p>${stats.totalQuestions - stats.totalCorrect} clips were missed or left undecided.</p></div>
            <div class="summary-card"><span>Accuracy</span><strong>${formatPercent(stats.totalAccuracy)}</strong><p>Quiz leaderboard ranking is based on total correct, then accuracy.</p></div>
            <div class="summary-card"><span>Track pool</span><strong>${stats.sectionStats.track.correct} / ${stats.sectionStats.track.total}</strong><p>Track examples correctly identified in this run.</p></div>
            <div class="summary-card"><span>Cascade pool</span><strong>${stats.sectionStats.cascade.correct} / ${stats.sectionStats.cascade.total}</strong><p>Cascade examples correctly identified in this run.</p></div>
          </div>
          ${renderRunInsights(run)}
          <div class="button-row"><button type="button" class="primary-button" data-action="play-again">Start another learning quiz</button><button type="button" class="secondary-button" data-action="open-analysis">Open analysis</button></div>
          <div class="quiz-review-grid">${run.answers.map((answer) => renderQuizReviewCard(answer)).join("")}</div>
        </div>
      </article>
      <aside class="panel"><div class="panel-inner"><div class="table-caption"><div><p class="eyebrow">Learning Standings</p><h2 class="card-title">Learning Quiz Leaderboard</h2></div><span class="pill-note">${leaderboard.length} completed player${leaderboard.length === 1 ? "" : "s"}</span></div>${renderLeaderboardTable(leaderboard, run.nameKey, "quiz")}</div></aside>
    </section>
  `;
}

function renderQuickQuizResultsView(run) {
  const leaderboard = buildLeaderboard(state.quickQuizPlayers, "quick");
  const stats = calculateRunStats(run.answers, "quick");

  return `
    <section class="results-layout appear quick-quiz-results">
      <article class="panel">
        <div class="panel-inner score-panel">
          <div class="score-shell">
            <div>
              <p class="eyebrow">4.0 Quick Quiz Complete</p>
              <h2 class="score-title">${escapeHtml(run.name)} completed all ${getRunVideoCount(run)} quiz videos</h2>
              <p class="hero-copy">
                Your statistics are stored in the separate 4.0 export category. The answer key
                below reveals each correct label and keeps every video from this run available for review.
              </p>
            </div>

            <div class="quick-results-scoreboard">
              <div class="quick-result-tile quick-result-coins">
                <span>Final coin bank</span>
                <strong><img class="coin-icon" src="${COIN_ICON_SRC}" alt="" aria-hidden="true" />${run.coins ?? 10}</strong>
              </div>
              <div class="quick-result-tile quick-result-score">
                <span>Quiz score</span>
                <strong>${stats.totalCorrect} / ${stats.totalQuestions}</strong>
                <p>${formatPercent(stats.totalAccuracy)} accuracy</p>
              </div>
            </div>
          </div>

          <div class="results-strip quick-results-details">
            <div class="summary-card">
              <span>Correct calls</span>
              <strong>${stats.totalCorrect}</strong>
              <p>${stats.totalQuestions - stats.totalCorrect} clips need another look.</p>
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

          ${renderRunInsights(run)}
          <div class="button-row">
            <button type="button" class="primary-button" data-action="play-again">Start another 4.0 quiz</button>
            <button type="button" class="secondary-button" data-action="open-analysis">Open 4.0 exports</button>
          </div>

          <div class="quick-review-heading">
            <p class="eyebrow">Answer Review</p>
            <h3 class="card-title">Replay each call</h3>
            <p class="subtle-copy">Compare your choice with the answer key for every video in this run.</p>
          </div>

          <div class="quiz-review-grid">
            ${run.answers.map((answer) => renderQuizReviewCard(answer)).join("")}
          </div>
        </div>
      </article>

      <aside class="panel">
        <div class="panel-inner">
          <div class="table-caption"><div><p class="eyebrow">4.0 Standings</p><h2 class="card-title">4.0 Quick Quiz Leaderboard</h2></div><span class="pill-note">${leaderboard.length} completed player${leaderboard.length === 1 ? "" : "s"}</span></div>
          <p class="hero-copy">This coin board is separate from Friday and Learning Quiz results.</p>
          ${renderLeaderboardTable(leaderboard, run.nameKey, "quick")}
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
        <video controls loop muted playsinline preload="metadata" src="${escapeHtml(answer.videoSrc || ALL_VIDEOS_BY_ID[answer.videoId]?.src || "")}"></video>
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
  const section = ["demo", "endless"].includes(run.mode) ? {...DEMO_SECTION, ...(run.mode === "endless" ? {label:"Endless Mode", title:"Keep reading the light."} : {})} : getSectionForIndex(run.currentIndex);
  const video = getVideoForRunIndex(run, run.currentIndex);
  const currentCoins = getVisibleCoins(run, section);
  const questionInSection = run.currentIndex - section.startIndex + 1;
  const sectionQuestionCount = getRunVideoCount(run);
  const overallQuestionNumber = run.mode === "endless" ? run.totalQuestions + 1 : run.currentIndex + 1;
  const lines = section.publicLines ? getPublicLines(video.id, getCrowdPlayers(run.mode)) : null;

  return `
    <section class="panel appear game-panel">
      <div class="panel-inner game-panel-inner">
        <div class="game-header game-header-compact">
          <div class="game-heading-block">
            <p class="eyebrow">${section.label}</p>
            <h2 class="hero-title">${section.title}</h2>
            <p class="game-copy">${run.mode === "endless" ? `Question ${overallQuestionNumber} • Saved progress across visits • No finish line` : `Clip ${overallQuestionNumber} of ${getRunVideoCount(run)} • Question ${questionInSection} of ${sectionQuestionCount} in this run`}</p>
          </div>

          <div class="status-strip status-strip-compact">
            <div class="stat-card">
              <span>Player</span>
              <strong>${escapeHtml(run.name)}</strong>
            </div>
            <div class="stat-card">
              <span>Question</span>
              <strong>${overallQuestionNumber} / ${run.mode === "endless" ? "∞" : getRunVideoCount(run)}</strong>
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
              <video controls autoplay loop muted playsinline preload="metadata" data-autoplay="true" src="${video.src}"></video>

            </div>
          </div>

          <div class="decision-column">
            <div class="decision-card ${section.publicLines ? "decision-card-market" : ""}">

              ${renderMobileVoteContext(lines)}
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
                <strong>Coins, streaks &amp; crowd bonus</strong>
                <p>Correct picks add 1 coin and wrong picks lose 1 coin. After 2 straight correct picks, each next consecutive correct pick earns 2 coins until the streak breaks. Double or Nothing changes one clip to -2 on a miss, +2 on a normal hit, or +3 on a streak hit. Choosing an answer with under 25% of recorded votes adds +2 coins only when your answer is correct.</p>
              </div>
              <div class="mini-card compact-card">
                <span>Public line</span>
                <strong>Built into each pick</strong>
                <p>Track and Cascade percentages are part of the answer cards and reflect ${run.mode === "endless" ? "saved Endless picks" : "the latest completed runs"} for that clip.</p>
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
  const isFinalQuestion = run.mode !== "endless" && run.currentIndex === getRunVideoCount(run) - 1;
  const coinDelta = typeof answer.coinsAfter === "number" ? answer.coinsAfter - answer.coinsBefore : null;
  const nextLabel = isFinalQuestion ? "Finish and show leaderboard" : "Next video";
  const expectedChoice = getExpectedChoice(answer.videoId) || answer.choice;
  const answerSection = getSectionById(answer.sectionId);
  const sectionQuestionCount = run.mode === "demo" ? getRunVideoCount(run) : answerSection
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

        ${renderCrowdBonusFeedback(answer)}
        <div class="feedback-grid">
          <div class="feedback-card">
            <span>Player choice</span>
            <strong>${titleCase(answer.choice)}</strong>
            <p>${escapeHtml(run.name)} committed the ${titleCase(answer.choice)} call for ${answer.videoLabel}.</p>
          </div>
          <div class="feedback-card">
            <span>Question progress</span>
            <strong>${answer.questionNumber} / ${run.mode === "endless" ? "∞" : getRunVideoCount(run)}</strong>
            <p>${run.mode === "endless" ? "Your progress continues across visits." : `${answer.sectionLabel}, question ${answer.sectionQuestionNumber} of ${sectionQuestionCount}.`}</p>
          </div>
          <div class="feedback-card">
            <span>Coin movement</span>
            <strong class="${run.mode === "endless" ? "coin-movement-pop" : ""}">${run.mode === "endless" ? `<img class="coin-icon" src="${COIN_ICON_SRC}" alt="" aria-hidden="true" />` : ""}${coinDelta === null ? "No change" : `${coinDelta > 0 ? "+" : ""}${coinDelta} coin${Math.abs(coinDelta) === 1 ? "" : "s"}`}</strong>
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
  if (run.mode === "endless") return renderEndlessResultsView(run);
  if (run.mode === "quiz") {
    return renderLearningQuizResultsView(run);
  }

  if (run.mode === "quick") {
    return renderQuickQuizResultsView(run);
  }

  const leaderboard = buildLeaderboard(getPlayersForMode(run.mode));
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
                ${run.mode === "demo" ? getCollaboratorRunStatus(run) : "Your score is saved in the shared leaderboard. Open Analysis &amp; Export for the answer breakdown."}
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
              <p>${marketStats.correct} of ${marketStats.total} correct with coins and public lines.</p>
            </div>
            <div class="summary-card">
              <span>Sample size</span>
              <strong>${getRunVideoCount(run)}</strong>
              <p>Random clips drawn from the ${run.mode === "demo" ? getCollaboratorVideos().length : VIDEOS.length}-video catalog.</p>
            </div>
          </div>

          ${renderRunInsights(run)}
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
          ${run.mode === "demo" ? renderCollaboratorSyncStatus() : ""}
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
                            ${typeof player.finalCoins === "number" ? player.finalCoins : 10}
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

function renderQuickQuizStatsOverview(players, history, nameKey = null) {
  const selectedPlayer = nameKey
    ? players.find((player) => player.nameKey === nameKey)
    : null;
  const source = selectedPlayer ? [selectedPlayer] : players;
  const completedCount = source.length;
  const averageAccuracy = completedCount
    ? source.reduce((sum, player) => sum + (player.totalAccuracy || 0), 0) / completedCount
    : 0;
  const averageCorrect = completedCount
    ? source.reduce((sum, player) => sum + (player.totalCorrect || 0), 0) / completedCount
    : 0;
  const attempts = selectedPlayer
    ? history.filter((record) => record.nameKey === selectedPlayer.nameKey).length
    : history.length;

  return `
    <div class="mini-card-grid quick-quiz-stat-grid">
      <div class="mini-card">
        <span>${selectedPlayer ? "Latest score" : "Completed quizzes"}</span>
        <strong>${selectedPlayer ? `${selectedPlayer.totalCorrect} / ${selectedPlayer.totalQuestions}` : completedCount}</strong>
        <p>${selectedPlayer ? "Your most recently saved 4.0 result." : "Saved separately from Friday runs."}</p>
      </div>
      <div class="mini-card">
        <span>${selectedPlayer ? "Latest accuracy" : "Average accuracy"}</span>
        <strong>${formatPercent(selectedPlayer ? selectedPlayer.totalAccuracy : averageAccuracy)}</strong>
        <p>${selectedPlayer ? "Your current recorded accuracy." : "Across saved 4.0 quiz records."}</p>
      </div>
      <div class="mini-card">
        <span>${selectedPlayer ? "Attempts" : "Average correct"}</span>
        <strong>${selectedPlayer ? attempts : `${averageCorrect.toFixed(1)} / ${QUICK_QUIZ_VIDEO_COUNT}`}</strong>
        <p>${selectedPlayer ? "Use exports to see your progress over time." : "Calculated from the current saved records."}</p>
      </div>
    </div>
  `;
}

function getReportMode() {
  return state.analysisMode || getActiveMode();
}

function getReportRecords(mode = getReportMode()) {
  const sources = {
    demo: [state.demoPlayers, state.demoHistory], friday: [state.players, state.playerHistory],
    quiz: [state.quizPlayers, state.quizHistory], quick: [state.quickQuizPlayers, state.quickQuizHistory],
    endless: [state.endlessPlayers, state.endlessHistory, [state.currentRun, state.savedEndlessRun, ...Object.values(state.endlessProfiles || {}), state.lastCompletedRun,
      ...loadStorage(STORAGE_KEYS.completedRuns, [])].filter(run => run?.mode === "endless")],
  };
  const records = new Map();
  for (const record of (sources[mode] || []).flat()) {
    if (!record?.id) continue;
    const previous = records.get(record.id);
    if (!previous || (record.totalQuestions || 0) > (previous.totalQuestions || 0) ||
        ((record.totalQuestions || 0) === (previous.totalQuestions || 0) && (record.answers?.length || 0) >= (previous.answers?.length || 0))) records.set(record.id, record);
  }
  return [...records.values()].sort((a, b) => String(a.completedAt || a.updatedAt || a.startedAt).localeCompare(String(b.completedAt || b.updatedAt || b.startedAt)));
}

function getDetailedReportDefinitions(mode = getReportMode()) {
  const records = getReportRecords(mode);
  const answers = records.flatMap(run => (run.answers || []).map(answer => {
    const video = ALL_VIDEOS_BY_ID[answer.videoId];
    return {
      mode, run_id: run.id, player: run.name, player_key: run.nameKey || normalizeName(run.name || ""),
      started_at: run.startedAt || null, completed_at: run.completedAt || null,
      question: answer.questionNumber ?? null, video_id: answer.videoId,
      video: answer.videoLabel || video?.label || answer.videoId,
      video_set: answer.sourceGroup || video?.sourceGroup || answer.categoryLabel || "Unknown",
      choice: answer.choice || "undecided", correct_answer: answer.expectedChoice || video?.correctChoice || null,
      correct: answer.correct === true, response_seconds: answer.responseSeconds ?? null,
      clip_time_at_pick_seconds: answer.videoCurrentTimeSeconds ?? null,
      clip_duration_seconds: answer.videoDurationSeconds ?? null,
      halfway_point_seconds: answer.videoHalfSeconds ?? null, delta_vs_half_seconds: answer.secondsFromHalf ?? null,
      half_position: answer.halfComparison || null, clip_progress_percent: typeof answer.videoProgress === "number" ? decimalPercent(answer.videoProgress) : null,
      double_down: Boolean(answer.doubleDown), crowd_bonus: answer.crowdBonus ?? 0,
      hot_hand: Boolean(answer.streakBonusApplied), coins_before: answer.coinsBefore ?? null, coins_after: answer.coinsAfter ?? null,
      pid: answer.pid ?? video?.pid ?? null, pid_group: answer.categoryId || video?.pidGroup || null,
      answered_at: answer.answeredAt || null,
    };
  }));
  const runs = records.map(run => {
    const count = run.totalQuestions ?? run.answers?.length ?? 0;
    const correct = run.totalCorrect ?? (run.answers || []).filter(answer => answer.correct).length;
    return {mode, run_id: run.id, player: run.name, player_key: run.nameKey || normalizeName(run.name || ""),
      questions: count, correct, accuracy_percent: count ? decimalPercent(correct / count) : null,
      coins: run.finalCoins ?? run.coins ?? null, best_streak: run.bestStreak ?? longestCorrectStreak(run.answers || []), wallet_resets: run.walletResets || 0,
      started_at: run.startedAt || null, completed_at: run.completedAt || null,
      status: run.completedAt || run.isCompleted ? "Finished" : "In progress",
      answer_details_available: run.answers?.length || 0};
  });
  const grouped = (rows, key) => {
    const groups = new Map();
    for (const row of rows) {
      const id = key(row);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(row);
    }
    return [...groups.values()];
  };
  const mean = values => {
    const finite = values.filter(value => typeof value === "number" && Number.isFinite(value));
    return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
  };
  const users = grouped(runs, row => row.player_key).map(attempts => {
    const latest = attempts[attempts.length - 1], first = attempts[0];
    const picks = answers.filter(answer => answer.player_key === latest.player_key);
    const questions = attempts.reduce((sum, row) => sum + row.questions, 0);
    const correct = attempts.reduce((sum, row) => sum + row.correct, 0);
    const accuracies = attempts.map(row => row.accuracy_percent).filter(value => value !== null);
    return {mode, player: latest.player, attempts: attempts.length, questions, correct,
      accuracy_percent: questions ? decimalPercent(correct / questions) : null,
      first_accuracy_percent: first.accuracy_percent, latest_accuracy_percent: latest.accuracy_percent,
      best_accuracy_percent: accuracies.length ? Math.max(...accuracies) : null,
      growth_percentage_points: first.accuracy_percent !== null && latest.accuracy_percent !== null ? latest.accuracy_percent - first.accuracy_percent : null,
      latest_coins: latest.coins, wallet_resets: attempts.reduce((sum, row) => sum + row.wallet_resets, 0), average_response_seconds: mean(picks.map(row => row.response_seconds)),
      average_clip_time_at_pick_seconds: mean(picks.map(row => row.clip_time_at_pick_seconds)),
      double_downs: picks.filter(row => row.double_down).length,
      crowd_bonus_coins: picks.reduce((sum, row) => sum + row.crowd_bonus, 0),
      answer_details_available: picks.length, latest_completed_at: latest.completed_at};
  });
  const catalog = ALL_VIDEOS.filter(video => mode === "quick" ? video.sectionId === "low-energy" : video.sectionId === "market");
  const videoMap = new Map(catalog.map(video => [video.id, {id:video.id,label:video.label,sourceGroup:video.sourceGroup,correctChoice:video.correctChoice}]));
  for (const answer of answers) if (!videoMap.has(answer.video_id)) videoMap.set(answer.video_id,{id:answer.video_id,label:answer.video,sourceGroup:answer.video_set,correctChoice:answer.correct_answer});
  const videos = [...videoMap.values()].map(video => {
    const picks = answers.filter(answer => answer.video_id === video.id), count = picks.length;
    const track = picks.filter(row => row.choice === "track").length, cascade = picks.filter(row => row.choice === "cascade").length;
    const correct = picks.filter(row => row.correct).length;
    return {mode, video_id:video.id, video:video.label, video_set:video.sourceGroup, correct_answer:video.correctChoice,
      attempts:count, unique_players:new Set(picks.map(row => row.player_key)).size,
      track_picks:track, cascade_picks:cascade, undecided_picks:count-track-cascade,
      track_percent:count ? decimalPercent(track/count) : null, cascade_percent:count ? decimalPercent(cascade/count) : null,
      correct, accuracy_percent:count ? decimalPercent(correct/count) : null,
      average_response_seconds:mean(picks.map(row => row.response_seconds)),
      average_clip_time_at_pick_seconds:mean(picks.map(row => row.clip_time_at_pick_seconds))};
  });
  const sets = grouped(answers, row => JSON.stringify([row.player_key,row.video_set])).map(picks => ({mode,
    player:picks[0].player, video_set:picks[0].video_set, answers:picks.length,
    correct:picks.filter(row => row.correct).length,
    accuracy_percent:decimalPercent(picks.filter(row => row.correct).length/picks.length),
    average_response_seconds:mean(picks.map(row => row.response_seconds))}));
  const events = (state.analyticsEvents || state.recentAnalyticsEvents || []).filter(event => event.mode === mode);
  const eventRows = events.map(event => ({timestamp:event.timestamp,mode:event.mode,event:event.type,
    player:event.nameKey || null,session_id:event.sessionId || null,run_id:event.runId || null,
    video:event.videoId || event.videoSrc || null,detail:JSON.stringify(Object.fromEntries(Object.entries(event).filter(([key]) => !["timestamp","mode","type","nameKey","sessionId","runId","videoId","videoSrc","id"].includes(key))))}));
  const engagement = (items, key, column) => grouped(items,key).map(group => ({mode,[column]:key(group[0]),
    events:group.length, sessions:new Set(group.map(event => event.sessionId).filter(Boolean)).size,
    plays:group.filter(event => event.type === "video_play").length,
    pauses:group.filter(event => event.type === "video_pause").length,
    seeks:group.filter(event => ["video_seek","video_seeked","video_seeking"].includes(event.type)).length,
    help_opens:group.filter(event => event.type === "help_opened").length,
    first_activity:group.map(event => event.timestamp).sort()[0],last_activity:group.map(event => event.timestamp).sort().at(-1)}));
  const eventUsers = engagement(events, event => event.nameKey || "Anonymous", "player");
  const eventVideoKey = event => {
    if (event.videoId) return event.videoId;
    try {
      const pathname = decodeURIComponent(new URL(event.videoSrc, window.location.href).pathname);
      return pathname.includes("/videos/") ? pathname.split("/videos/")[1] : simplifyVideoRef(pathname);
    } catch { return simplifyVideoRef(event.videoSrc); }
  };
  const eventVideos = engagement(events.filter(event => event.videoId || event.videoSrc), eventVideoKey, "video");
  const types = grouped(events,event => event.type).map(group => ({mode,event:group[0].type,count:group.length}));
  const define = (title,note,rows,keys) => ({title,note,rows,columns:keys.split(" ").map(key => [key,key.replaceAll("_"," ")]),fileName:`neutrino-${mode}-${title.toLowerCase().replaceAll(/[^a-z0-9]+/g,"-")}.csv`});
  return {
    users:define("Per-user performance","All retained attempts, weighted accuracy, growth, scoring, and decision timing.",users,"mode player attempts questions correct accuracy_percent first_accuracy_percent latest_accuracy_percent best_accuracy_percent growth_percentage_points latest_coins wallet_resets average_response_seconds average_clip_time_at_pick_seconds double_downs crowd_bonus_coins answer_details_available latest_completed_at"),
    videos:define("Per-video responses","Actual submitted answers across every retained attempt. No seeded votes are included; unanswered clips have no accuracy value.",videos,"mode video_id video video_set correct_answer attempts unique_players track_picks cascade_picks undecided_picks track_percent cascade_percent correct accuracy_percent average_response_seconds average_clip_time_at_pick_seconds"),
    runs:define("All run results","One row per retained run or continuing Endless profile.",runs,"mode run_id player player_key questions correct accuracy_percent coins wallet_resets best_streak status started_at completed_at answer_details_available"),
    answers:define("All answer details","One row per recorded answer, with choices, answer keys, timing, wagers, streaks, and crowd bonuses.",answers,"mode run_id player player_key question video_id video video_set choice correct_answer correct response_seconds clip_time_at_pick_seconds clip_duration_seconds halfway_point_seconds delta_vs_half_seconds half_position clip_progress_percent double_down crowd_bonus hot_hand coins_before coins_after pid pid_group started_at answered_at completed_at"),
    sets:define("Per-user video sets","Correctness and decision timing for each player and video set.",sets,"mode player video_set answers correct accuracy_percent average_response_seconds"),
    "activity-users":define("Per-user activity","Activity in the retained event window, including anonymous sessions.",eventUsers,"mode player events sessions plays pauses seeks help_opens first_activity last_activity"),
    "activity-videos":define("Per-video activity","Playback and interaction activity in the retained event window.",eventVideos,"mode video events sessions plays pauses seeks help_opens first_activity last_activity"),
    "activity-types":define("Activity event totals","Event counts for this mode in the retained window.",types,"mode event count"),
    "activity-events":define("All retained activity events","Raw activity events available from the server, limited to its rolling 5,000-event window.",eventRows,"timestamp mode event player session_id run_id video detail"),
  };
}

function renderReportNavigation() {
  const mode = getReportMode();
  return `<nav class="button-row report-navigation" aria-label="Report game mode">${["demo","friday","quiz","quick","endless"].map(id => `<button class="${id === mode ? "primary-button" : "ghost-button"}" data-action="select-analysis-mode" data-mode="${id}" aria-pressed="${id === mode}">${escapeHtml(MODE_CONFIGS[id]?.title || id)}</button>`).join("")}</nav><p class="subtle-copy">Viewing reports does not change your current game. Gameplay reports use the current score history. Activity reports include retained activity from before the reset.</p>`;
}

function renderDetailedReports() {
  const mode = getReportMode(), status = state.reportStatus?.[mode];
  const loading = !status || status === "loading";
  const statusCopy = loading ? "Loading full report data…" : status === "error" ? "Shared results could not load. Retry to refresh the reports." : "Full report data loaded. CSV downloads include every available row; tables preview the first 50.";
  return `<section class="report-status" role="status"><p>${statusCopy}</p><button class="ghost-button" data-action="select-analysis-mode" data-mode="${mode}">Refresh reports</button></section>${state.analyticsError ? `<p class="subtle-copy">Activity reports are unavailable: ${escapeHtml(state.analyticsError)}</p>` : ""}${mode === "endless" ? `<p class="subtle-copy">Endless run totals use available leaderboard and device saves. Detailed answers cover only the latest ten picks retained per local run; they are not a complete lifetime history. This host may not support shared Endless results.</p>` : ""}${Object.entries(getDetailedReportDefinitions(mode)).map(([id,definition]) => renderAnalysisTable({title:definition.title,note:`${definition.note} ${definition.rows.length} rows available.`,report:`detail-${id}`,headers:definition.columns.map(column => escapeHtml(column[1])),rows:definition.rows.slice(0,50).map(row => definition.columns.map(([key]) => escapeHtml(row[key] === null || row[key] === undefined ? "—" : typeof row[key] === "number" && !Number.isInteger(row[key]) ? row[key].toFixed(2) : String(row[key])))),ready:id.startsWith("activity-") ? state.analyticsLoaded && !state.analyticsError : ["ready","partial"].includes(status)})).join("")}`;
}

function renderAnalysisModal() {
  if (state.showAnalysis && getReportMode() === "endless") return renderAnalysisModalShell({eyebrow:"Endless Mode",title:"Endless Analysis & Export",description:"Run totals, available answer details, and activity reports for Endless Mode.",body:renderEndlessSyncStatus()+renderEndlessLeaderboard()});
  if (state.showAnalysis && getReportMode() === "demo") {
    return renderAnalysisModalShell({ eyebrow: "Collaborator Game", title: "Collaborator Analysis & Export", description: "Shared standings and downloadable per-user, per-run, and per-video reports.", body: renderCollaboratorSyncStatus() + renderLeaderboardTable(buildLeaderboard(state.demoPlayers), null, "demo") });
  }
  if (!state.showAnalysis) {
    return "";
  }

  return getReportMode() === "quick"
    ? renderQuickQuizAnalysisModal()
    : getReportMode() === "quiz"
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
  const detailRows = buildQuizAnswerRows(state.quizHistory);
  const growthRows = buildGrowthRows(state.quizHistory, "quiz");
  const eventSummaryRows = buildEventSummaryRows(state.analyticsSummary);
  const recentEventRows = buildRecentEventRows(state.recentAnalyticsEvents);

  return renderAnalysisModalShell({
    eyebrow: "Owner View",
    title: "Learning Quiz Analysis",
    description: "This view pulls from the separate learning-quiz leaderboard and exports accuracy-first study results without mixing them into the Friday coin mode.",
    body: summaryRows.length
      ? `
          <div class="summary-strip">
            <div class="summary-card"><span>Completed users</span><strong>${summaryRows.length}</strong><p>Each name stores the latest completed learning quiz for that player.</p></div>
            <div class="summary-card"><span>Total attempts</span><strong>${state.quizHistory.length}</strong><p>Every quiz attempt is preserved so improvement can be tracked over time.</p></div>
            <div class="summary-card"><span>Average correct</span><strong>${(summaryRows.reduce((sum, row) => sum + row.totalCorrect, 0) / summaryRows.length).toFixed(1)} / ${QUIZ_VIDEO_COUNT}</strong><p>Average number of correct answers across quiz submissions.</p></div>
            <div class="summary-card"><span>Average accuracy</span><strong>${formatPercent(summaryRows.reduce((sum, row) => sum + row.totalAccuracy, 0) / summaryRows.length)}</strong><p>Overall correctness rate for the one-page learning quiz.</p></div>
          </div>
          ${renderAnalysisTable({ title: "Per-user quiz growth", note: "Shows how each learner improves across multiple quiz attempts over time.", report: "quiz-growth", headers: ["Player", "Attempts", "First Score", "Latest Score", "Best Score", "First Accuracy", "Latest Accuracy", "Growth"], rows: growthRows.map((row) => [escapeHtml(row.name), row.attempts, `${row.firstCorrect} / ${row.totalQuestions}`, `${row.latestCorrect} / ${row.totalQuestions}`, `${row.bestCorrect} / ${row.totalQuestions}`, formatPercent(row.firstAccuracy), formatPercent(row.latestAccuracy), formatSignedPercent(row.accuracyGrowth)]) })}
          ${renderAnalysisTable({ title: "Per-user quiz summary", note: "Use this table for total correct, total accuracy, and average decision timing in the learning mode.", report: "quiz-user-summary", headers: ["Player", "Correct", "Accuracy", "Avg Response Time", "Avg Clip Time At Pick", "After Half Rate", "Completed"], rows: summaryRows.map((row) => [escapeHtml(row.name), `${row.totalCorrect} / ${row.totalQuestions}`, formatPercent(row.totalAccuracy), formatSeconds(row.averageResponseSeconds), formatSeconds(row.averageClipTimeAtChoiceSeconds), formatPercent(row.afterHalfRate), formatDate(row.completedAt)]) })}
          ${renderAnalysisTable({ title: "Per-answer learning review", note: "One row per answered quiz clip, including undecided submissions, the expected answer, and response timing.", report: "quiz-answer-detail", headers: ["Player", "Video", "Your Choice", "Correct Answer", "Correct", "Response Time", "Clip Time At Pick", "Completed"], rows: detailRows.map((row) => [escapeHtml(row.name), escapeHtml(row.videoLabel), titleCase(row.choice), titleCase(row.expectedChoice), row.correct ? "Yes" : "No", formatSeconds(row.responseSeconds), formatSeconds(row.videoCurrentTimeSeconds), formatDate(row.completedAt)]) })}
          ${renderAnalysisTable({ title: "Engagement telemetry summary", note: "Aggregates client listeners like quiz choice changes, help opens, video plays, seeks, and submissions.", report: "event-summary", headers: ["Event", "Count"], rows: eventSummaryRows.map((row) => [escapeHtml(row.eventType), row.count]) })}
          ${renderAnalysisTable({ title: "Recent telemetry events", note: "Recent client-side listener events across both modes for studying behavior and feature usage.", report: "recent-events", headers: ["When", "Mode", "Event", "Player", "Run", "Video", "Detail"], rows: recentEventRows.map((row) => [formatDate(row.timestamp), row.mode, row.type, escapeHtml(row.nameKey || "n/a"), escapeHtml(row.runId || "n/a"), escapeHtml(row.videoRef || "n/a"), escapeHtml(row.detail)]) })}
        `
      : renderEmptyAnalysisState("There are no completed learning quizzes yet. Once someone submits a 10-video quiz, the separate export tables will appear here automatically."),
  });
}

function renderQuickQuizAnalysisModal() {
  const reportPlayers = getQuickQuizReportRecords(state.quickQuizPlayers);
  const reportHistory = getQuickQuizReportRecords(state.quickQuizHistory);
  const summaryRows = buildQuizSummaryRows(reportPlayers);
  const detailRows = buildQuizAnswerRows(reportHistory);
  const groupRows = buildQuickQuizGroupRows(reportHistory);
  const growthRows = buildGrowthRows(reportHistory, "quick");
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
    title: "4.0 Quick Quiz Exports",
    description:
      "This category contains only 4.0 quick-quiz statistics. Its accuracy-first exports never mix with Friday game or coin data.",
    body: summaryRows.length
      ? `
          <div class="summary-strip">
            <div class="summary-card">
              <span>Completed users</span>
              <strong>${summaryRows.length}</strong>
              <p>Each name stores the latest completed 4.0 quiz for that player.</p>
            </div>
            <div class="summary-card">
              <span>Total attempts</span>
              <strong>${reportHistory.length}</strong>
              <p>Every 4.0 attempt is preserved so improvement can be tracked over time.</p>
            </div>
            <div class="summary-card">
              <span>Average correct</span>
              <strong>${averageScore.toFixed(1)} / ${QUICK_QUIZ_VIDEO_COUNT}</strong>
              <p>Average number of correct answers across 4.0 submissions.</p>
            </div>
            <div class="summary-card">
              <span>Average accuracy</span>
              <strong>${formatPercent(averageAccuracy)}</strong>
              <p>Overall correctness rate for the 21-video quick quiz.</p>
            </div>
          </div>

          ${renderAnalysisTable({
            title: "4.0 user growth",
            note: "Shows how each learner improves across multiple 4.0 attempts over time.",
            report: "quick-quiz-growth",
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
            title: "4.0 user summary",
            note: "Use this table for total correct, total accuracy, and average decision timing in the 4.0 category.",
            report: "quick-quiz-user-summary",
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
            title: "4.0 totals and PID groups",
            note: "Exports one total row plus separate rows for PID did well, PID was uncertain, and PID did poorly for every completed 4.0 attempt.",
            report: "quick-quiz-pid-groups",
            headers: ["Player", "Result set", "Correct", "Total", "Accuracy", "Completed"],
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
            title: "4.0 answer detail",
            note: "One row per answered 4.0 clip, including its PID-performance tag, expected answer, and response timing.",
            report: "quick-quiz-answer-detail",
            headers: ["Player", "Video", "PID Group", "PID", "Your Choice", "Correct Answer", "Correct", "Response Time", "Clip Time At Pick", "Completed"],
            rows: detailRows.map((row) => [
              escapeHtml(row.name),
              escapeHtml(row.videoLabel),
              row.category || "n/a",
              typeof row.pid === "number" ? row.pid.toFixed(3) : "n/a",
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
            note: "Aggregates client listeners like quick-quiz answers, help opens, video plays, seeks, and submissions.",
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
      : renderEmptyAnalysisState("There are no completed 4.0 quizzes yet. Once someone completes a 21-video quiz, the separate export tables will appear here automatically."),
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

          ${renderReportNavigation()}
          ${body}
          ${renderDetailedReports()}
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

          <section class="panel"><div class="panel-inner"><p class="eyebrow">Coin game rules</p>${renderGameMechanics()}</div></section>
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

function renderAnalysisTable({ title, note, report, headers, rows, ready = state.reportStatus?.[getReportMode()] === "ready" }) {
  return `
    <section class="panel">
      <div class="panel-inner">
        <div class="table-caption">
          <div>
            <h3 class="card-title">${title}</h3>
            <p class="table-note">${note}</p>
          </div>
          <button type="button" class="secondary-button" data-action="download-csv" data-report="${report}" ${ready ? "" : "disabled"}>
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
  const bonus = getCrowdBonus(getCurrentChoiceLines(), choice, true);
  const responsesLabel = totalResponses
    ? `${totalResponses} public pick${totalResponses === 1 ? "" : "s"}`
    : "reference estimate when available; otherwise 50/50. No live votes yet";

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
      ${bonus ? `<span class="crowd-bonus-tag">Correct minority call · +${bonus}</span>` : ""}
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
    video.loop = true;
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
  if (state.currentRun?.mode === "endless") { pauseEndlessRun(); return; }
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
    // Each browser gets a different schedule, avoiding a synchronized refresh burst.
    playerSyncTimerId = window.setInterval(() => {
      if (document.visibilityState !== "hidden" && !state.currentRun) void syncAllDataFromServer();
    }, PLAYER_SYNC_INTERVAL_MS + Math.floor(Math.random() * 30000));
  }
  window.addEventListener("focus", () => {
    if (!state.currentRun) void syncAllDataFromServer();
  });
}

async function fetchSharedJson(url) {
  const key = url;
  if (sharedRequests.has(key)) return sharedRequests.get(key);
  if ((sharedRetryAfter.get(key) || 0) > Date.now()) throw new Error("Shared data is busy; retrying shortly.");
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeout = controller ? window.setTimeout(() => controller.abort(), 20000) : null;
  const pending = (async () => {
    try {
      const response = await fetch(url, {cache: "no-cache", ...(controller ? {signal: controller.signal} : {})});
      if (!response.ok) {
        const wait = Number(response.headers?.get("Retry-After")) || 15;
        sharedRetryAfter.set(key, Date.now() + Math.min(300, Math.max(5, wait)) * 1000);
        throw new Error(`Shared data unavailable (${response.status}). Retrying shortly.`);
      }
      sharedRetryAfter.delete(key);
      return await response.json();
    } finally {
      if (timeout !== null) window.clearTimeout(timeout);
      sharedRequests.delete(key);
    }
  })();
  sharedRequests.set(key, pending);
  return pending;
}

async function fetchLeaderboardData(url, mode) {
  const full = state.showAnalysis;
  const payload = await fetchSharedJson(full ? `${url}?view=full` : url);
  if (full && !Array.isArray(payload.history)) {
    const history = [];
    let cursor = null;
    do {
      const page = await fetchSharedJson(`/api/history?mode=${mode}${cursor ? `&cursor=${encodeURIComponent(JSON.stringify(cursor))}` : ""}`);
      history.push(...page.history);
      cursor = page.nextCursor;
    } while (cursor);
    payload.history = history;
  }
  return payload;
}

async function syncAllDataFromServer({force = false} = {}) {
  const mode = state.showAnalysis ? getReportMode() : getActiveMode();
  const key = `${mode}:${state.showAnalysis}`;
  const pendingUpload = mode === "demo" && state.pendingCollaboratorRuns.length;
  if (!force && !pendingUpload && Date.now() - (lastModeSync.get(key) || 0) < 15000) return;
  lastModeSync.set(key, Date.now());
  if (state.showAnalysis) {
    state.reportStatus = {...state.reportStatus, [mode]: "loading"};
    render();
  }
  const sync = {endless: () => syncEndlessFromServer({refresh:true}), demo: syncCollaboratorPlayersFromServer, friday: syncPlayersFromServer,
    quiz: syncQuizPlayersFromServer, quick: syncQuickQuizPlayersFromServer}[mode];
  await Promise.all([sync(), ...(state.showAnalysis ? [syncAnalyticsFromServer()] : [])]);
  if (state.showAnalysis) {
    const error = {demo:state.collaboratorLeaderboardError,friday:state.scheduleError,quiz:state.quizLeaderboardError,quick:state.quickQuizError,endless:state.endlessError}[mode];
    state.reportStatus = {...state.reportStatus, [mode]: error ? mode === "endless" ? "partial" : "error" : "ready"};
    render();
  }
}

async function syncLeaderboardsFromServer() {
  await syncAllDataFromServer({force: true});
}

async function syncPlayersFromServer() {
  try {
    const payload = await fetchLeaderboardData(API_PLAYERS_URL, "friday");
    const dataVersion = typeof payload.updatedAt === "string" ? payload.updatedAt : null;
    const dataChanged = !state.scheduleLoaded || state.fridayDataVersion !== dataVersion;
    applyFridayPayload(payload);
    state.scheduleLoaded = true;
    state.scheduleError = null;
    state.fridayDataVersion = dataVersion;
    applyWeeklyVideoSelection();
    const runBecameInvalid = Boolean(
      state.currentRun && !isCurrentRunCompatible(state.currentRun),
    );

    if ((dataChanged || state.showAnalysis) && (!state.currentRun || state.showAnalysis || state.lastCompletedRun || runBecameInvalid)) {
      render();
    }
  } catch (error) {
    console.error(error);
    state.scheduleLoaded = true;
    state.scheduleError = error instanceof Error
      ? error.message
      : "Couldn't load the shared Friday lineup.";
    if (!state.currentRun || state.showAnalysis || state.lastCompletedRun) render();
  }
}

async function syncQuizPlayersFromServer() {
  try {
    const payload = await fetchLeaderboardData(API_QUIZ_PLAYERS_URL, "quiz");
    const dataVersion = typeof payload.updatedAt === "string" ? payload.updatedAt : null;
    const dataChanged = !state.quizLeaderboardLoaded || state.quizDataVersion !== dataVersion;
    applyQuizPayload(payload);
    state.quizLeaderboardLoaded = true;
    state.quizLeaderboardError = null;
    state.quizDataVersion = dataVersion;

    if ((dataChanged || state.showAnalysis) && (!state.currentRun || state.showAnalysis || state.lastCompletedRun)) {
      render();
    }
  } catch (error) {
    console.error(error);
    state.quizLeaderboardLoaded = true;
    state.quizLeaderboardError = error instanceof Error
      ? error.message
      : "Couldn't load the learning quiz leaderboard.";
    if (!state.currentRun || state.showAnalysis || state.lastCompletedRun) render();
  }
}

async function syncQuickQuizPlayersFromServer() {
  try {
    const payload = await fetchLeaderboardData(API_QUICK_QUIZ_PLAYERS_URL, "quick");
    const dataVersion = typeof payload.updatedAt === "string" ? payload.updatedAt : null;
    const dataChanged = !state.quickQuizLoaded || state.quickQuizDataVersion !== dataVersion;
    applyQuickQuizPayload(payload);
    state.quickQuizLoaded = true;
    state.quickQuizError = null;
    state.quickQuizDataVersion = dataVersion;

    if ((dataChanged || state.showAnalysis) && (!state.currentRun || state.showAnalysis || state.lastCompletedRun)) {
      render();
    }
  } catch (error) {
    console.error(error);
    state.quickQuizLoaded = true;
    state.quickQuizError = error instanceof Error ? error.message : "Couldn't load the 4.0 quick-quiz statistics.";
    if (!state.currentRun || state.showAnalysis || state.lastCompletedRun) render();
  }
}

async function syncAnalyticsFromServer() {
  try {
    const payload = await fetchSharedJson(state.showAnalysis ? `${API_ANALYTICS_URL}?view=full` : API_ANALYTICS_URL);
    applyAnalyticsPayload(payload);
    state.analyticsLoaded = true;
    state.analyticsError = null;
    if (state.showAnalysis) render();
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
      "X-Neutrino-State-Epoch": GAME_STATE_EPOCH,
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
      "X-Neutrino-State-Epoch": GAME_STATE_EPOCH,
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

async function uploadQuickQuizPlayerRecord(playerRecord) {
  const response = await fetch(API_QUICK_QUIZ_PLAYERS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Neutrino-State-Epoch": GAME_STATE_EPOCH },
    body: JSON.stringify(playerRecord),
  });

  if (!response.ok) {
    throw new Error(`Failed to upload 4.0 quick-quiz player record: ${response.status}`);
  }

  return response.json();
}

function applyBoardData(payload, playersKey, historyKey) {
  const confirmed = recentlyAcceptedPlayers.get(playersKey) || new Map();
  for (const [key, accepted] of confirmed) {
    if (accepted.expires <= Date.now()) confirmed.delete(key);
  }
  if (payload.partial) {
    for (const player of payload.players || []) confirmed.set(player.nameKey, {player, expires: Date.now() + 120000});
  }
  recentlyAcceptedPlayers.set(playersKey, confirmed);
  if (Array.isArray(payload.players)) {
    if (payload.partial) {
      const players = new Map(state[playersKey].map(player => [player.nameKey, player]));
      for (const player of payload.players) {
        const previous = players.get(player.nameKey);
        if (!previous || previous.completedAt <= player.completedAt) players.set(player.nameKey, player);
      }
      const crowdStats = state[playersKey].crowdStats;
      state[playersKey] = [...players.values()];
      if (crowdStats) state[playersKey].crowdStats = crowdStats;
    } else {
      const players = new Map(payload.players.map(player => [player.nameKey, player]));
      // A cached read can briefly predate this browser's successful submission.
      for (const {player} of confirmed.values()) {
        if (playersKey === "players" && player.cycleStart && player.cycleStart !== payload.activeCycleStart) continue;
        const previous = players.get(player.nameKey);
        if (!previous || new Date(previous.completedAt) <= new Date(player.completedAt)) players.set(player.nameKey, player);
      }
      state[playersKey] = [...players.values()];
    }
  }
  if (payload.crowdStats) state[playersKey].crowdStats = payload.crowdStats;
  if (Array.isArray(payload.history)) {
    state[historyKey] = payload.partial
      ? [...new Map([...state[historyKey], ...payload.history].map(record => [record.id, record])).values()]
      : payload.history;
  }
}

function applyFridayPayload(payload) {
  applyBoardData(payload, "players", "playerHistory");
  if (typeof payload.activeCycleStart === "string") state.activeCycleStart = payload.activeCycleStart;
  if (typeof payload.activeCycleEnd === "string") state.activeCycleEnd = payload.activeCycleEnd;
  if (Array.isArray(payload.activeVideoIds)) state.activeVideoIds = payload.activeVideoIds.filter(id => typeof id === "string");
  if (typeof payload.catalogSize === "number") state.catalogSize = payload.catalogSize;
}

function applyQuizPayload(payload) {
  applyBoardData(payload, "quizPlayers", "quizHistory");
  if (typeof payload.catalogSize === "number") state.catalogSize = payload.catalogSize;
}

function applyQuickQuizPayload(payload) {
  applyBoardData(payload, "quickQuizPlayers", "quickQuizHistory");
  if (typeof payload.catalogSize === "number") state.catalogSize = payload.catalogSize;
}

function applyAnalyticsPayload(payload) {
  state.analyticsSummary = payload?.summary && typeof payload.summary === "object"
    ? payload.summary
    : null;
  state.recentAnalyticsEvents = Array.isArray(payload?.recentEvents)
    ? payload.recentEvents
    : [];
  if (Array.isArray(payload?.events)) state.analyticsEvents = payload.events;
}

function beginRun(rawName, mode = "demo") {
  if (mode === "endless") { beginEndlessRun(rawName); return; }
  const name = rawName.trim();
  const questionStartedAt = new Date().toISOString();
  const normalizedMode = ["demo", "quiz", "quick", "endless"].includes(mode) ? mode : "friday";
  const quickQuizSetup = normalizedMode === "quick" ? buildQuickQuizRun() : null;

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
    : normalizedMode === "quick"
      ? {
        id: `quick-quiz-run-${Date.now()}`,
        mode: "quick",
        name,
        nameKey: normalizeName(name),
        videoOrder: quickQuizSetup.videoOrder,
        videoGroups: quickQuizSetup.videoGroups,
        currentIndex: 0,
        phase: "quick-question",
        answers: [],
        coins: null,
        startedAt: new Date().toISOString(),
        questionStartedAt,
      }
    : {
      id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      mode: normalizedMode,
      name,
      nameKey: normalizeName(name),
      cycleStart: state.activeCycleStart,
      videoOrder: buildRunVideoOrder(normalizedMode),
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
  if (state.currentRun?.mode === "endless") { handleEndlessChoice(choice); return; }
  const run = state.currentRun;

  if (!run || run.mode === "quiz" || run.phase !== "question") {
    return;
  }

  const section = run.mode === "demo" ? DEMO_SECTION : getSectionForIndex(run.currentIndex);
  const video = getVideoForRunIndex(run, run.currentIndex);
  if (!video || !["track", "cascade"].includes(choice)) return;
  const correct = isAnswerCorrect(video.id, choice);
  const publicLines = section.publicLines ? getPublicLines(video.id, getCrowdPlayers(run.mode)) : null;
  const crowdBonus = getCrowdBonus(publicLines, choice, correct);
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

    coinsAfter += crowdBonus;
    run.coins = coinsAfter;
  }

  run.answers.push({
    videoId: video.id,
    videoLabel: video.label,
    videoSrc: video.src,
    expectedChoice: getExpectedChoice(video.id),

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
    crowdBonus,
    sourceGroup: video.sourceGroup,
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

  trackEvent(run.mode === "demo" ? "demo_answer_locked" : "friday_answer_locked", {
    mode: run.mode,
    crowdBonus,
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

  evaluateAchievements(run);
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

function answerQuizQuestion(choice) {
  const run = state.currentRun;

  if (!run || run.mode !== "quick" || run.phase !== "quick-question" || run.isFinalizing) {
    return;
  }

  const video = getVideoForRunIndex(run, run.currentIndex);

  if (!video || !["track", "cascade"].includes(choice)) {
    return;
  }

  const timing = getCurrentQuestionTiming(run.questionStartedAt);
  const expectedChoice = getExpectedChoice(video.id);
  const group = getQuickQuizGroup(run, video.id);
  const correct = choice === expectedChoice;
  const doubleDown = isDoubleDownSelected();
  const coinsBefore = typeof run.coins === "number" ? run.coins : 10;
  const streakBefore = getCoinCorrectStreak(run.answers);
  const streakBonusApplied = correct && streakBefore >= 2;
  const streakAfter = correct ? streakBefore + 1 : 0;
  let coinsAfter = correct
    ? coinsBefore + (doubleDown ? (streakBonusApplied ? 3 : 2) : (streakBonusApplied ? 2 : 1))
    : coinsBefore - (doubleDown ? 2 : 1);
  const publicLines = getPublicLines(video.id, state.quickQuizPlayers);
  const crowdBonus = getCrowdBonus(publicLines, choice, correct);
  coinsAfter += crowdBonus;

  run.coins = coinsAfter;
  const answer = {
    videoId: video.id,
    videoLabel: video.label,
    videoSrc: video.src,

    sourceGroup: video.sourceGroup,
    questionNumber: run.currentIndex + 1,
    sectionId: expectedChoice,
    sectionLabel: titleCase(expectedChoice),
    sectionQuestionNumber: run.currentIndex + 1,
    choice,
    expectedChoice,
    categoryId: group.id,
    categoryLabel: group.label,
    pid: video.pid,
    correct,
    coinsBefore,
    coinsAfter,
    doubleDown,
    streakBefore,
    streakAfter,
    streakBonusApplied,
    publicLines,
    crowdBonus,
    ...timing,
  };

  run.answers.push(answer);
  trackEvent("quick_quiz_answered", {
    mode: "quick",
    runId: run.id,
    nameKey: run.nameKey,
    videoId: video.id,
    choice,
    correct,
    doubleDown,
    questionNumber: answer.questionNumber,
    responseSeconds: timing.responseSeconds,
  });

  evaluateAchievements(run);
  run.phase = "quick-feedback";
  saveStorage(STORAGE_KEYS.currentRun, run);
  render();
}

async function advanceRun() {
  if (state.currentRun?.mode === "endless") { advanceEndlessRun(); return; }
  const run = state.currentRun;

  if (!run) {
    return;
  }

  if (run.mode === "quick" && run.phase === "quick-feedback") {
    if (run.currentIndex >= getRunVideoCount(run) - 1) {
      run.isFinalizing = true;
      saveStorage(STORAGE_KEYS.currentRun, run);
      await finalizeRun();
      return;
    }

    run.currentIndex += 1;
    run.phase = "quick-question";
    run.questionStartedAt = new Date().toISOString();
    saveStorage(STORAGE_KEYS.currentRun, run);
    render();
    return;
  }

  if (run.phase !== "feedback") {
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
  if (state.currentRun?.mode === "endless") { pauseEndlessRun(); return; }
  const run = state.currentRun;

  if (!run) {
    return;
  }

  if (run.mode === "quiz") {
    await finalizeQuizRun(run);
    return;
  }

  if (run.mode === "quick") {
    await finalizeQuickQuizRun(run);
    return;
  }

  if (run.mode === "demo") {
    evaluateAchievements(run, true);
    const stats = calculateRunStats(run.answers);
    const record = { ...run, completedAt: new Date().toISOString(), finalCoins: run.coins ?? 10, totalCorrect: stats.totalCorrect, totalQuestions: stats.totalQuestions, totalAccuracy: stats.totalAccuracy, sectionStats: stats.sectionStats };
    if (run.answers.length !== DEMO_VIDEO_COUNT) return;
    state.pendingCollaboratorRuns = [...state.pendingCollaboratorRuns.filter(item => item.id !== record.id), record];
    saveStorage(STORAGE_KEYS.pendingCollaboratorRuns, state.pendingCollaboratorRuns);
    state.lastCompletedRun = record;
    state.currentRun = null;
    localStorage.removeItem(STORAGE_KEYS.currentRun);
    render();
    void syncCollaboratorPlayersFromServer();
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
    evaluateAchievements(run, true);
    playerRecord.unlockedAchievementIds = run.unlockedAchievementIds || [];
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
      ...timing,
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
    evaluateAchievements(run, true);
    playerRecord.unlockedAchievementIds = run.unlockedAchievementIds || [];
    state.lastCompletedRun = playerRecord;
    state.currentRun = null;
    localStorage.removeItem(STORAGE_KEYS.currentRun);
    render();
  } catch (error) {
    console.error(error);
    window.alert(
      "Couldn't upload this learning quiz yet. The finished review stays on this device, so please try again in a moment.",
    );
    run.isFinalizing = false;
    state.currentRun = run;
    saveStorage(STORAGE_KEYS.currentRun, run);
    render();
  }
}

async function finalizeQuickQuizRun(run) {
  const answers = [...run.answers];

  if (answers.length !== getRunVideoCount(run)) {
    return;
  }

  const completedAt = new Date().toISOString();
  const stats = calculateRunStats(answers, "quick");
  const playerRecord = {
    id: run.id,
    mode: "quick",
    name: run.name,
    nameKey: run.nameKey,
    startedAt: run.startedAt,
    completedAt,
    finalCoins: typeof run.coins === "number" ? run.coins : 10,
    totalCorrect: stats.totalCorrect,
    totalQuestions: stats.totalQuestions,
    totalAccuracy: stats.totalAccuracy,
    sectionStats: stats.sectionStats,
    answers,
  };

  run.phase = "quick-results";

  try {
    const payload = await uploadQuickQuizPlayerRecord(playerRecord);
    applyQuickQuizPayload(payload);
    trackEvent("run_completed", {
      mode: "quick",
      runId: run.id,
      nameKey: run.nameKey,
      totalCorrect: stats.totalCorrect,
      totalQuestions: stats.totalQuestions,
      totalAccuracy: stats.totalAccuracy,
      finalCoins: playerRecord.finalCoins,
    });
    evaluateAchievements(run, true);
    playerRecord.unlockedAchievementIds = run.unlockedAchievementIds || [];
    state.lastCompletedRun = playerRecord;
    state.currentRun = null;
    localStorage.removeItem(STORAGE_KEYS.currentRun);
    render();
  } catch (error) {
    console.error(error);
    window.alert("Couldn't upload this 4.0 quiz yet. The finished review stays on this device, so please try again in a moment.");
    run.isFinalizing = false;
    state.currentRun = run;
    saveStorage(STORAGE_KEYS.currentRun, run);
    render();
  }
}

function calculateRunStats(answers, mode = "friday") {
  const totalQuestions = answers.length;
  const totalCorrect = answers.filter((answer) => answer.correct).length;
  const totalAccuracy = totalQuestions ? totalCorrect / totalQuestions : 0;

  const sectionDefinitions = ["quiz", "quick"].includes(mode)
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

function getQuickQuizGroupStats(answers) {
  return QUICK_QUIZ_GROUPS.reduce((stats, group) => {
    const groupAnswers = answers.filter((answer) => answer.categoryId === group.id);
    const correct = groupAnswers.filter((answer) => answer.correct).length;
    const total = groupAnswers.length;
    stats[group.id] = { correct, total, accuracy: total ? correct / total : 0 };
    return stats;
  }, {});
}

function buildLeaderboard(players, mode = "friday") {
  if (mode === "endless") return [...players].sort(compareEndlessRuns);
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

    const leftCoins = typeof left.finalCoins === "number" ? left.finalCoins : 10;
    const rightCoins = typeof right.finalCoins === "number" ? right.finalCoins : 10;

    if (rightCoins !== leftCoins) {
      return rightCoins - leftCoins;
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
      category: answer.categoryLabel || null,
      pid: answer.pid ?? null,
      correct: answer.correct,
      responseSeconds: answer.responseSeconds ?? null,
      videoCurrentTimeSeconds: answer.videoCurrentTimeSeconds ?? null,
      completedAt: player.completedAt,
    })),
  );
}

function buildQuickQuizGroupRows(records) {
  return records.flatMap((record) => {
    const answers = Array.isArray(record.answers) ? record.answers : [];
    const totalCorrect = answers.filter((answer) => answer.correct).length;
    const totalRow = {
      name: record.name,
      groupLabel: "Total 4.0 quiz",
      correct: totalCorrect,
      total: answers.length,
      accuracy: answers.length ? totalCorrect / answers.length : 0,
      completedAt: record.completedAt,
    };
    const groupRows = QUICK_QUIZ_GROUPS.map((group) => {
      const groupAnswers = answers.filter((answer) => answer.categoryId === group.id);
      const correct = groupAnswers.filter((answer) => answer.correct).length;

      return {
        name: record.name,
        groupLabel: group.label,
        correct,
        total: groupAnswers.length,
        accuracy: groupAnswers.length ? correct / groupAnswers.length : 0,
        completedAt: record.completedAt,
      };
    });

    return [totalRow, ...groupRows];
  });
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
    trackPercentage: summary.totalResponses ? summary.trackCount / summary.totalResponses : summary.trackPercentage,
    cascadePercentage: summary.totalResponses ? summary.cascadeCount / summary.totalResponses : summary.cascadePercentage,
    totalResponses: summary.totalResponses,
    trackCount: summary.trackCount,
    cascadeCount: summary.cascadeCount,
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
  if (["demo", "quiz", "quick", "endless"].includes(run?.mode)) {
    return ALL_VIDEOS_BY_ID[videoId] || ALL_VIDEOS[index];
  }

  return VIDEOS_BY_ID[videoId] || VIDEOS[index];
}

function getRunVideoCount(run = state.currentRun) {
  if (run?.mode === "endless") return run.totalQuestions;
  if (run?.mode === "demo" && run.completedAt && run.answers?.length) return run.answers.length;
  const configuredCount = run?.mode === "demo" ? Math.min(DEMO_VIDEO_COUNT, getCollaboratorVideos().length) : run?.mode === "quiz"
    ? QUIZ_VIDEO_COUNT
    : run?.mode === "quick"
      ? getQuickQuizVideoCount()
      : getConfiguredRunVideoCount();

  if (Array.isArray(run?.videoOrder) && run.videoOrder.length) {
    return Math.min(run.videoOrder.length, configuredCount);
  }

  return configuredCount;
}

function getConfiguredRunVideoCount() {
  return Math.min(RUN_VIDEO_COUNT, VIDEOS.length);
}

function getCollaboratorVideos() {
  return ALL_VIDEOS.filter(video => video.sectionId === "market");
}

function buildRunVideoOrder(mode = "friday") {
  if (mode === "demo") {
    // Round-robin random samples guarantee representation from every set.
    const videos = getCollaboratorVideos();
    const groups = [...new Set(videos.map(video => video.sourceGroup))];
    const pools = shuffleList(groups).map(group => shuffleList(videos.filter(video => video.sourceGroup === group)));
    const selected = [];
    while (selected.length < Math.min(DEMO_VIDEO_COUNT, videos.length)) {
      for (const pool of pools) {
        if (pool.length && selected.length < DEMO_VIDEO_COUNT) selected.push(pool.pop().id);
      }
    }
    return shuffleList(selected);
  }
  if (mode === "quiz") {
    return buildQuizRunVideoOrder();
  }

  if (mode === "quick") {
    return buildQuickQuizRun().videoOrder;
  }

  return VIDEOS.map((video) => video.id);
}

function isCurrentRunCompatible(run) {
  if (!run) {
    return false;
  }

  if (run.mode === "endless") return isValidEndlessRun(run);

  if (run.mode === "demo") {
    return Array.isArray(run.videoOrder) && run.videoOrder.length === Math.min(DEMO_VIDEO_COUNT, getCollaboratorVideos().length) && new Set(run.videoOrder).size === run.videoOrder.length && run.videoOrder.every(id => ALL_VIDEOS_BY_ID[id]?.sectionId === "market");
  }

  if (run.mode === "quiz") {
    return Array.isArray(run.videoOrder) &&
      run.videoOrder.length === QUIZ_VIDEO_COUNT &&
      run.videoOrder.every((videoId) => Boolean(ALL_VIDEOS_BY_ID[videoId]));
  }

  if (run.mode === "quick") {
    return Array.isArray(run.videoOrder) &&
      run.videoOrder.length === getQuickQuizVideoCount() &&
      run.videoGroups && typeof run.videoGroups === "object" &&
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
    ALL_VIDEOS.filter((video) => video.sectionId === "market" && video.correctChoice === "track"),
  ).slice(0, QUIZ_TRACK_COUNT);
  const cascadeVideos = shuffleList(
    ALL_VIDEOS.filter((video) => video.sectionId === "market" && video.correctChoice === "cascade"),
  ).slice(0, QUIZ_CASCADE_COUNT);

  return shuffleList([...trackVideos, ...cascadeVideos]).map((video) => video.id);
}

function buildQuickQuizRun() {
  const lowEnergyVideos = ALL_VIDEOS.filter((video) => video.sectionId === "low-energy" && video.pidGroup);
  const eligibleVideos = lowEnergyVideos.filter(isQuickQuizEligibleVideo);

  if (eligibleVideos.length) {
    return {
      videoOrder: shuffleList(eligibleVideos).map((video) => video.id),
      videoGroups: Object.fromEntries(
        eligibleVideos.map((video) => [video.id, `pid-${video.pidGroup}`]),
      ),
    };
  }

  const candidates = ALL_VIDEOS.filter((video) => typeof video.pid === "number");
  const uncertainPool = [...candidates].sort(
    (left, right) => Math.abs(left.pid - 0.5) - Math.abs(right.pid - 0.5),
  );
  const uncertainVideos = sampleBalancedQuickVideos(uncertainPool, QUICK_QUIZ_GROUP_SIZE);
  const usedVideoIds = new Set(uncertainVideos.map((video) => video.id));
  const remainingVideos = candidates.filter((video) => !usedVideoIds.has(video.id));
  const goodVideos = sampleBalancedQuickVideos(
    remainingVideos
      .filter((video) => isPidCorrect(video))
      .sort((left, right) => getPidConfidence(right) - getPidConfidence(left)),
    QUICK_QUIZ_GROUP_SIZE,
  );

  goodVideos.forEach((video) => usedVideoIds.add(video.id));

  const badVideos = sampleBalancedQuickVideos(
    remainingVideos
      .filter((video) => !usedVideoIds.has(video.id) && !isPidCorrect(video))
      .sort((left, right) => getPidConfidence(right) - getPidConfidence(left)),
    QUICK_QUIZ_GROUP_SIZE,
  );

  const groups = [
    { ...QUICK_QUIZ_GROUPS[0], videos: goodVideos },
    { ...QUICK_QUIZ_GROUPS[1], videos: uncertainVideos },
    { ...QUICK_QUIZ_GROUPS[2], videos: badVideos },
  ];
  const videoGroups = Object.fromEntries(
    groups.flatMap((group) => group.videos.map((video) => [video.id, group.id])),
  );

  return {
    videoOrder: shuffleList(groups).flatMap((group) => shuffleList(group.videos).map((video) => video.id)),
    videoGroups,
  };
}

function getQuickQuizVideoCount() {
  if (!ALL_VIDEOS.length) {
    return Object.entries(QUICK_QUIZ_BASELINE_RESULTS).filter(
      ([eventId, { correct, total }]) => {
        return correct / total >= QUICK_QUIZ_MIN_SUCCESS_RATE || QUICK_QUIZ_FIFTY_PERCENT_EVENT_IDS.has(eventId);
      },
    ).length;
  }

  return ALL_VIDEOS.filter(
    (video) => video.sectionId === "low-energy" && isQuickQuizEligibleVideo(video),
  ).length;
}

function isQuickQuizEligibleVideo(video) {
  const eventId = extractEventId(video.id);
  const baseline = QUICK_QUIZ_BASELINE_RESULTS[eventId];
  return Boolean(
    baseline && (
      baseline.correct / baseline.total >= QUICK_QUIZ_MIN_SUCCESS_RATE ||
      QUICK_QUIZ_FIFTY_PERCENT_EVENT_IDS.has(eventId)
    ),
  );
}

function sampleBalancedQuickVideos(videos, count) {
  const trackVideos = videos.filter((video) => video.correctChoice === "track");
  const cascadeVideos = videos.filter((video) => video.correctChoice === "cascade");
  const targetTrackCount = Math.ceil(count / 2);
  const targetCascadeCount = Math.floor(count / 2);
  const selected = [
    ...shuffleList(trackVideos).slice(0, targetTrackCount),
    ...shuffleList(cascadeVideos).slice(0, targetCascadeCount),
  ];

  if (selected.length < count) {
    const selectedIds = new Set(selected.map((video) => video.id));
    selected.push(...shuffleList(videos.filter((video) => !selectedIds.has(video.id))).slice(0, count - selected.length));
  }

  return selected.slice(0, count);
}

function isPidCorrect(video) {
  return video.correctChoice === "track" ? video.pid >= 0.5 : video.pid < 0.5;
}

function getPidConfidence(video) {
  return Math.abs(video.pid - 0.5) * 2;
}

function getQuickQuizGroup(run, videoId) {
  const groupId = run?.videoGroups?.[videoId];
  return QUICK_QUIZ_GROUPS.find((group) => group.id === groupId) || QUICK_QUIZ_GROUPS[1];
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
  if (mode === "endless") return state.endlessPlayers.filter(player => endlessBoardQuestions(player) > 0);
  return mode === "demo" ? state.demoPlayers : mode === "quiz"
    ? state.quizPlayers
    : mode === "quick"
      ? state.quickQuizPlayers
      : state.players;
}

function getQuickQuizReportRecords(records) {
  return records.filter((record) => !record.isSeedData);
}

function getActiveMode() {
  if (state.currentRun?.mode) {
    return state.currentRun.mode;
  }

  if (state.lastCompletedRun?.mode) {
    return state.lastCompletedRun.mode;
  }

  return ["demo", "quiz", "quick", "friday", "endless"].includes(state.selectedMode) ? state.selectedMode : "demo";
}

function selectMode(mode) {
  if (!MODE_CONFIGS[mode] || state.currentRun) {
    return;
  }

  state.selectedMode = mode;
  state.lastCompletedRun = null;
  saveStorage(STORAGE_KEYS.selectedMode, mode);
  const url = new URL(window.location.href);
  url.searchParams.set("mode", mode);
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  render();
  void syncAllDataFromServer({force: true});
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
  // Telemetry is bounded during outages; completed scores use their durable queue.
  if (analyticsQueue.length > 500) analyticsQueue.splice(0, analyticsQueue.length - 500);
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
  if (!analyticsQueue.length || analyticsFlushing) return;
  const events = analyticsQueue.splice(0, 100);
  let payload = JSON.stringify({events});
  // Browsers share a 64 KiB allowance for beacon and keepalive requests.
  while (events.length > 1 && new Blob([payload]).size > 60000) {
    analyticsQueue.unshift(events.pop());
    payload = JSON.stringify({events});
  }
  if (useBeacon && navigator.sendBeacon) {
    if (!navigator.sendBeacon(API_ANALYTICS_EVENTS_URL, new Blob([payload], {type: "application/json"}))) analyticsQueue.unshift(...events);
    return;
  }
  analyticsFlushing = true;
  try {
    const response = await fetch(API_ANALYTICS_EVENTS_URL, {
      method: "POST", headers: {"Content-Type": "application/json"}, body: payload, keepalive: true,
    });
    if (!response.ok) throw new Error(`Failed to persist analytics events: ${response.status}`);
    const result = await response.json();
    if (result.summary) applyAnalyticsPayload(result);
    state.analyticsError = null;
  } catch (error) {
    analyticsQueue.unshift(...events);
    if (analyticsQueue.length > 500) analyticsQueue.splice(0, analyticsQueue.length - 500);
  } finally {
    analyticsFlushing = false;
    if (analyticsQueue.length) scheduleAnalyticsFlush();
  }
}

function getCombinedVideoLineStats(videoId, players) {
  const seededCounts = getSeededLineCounts(videoId);
  const answers = players.flatMap((player) =>
    player.answers.filter((answer) => answer.videoId === videoId),
  );
  const counts = players.crowdStats ? (players.crowdStats[videoId] || {trackCount: 0, cascadeCount: 0, correctCount: 0}) : null;
  const liveTrackCount = counts ? counts.trackCount : answers.filter((answer) => answer.choice === "track").length;
  const liveCascadeCount = counts ? counts.cascadeCount : answers.filter((answer) => answer.choice === "cascade").length;
  const trackCount = seededCounts.trackCount + liveTrackCount;
  const cascadeCount = seededCounts.cascadeCount + liveCascadeCount;
  const totalResponses = trackCount + cascadeCount;
  const liveCorrectCount = counts ? counts.correctCount : answers.filter((answer) => answer.correct).length;
  const seededCorrectCount = getSeededCorrectCount(videoId, seededCounts);
  const feedVote = totalResponses < 3 ? getQuickQuizFeedVoteAverage(videoId) : null;
  const weightedTrackCount = trackCount + (feedVote?.track ?? 0);
  const weightedCascadeCount = cascadeCount + (feedVote?.cascade ?? 0);
  const weightedTotalResponses = totalResponses + (feedVote ? 1 : 0);

  return {
    trackCount,
    cascadeCount,
    totalResponses,
    trackPercentage: weightedTotalResponses ? weightedTrackCount / weightedTotalResponses : 0.5,
    cascadePercentage: weightedTotalResponses ? weightedCascadeCount / weightedTotalResponses : 0.5,
    accuracy: totalResponses
      ? (seededCorrectCount + liveCorrectCount) / totalResponses
      : 0,
  };
}

function getQuickQuizFeedVoteAverage(videoId) {
  const baseline = QUICK_QUIZ_BASELINE_RESULTS[extractEventId(videoId)];
  const expectedChoice = getExpectedChoice(videoId);

  if (!baseline || !expectedChoice || !baseline.total) {
    return null;
  }

  const correctShare = baseline.correct / baseline.total;
  const trackShare = expectedChoice === "track" ? correctShare : 1 - correctShare;

  return {
    track: trackShare,
    cascade: 1 - trackShare,
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
  if (state.showAnalysis && state.reportStatus?.[getReportMode()] === "loading") return;
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
      rows: buildQuizAnswerRows(state.quizHistory).map((row) => ({
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
    "quick-quiz-pid-groups": {
      fileName: "4.0-quick-quiz-pid-groups.csv",
      rows: buildQuickQuizGroupRows(getQuickQuizReportRecords(state.quickQuizHistory)).map((row) => ({
        player: row.name,
        result_set: row.groupLabel,
        correct: row.correct,
        total: row.total,
        accuracy: decimalPercent(row.accuracy),
        completed_at: row.completedAt,
      })),
    },
    "quick-quiz-user-summary": {
      fileName: "4.0-quick-quiz-user-summary.csv",
      rows: buildQuizSummaryRows(getQuickQuizReportRecords(state.quickQuizPlayers)).map((row) => ({
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
    "quick-quiz-answer-detail": {
      fileName: "4.0-quick-quiz-answer-detail.csv",
      rows: buildQuizAnswerRows(getQuickQuizReportRecords(state.quickQuizHistory)).map((row) => ({
        player: row.name,
        video: row.videoLabel,
        pid_group: row.category,
        pid: row.pid,
        choice: row.choice,
        correct_answer: row.expectedChoice,
        correct: row.correct,
        response_seconds: row.responseSeconds,
        clip_time_at_pick_seconds: row.videoCurrentTimeSeconds,
        completed_at: row.completedAt,
      })),
    },
    "quick-quiz-growth": {
      fileName: "4.0-quick-quiz-growth.csv",
      rows: buildGrowthRows(getQuickQuizReportRecords(state.quickQuizHistory), "quick").map((row) => ({
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

  const definition = report?.startsWith("detail-") ? getDetailedReportDefinitions()[report.slice(7)] : definitions[report];

  if (!definition) {
    return;
  }

  const csv = serializeCsv(definition.rows, definition.columns?.map(column => column[0]));
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

function serializeCsv(rows, headers = Object.keys(rows[0] || {})) {
  if (!headers.length) return "";
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
  const stringValue = typeof value === "string" && /^[=+@\-\t\r]/.test(value) ? `'${value}` : `${value ?? ""}`;

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
    mode: ["demo", "quiz", "quick", "endless"].includes(run.mode) ? run.mode : "friday",
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
  if (typeof queueAccountSave === "function" && Object.values(STORAGE_KEYS).includes(key)) queueAccountSave();
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


function getCrowdPlayers(mode) {
  if (mode === "endless") { const players = []; players.crowdStats = state.endlessCrowdStats || {}; return players; }
  if (mode !== "demo") return getPlayersForMode(mode);
  const records = [...state.playerHistory, ...state.players, ...state.quizHistory, ...state.quizPlayers, ...state.quickQuizHistory, ...state.quickQuizPlayers, ...state.demoHistory, ...state.demoPlayers];
  const players = [...new Map(records.filter(player => !player.isSeedData).map(player => [player.id, player])).values()];
  if (state.demoPlayers.crowdStats) players.crowdStats = state.demoPlayers.crowdStats;
  return players;
}

function getCurrentChoiceLines() {
  const run = state.currentRun;
  const video = run && getVideoForRunIndex(run, run.currentIndex);
  return video ? getPublicLines(video.id, getCrowdPlayers(run.mode)) : null;
}

function getCrowdBonus(lines, choice, correct) {
  if (!correct || !lines || !["track", "cascade"].includes(choice) || lines.totalResponses <= 0) return 0;
  const count = choice === "track" ? lines.trackCount : lines.cascadeCount;
  return Number.isFinite(count) && count / lines.totalResponses < 0.25 ? CROWD_BONUS_COINS : 0;
}

function renderCrowdBonusFeedback(answer) {
  return answer.correct && answer.crowdBonus ? `<div class="crowd-bonus-celebration" role="status"><span aria-hidden="true">✦</span><div><strong>Against the crowd! +${answer.crowdBonus} bonus coins</strong><p>Under 25% of recorded votes chose ${titleCase(answer.choice)} before your pick. Your correct, independent call earns a bonus on top of your correct-answer reward.</p></div></div>` : "";
}

function renderGameMechanics() {
  return `<div class="demo-mechanics">
    <article><span class="mechanic-number">01</span><strong>Make the call</strong><p>Start with 10 coins. Correct: +1. Incorrect: −1. Watch, replay, then choose.</p></article>
    <article><span class="mechanic-number">02</span><strong>Build a hot hand</strong><p>After two correct calls in a row, each next correct call earns +2 until you miss.</p></article>
    <article><span class="mechanic-number">03</span><strong>Raise the stakes</strong><p>Double or Nothing: +2 on a hit, −2 on a miss. A hot-hand hit earns +3.</p></article>
    <article><span class="mechanic-number">04</span><strong>Go against the crowd</strong><p>Choose an answer with under 25% of recorded votes for +2 extra coins when your answer is correct. No votes means no bonus.</p></article>
  </div>`;
}

function renderDemoLandingContent() {
  return {
    hero: `<p class="eyebrow">Collaborator Game · 5-question run</p><h2 class="hero-title">Can you spot a neutrino’s signature?</h2><p class="hero-copy">Read the light. Call the shape. See how your eye compares with the crowd.</p><div class="demo-facts"><span>5 questions per run</span><span>100 clips · 4 video sets</span><span>A fresh mix every time</span></div>${renderStartForm({buttonLabel: MODE_CONFIGS.demo.startButtonLabel, helperCopy: "Five random clips from the new 100-video catalog, covering all four sets. Completed runs join the global collaborator leaderboard, shared across devices and separate from the research leaderboards."})}`,
    aside: `<div class="demo-aside-heading"><p class="eyebrow">How the game works</p><h3 class="card-title">Every call counts.</h3></div>${renderGameMechanics()}`,
  };
}

function renderIntro() {
  const root = document.querySelector("#intro-modal-root");
  if (!root) return;
  document.querySelector(".page-shell").inert = state.showIntro;
  document.body.classList.toggle("intro-open", state.showIntro);
  if (!state.showIntro) { root.innerHTML = ""; return; }
  if (root.childElementCount) return;
  root.innerHTML = `<div class="intro-backdrop"><section class="intro-panel" role="dialog" aria-modal="true" aria-labelledby="intro-title" aria-describedby="intro-description" tabindex="-1">
    <div class="intro-heading"><div><p class="eyebrow">IceCube science × human intuition</p><h2 id="intro-title">Game That<br><span>Neutrino</span></h2></div><div class="intro-heading-actions"><span class="intro-badge">${getActiveMode() === "endless" ? "Endless Mode" : "Collaborator Game"}</span><button type="button" class="ghost-button" data-action="close-intro" aria-label="Try Game That Neutrino">Try Game That Neutrino →</button></div></div>
    <p class="intro-lead" id="intro-description">A particle from the universe leaves a pattern of light in Antarctic ice. Can you tell what happened?</p>
    <div class="intro-science"><div><h3>The science behind the signal</h3><p>Neutrinos rarely interact with matter. When one interacts in or near IceCube, secondary charged particles can emit Cherenkov light. The detector’s sensors record that light; these event displays let you inspect its shape.</p><p>This game turns visual classification into a learning experience: compare your observation with the answer key and the crowd’s choices.</p><a href="https://icecube.wisc.edu/science/icecube/" target="_blank" rel="noopener noreferrer">Explore the IceCube science ↗</a></div><div class="intro-shapes"><article><div class="signature-track" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><strong>Track</strong><p>An elongated trail, often made by a muon moving through the ice.</p></article><article><div class="signature-cascade" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><strong>Cascade</strong><p>A compact shower of particles, lighting up around an interaction.</p></article></div></div>
    <div class="intro-game-heading"><p class="eyebrow">Your mission</p><h3>Watch. Classify. Collect coins.</h3><p>${getActiveMode() === "endless" ? "Keep classifying for as long as you like. Pause and save your run whenever you need a break." : "Play 5 random clips drawn from every set. Track or Cascade? Make your call and get instant feedback."}</p></div>
    ${renderGameMechanics()}
    <p class="subtle-copy">Earn gold trophies and compare achievement totals across all modes.</p>
    <div class="intro-bottom"><div class="intro-credits"><span>Created by <strong>Peter Tzimoulis</strong></span><span>Credits &amp; acknowledgments: <a href="https://www.zooniverse.org/projects/icecubeobservatory/name-that-neutrino" target="_blank" rel="noopener noreferrer"><strong>Name That Neutrino</strong> on Zooniverse ↗</a> · <span>Drexel University</span> · <strong>IceCube Collaboration</strong></span></div><button type="button" class="primary-button" data-action="close-intro">Start playing →</button></div>
  </section></div>`;
  requestAnimationFrame(() => root.querySelector(".intro-panel")?.focus());
}

function longestCorrectStreak(answers) {
  let longest = 0, current = 0;
  for (const answer of answers) { current = answer.correct ? current + 1 : 0; longest = Math.max(longest, current); }
  return longest;
}

function achievementConditions(run, completed = false) {
  const answers = run.answers || [];
  const correct = answers.filter(answer => answer.correct);
  const classes = new Set(correct.map(answer => answer.expectedChoice || getExpectedChoice(answer.videoId)));
  return {
    "first-call": run.mode === "endless" ? run.totalCorrect > 0 : correct.length > 0,
    "hot-hand": run.mode === "endless" ? run.bestStreak >= 3 : longestCorrectStreak(answers) >= 3,
    "independent": correct.some(answer => answer.crowdBonus > 0),
    "keen-eye": run.mode === "endless" ? run.trackCorrect > 0 && run.cascadeCorrect > 0 : classes.has("track") && classes.has("cascade"),
    "demo-complete": completed && run.mode === "demo" && answers.length === DEMO_VIDEO_COUNT,
    "perfect-demo": completed && run.mode === "demo" && answers.length === DEMO_VIDEO_COUNT && correct.length === DEMO_VIDEO_COUNT,
    "finisher": completed && (run.mode === "endless" ? run.totalQuestions > 0 : answers.length === getRunVideoCount(run)),
    "explorer": completed && run.mode === "demo" && [...new Set(getCollaboratorVideos().map(video => video.sourceGroup))].every(group => answers.some(answer => answer.sourceGroup === group)),
    "endless-10": run.mode === "endless" && run.totalQuestions >= 10,
    "endless-50": run.mode === "endless" && run.totalQuestions >= 50,
    "endless-100": run.mode === "endless" && run.totalQuestions >= 100,
    "endless-250": run.mode === "endless" && run.totalQuestions >= 250,
    "endless-streak-10": run.mode === "endless" && run.bestStreak >= 10,
    "endless-correct-100": run.mode === "endless" && run.totalCorrect >= 100,
  };
}

function evaluateAchievements(run, completed = false) {
  const key = normalizeName(run.name);
  const profile = state.localTrophies[key] || {name: run.name, nameKey: key, unlocked: [], synced: true};
  const conditions = achievementConditions(run, completed);
  const earned = ACHIEVEMENTS.filter(item => conditions[item.id] && !profile.unlocked.includes(item.id));
  if (!earned.length) return;
  profile.unlocked.push(...earned.map(item => item.id));
  profile.synced = false;
  state.localTrophies[key] = profile;
  run.unlockedAchievementIds = [...new Set([...(run.unlockedAchievementIds || []), ...earned.map(item => item.id)])];
  state.trophyNotice = [...new Set([...state.trophyNotice, ...earned.map(item => item.id)])];
  saveStorage(STORAGE_KEYS.trophies, state.localTrophies);
  void syncAchievements();
}

async function syncAchievements() {
  if (state.syncingAchievements) return;
  state.syncingAchievements = true;
  const owner = progressStorageOwner;
  try {
    let payload = state.showAchievements ? await fetchSharedJson("/api/achievements") : {profiles: [], partial: true};
    if (owner !== progressStorageOwner) return;
    const mergeProfiles = (profiles, partial = false) => {
      state.trophyProfiles = partial
        ? [...new Map([...state.trophyProfiles, ...(profiles || [])].map(profile => [profile.nameKey, profile])).values()]
        : (Array.isArray(profiles) ? profiles : []);
      for (const remote of state.trophyProfiles) {
        const key = normalizeName(remote.name);
        const local = state.localTrophies[key];
        if (local) {
          local.unlocked = [...new Set([...local.unlocked, ...remote.unlocked])];
          local.synced = local.unlocked.every(id => remote.unlocked.includes(id));
        } else state.localTrophies[key] = {...remote, synced: true};
      }
    };
    mergeProfiles(payload.profiles, payload.partial);
    for (const profile of Object.values(state.localTrophies).filter(item => !item.synced)) {
      const submitted = [...profile.unlocked];
      const posted = await fetch("/api/achievements", {method: "POST", headers: {"Content-Type": "application/json", "X-Neutrino-State-Epoch": GAME_STATE_EPOCH}, body: JSON.stringify({name: profile.name, unlocked: submitted})});
      if (!posted.ok) throw new Error("Could not sync trophies");
      payload = await posted.json();
      if (owner !== progressStorageOwner) return;
      mergeProfiles(payload.profiles, payload.partial);
    }
    state.trophiesLoaded = true;
    state.trophiesError = false;
  } catch (error) {
    state.trophiesError = true;
  } finally {
    state.syncingAchievements = false;
    if (owner === progressStorageOwner) saveStorage(STORAGE_KEYS.trophies, state.localTrophies);
    renderAchievementOverlays();
  }
}

function closeAchievements() {
  state.showAchievements = false;
  renderAchievementOverlays();
  (state.achievementReturnFocus?.isConnected ? state.achievementReturnFocus : document.querySelector(".trophy-nav"))?.focus();
}

function renderAchievementOverlays() {
  const root = document.querySelector("#achievement-modal-root");
  const toastRoot = document.querySelector("#achievement-toast-root");
  if (!root || !toastRoot) return;
  const page = document.querySelector(".page-shell");
  if (page) page.inert = state.showIntro || state.showAchievements || (typeof accountState !== "undefined" && accountState.show);
  document.body.classList.toggle("achievements-open", state.showAchievements);
  if (state.showAchievements) {
    const restoreDialogFocus = root.contains(document.activeElement);
    const name = state.currentRun?.name || state.lastCompletedRun?.name || state.lastName;
    const profile = name ? state.localTrophies[normalizeName(name)] : null;
    const unlocked = getActiveAchievementIds(profile);
    const board = state.trophyProfiles.map(entry => ({...entry, unlocked: getActiveAchievementIds(entry)})).filter(entry => entry.unlocked.length).sort((a, b) => b.unlocked.length - a.unlocked.length || a.name.localeCompare(b.name));
    root.innerHTML = `<div class="modal-backdrop is-open trophy-backdrop"><section class="achievement-dialog" id="achievement-dialog" role="dialog" aria-modal="true" aria-labelledby="achievement-title" tabindex="-1"><div class="table-caption"><div><p class="eyebrow">The trophy cabinet</p><h2 class="card-title" id="achievement-title">🏆 Achievements</h2></div><button type="button" class="ghost-button" data-action="close-achievements" aria-label="Close achievements">Close ×</button></div><p class="subtle-copy">${name ? `${escapeHtml(name)} · ${unlocked.length} of ${ACHIEVEMENTS.length} unlocked` : "Enter a player name and start a run to collect trophies."} · All game modes count. Use the same name to continue your collection.</p><div class="achievement-grid">${ACHIEVEMENTS.map(item => `<article class="achievement-card ${unlocked.includes(item.id) ? "is-unlocked" : "is-locked"}"><span class="trophy-icon" aria-hidden="true">🏆</span><div><strong>${item.title}</strong><p>${item.description}</p><span>${unlocked.includes(item.id) ? "Unlocked" : "Locked"}</span></div></article>`).join("")}</div><h3 class="card-title trophy-board-title">Most achievements · shared leaderboard</h3><p class="subtle-copy">${state.trophiesError ? "Shared board is temporarily unavailable. New trophies are saved on this device and will retry syncing." : state.syncingAchievements ? "Syncing trophies…" : "One entry per player name. Ranked by total unique trophies; ties share a rank."}</p>${board.length ? `<div class="leaderboard-scroll"><table class="leaderboard-table"><thead><tr><th>Rank</th><th>Player</th><th>Trophies</th></tr></thead><tbody>${board.map(entry => `<tr ${entry.nameKey === normalizeName(name || "") ? 'class="is-current-player"' : ""}><td>${board.findIndex(other => other.unlocked.length === entry.unlocked.length) + 1}</td><td>${escapeHtml(entry.name)}</td><td>🏆 ${entry.unlocked.length} / ${ACHIEVEMENTS.length}</td></tr>`).join("")}</tbody></table></div>` : `<p class="empty-note">${state.trophiesLoaded ? "Be the first to earn a trophy." : "Loading shared standings…"}</p>`}</section></div>`;
    if (restoreDialogFocus) root.querySelector("#achievement-dialog")?.focus();
  } else root.innerHTML = "";
  const earned = ACHIEVEMENTS.filter(item => state.trophyNotice.includes(item.id));
  toastRoot.innerHTML = !state.showIntro && !state.showAchievements && earned.length ? `<aside class="achievement-toast" role="status" aria-live="polite"><span class="gold-trophy" aria-hidden="true">🏆</span><div><p class="eyebrow">${earned.length > 1 ? `${earned.length} achievements unlocked` : "Achievement unlocked"}</p><strong>${earned.map(item => item.title).join(" · ")}</strong><div class="trophy-toast-actions"><button type="button" data-action="open-achievements">View trophies</button><button type="button" data-action="dismiss-trophies" aria-label="Dismiss achievement notification">Dismiss ×</button></div></div></aside>` : "";
}

function renderRunInsights(run) {
  const answers = run.answers || [];
  const missed = answers.filter(answer => !answer.correct);
  const countFor = kind => answers.filter(answer => (answer.expectedChoice || getExpectedChoice(answer.videoId)) === kind);
  const classFeedback = ["track", "cascade"].map(kind => {
    const items = countFor(kind);
    return `<div><span>${titleCase(kind)} recognition</span><strong>${items.filter(answer => answer.correct).length} / ${items.length}</strong><p>${items.length ? `${formatPercent(items.filter(answer => answer.correct).length / items.length)} correct` : "No examples in this run"}</p></div>`;
  }).join("");
  const coins = answers.filter(answer => typeof answer.coinsAfter === "number");
  const base = coins.reduce((sum, answer) => sum + (answer.correct ? 1 : -1), 0);
  const hot = coins.filter(answer => answer.streakBonusApplied).length;
  const wager = coins.reduce((sum, answer) => sum + (answer.doubleDown ? (answer.correct ? 1 : -1) : 0), 0);
  const crowd = coins.reduce((sum, answer) => sum + (answer.crowdBonus || 0), 0);
  const signed = value => `${value >= 0 ? "+" : ""}${value}`;
  const earned = ACHIEVEMENTS.filter(item => run.unlockedAchievementIds?.includes(item.id));
  return `<section class="run-insights"><p class="eyebrow">Your run, explained</p><h3 class="card-title">${missed.length ? "A few patterns to revisit" : "Every call matched the answer key"}</h3><p class="subtle-copy">${missed.length ? "Replay the missed clips below. Look for an extended trail in Track events and a compact light shower in Cascades." : "Try a fresh mix to see whether you can keep that accuracy."} Your longest streak was ${longestCorrectStreak(answers)} correct call${longestCorrectStreak(answers) === 1 ? "" : "s"}.</p><div class="insight-grid">${classFeedback}</div>${coins.length ? `<div class="coin-breakdown"><strong>Coin breakdown</strong><span>Answers ${signed(base)}</span><span>Hot hand +${hot}</span><span>Wagers ${signed(wager)}</span><span>Crowd +${crowd}</span><b>Net ${signed(base + hot + wager + crowd)}</b></div>` : ""}${earned.length ? `<p class="run-trophy-summary">🏆 New this run: ${earned.map(item => item.title).join(" · ")}</p>` : ""}<button type="button" class="secondary-button" data-action="open-achievements">🏆 View achievements &amp; standings</button>${!["quiz", "quick"].includes(run.mode) && missed.length ? `<details class="missed-review"><summary>Replay ${missed.length} missed clip${missed.length === 1 ? "" : "s"}</summary><div class="quiz-review-grid">${missed.map(answer => renderQuizReviewCard({...answer, expectedChoice: answer.expectedChoice || getExpectedChoice(answer.videoId)})).join("")}</div></details>` : ""}</section>`;
}

window.setInterval(() => {
  if (document.visibilityState !== "hidden" && (state.showAchievements || Object.values(state.localTrophies).some(profile => !profile.synced))) void syncAchievements();
}, PLAYER_SYNC_INTERVAL_MS);


function renderMobileVoteContext(lines) {
  return `<p class="mobile-vote-context">${lines?.totalResponses ? `Crowd: ${lines.totalResponses} recorded pick${lines.totalResponses === 1 ? "" : "s"}. Correct minority calls can earn +2.` : "Reference percentages · no recorded votes yet. Crowd bonus needs live votes."}</p>`;
}


function getActiveAchievementIds(profile) {
  // Retain historical trophy data while counting only current game goals.
  return ACHIEVEMENTS.filter(item => profile?.unlocked?.includes(item.id)).map(item => item.id);
}


function loadPendingCollaboratorRuns() {
  const pending = loadStorage(STORAGE_KEYS.pendingCollaboratorRuns, []);
  const runs = Array.isArray(pending) ? pending : [];
  if (!loadStorage(STORAGE_KEYS.collaboratorMigration, false)) {
    const legacy = loadStorage(STORAGE_KEYS.demoPlayers, []);
    if (Array.isArray(legacy)) runs.push(...legacy.filter(run => run?.completedAt && run.answers?.length === DEMO_VIDEO_COUNT));
    saveStorage(STORAGE_KEYS.pendingCollaboratorRuns, [...new Map(runs.map(run => [run.id, run])).values()]);
    saveStorage(STORAGE_KEYS.collaboratorMigration, true);
  }
  return [...new Map(runs.map(run => [run.id, run])).values()];
}

function applyCollaboratorPayload(payload) {
  applyBoardData(payload, "demoPlayers", "demoHistory");
  state.collaboratorLeaderboardLoaded = true;
  state.collaboratorLeaderboardError = null;
  state.collaboratorDataVersion = payload.updatedAt || null;
}

async function syncCollaboratorPlayersFromServer() {
  if (state.syncingCollaboratorPlayers) return;
  state.syncingCollaboratorPlayers = true;
  const previousVersion = state.collaboratorDataVersion;
  const previouslyLoaded = state.collaboratorLeaderboardLoaded;
  const hadError = Boolean(state.collaboratorLeaderboardError);
  const owner = progressStorageOwner;
  let uploaded = false;
  try {
    applyCollaboratorPayload(await fetchLeaderboardData(API_COLLABORATOR_PLAYERS_URL, "demo"));
    if (owner !== progressStorageOwner) return;
    // Remove a run only after the server confirms persistence. IDs make retries safe.
    for (const record of [...state.pendingCollaboratorRuns]) {
      const posted = await fetch(API_COLLABORATOR_PLAYERS_URL, {method: "POST", headers: {"Content-Type": "application/json", "X-Neutrino-State-Epoch": GAME_STATE_EPOCH}, body: JSON.stringify(record)});
      if (!posted.ok) throw new Error("Could not upload a completed collaborator run. It is saved on this device and will retry.");
      applyCollaboratorPayload(await posted.json());
      if (owner !== progressStorageOwner) return;
      state.pendingCollaboratorRuns = state.pendingCollaboratorRuns.filter(run => run.id !== record.id);
      saveStorage(STORAGE_KEYS.pendingCollaboratorRuns, state.pendingCollaboratorRuns);
      uploaded = true;
    }
  } catch (error) {
    state.collaboratorLeaderboardError = error instanceof Error ? error.message : "Global collaborator standings are temporarily unavailable.";
  } finally {
    state.syncingCollaboratorPlayers = false;
    if ((uploaded || state.showAnalysis || !previouslyLoaded || hadError || state.collaboratorLeaderboardError || previousVersion !== state.collaboratorDataVersion) && (!state.currentRun || state.showAnalysis || state.lastCompletedRun)) render();
  }
}

function renderCollaboratorSyncStatus() {
  if (state.collaboratorLeaderboardError) return `<p class="subtle-copy" role="status">${escapeHtml(state.collaboratorLeaderboardError)}${state.pendingCollaboratorRuns.length ? " Completed runs stay saved here until they sync." : " We will retry automatically."}</p>`;
  if (state.pendingCollaboratorRuns.length) return `<p class="subtle-copy" role="status">Uploading ${state.pendingCollaboratorRuns.length} saved run${state.pendingCollaboratorRuns.length === 1 ? "" : "s"} to the global leaderboard…</p>`;
  if (!state.collaboratorLeaderboardLoaded) return `<p class="subtle-copy" role="status">Loading global standings…</p>`;
  return `<p class="subtle-copy">Shared across all devices · latest score per player name · refreshes automatically.</p>`;
}

function getCollaboratorRunStatus(run) {
  return state.pendingCollaboratorRuns.some(record => record.id === run.id)
    ? "Your run is saved on this device and is waiting to upload to the global collaborator leaderboard."
    : "Your score is saved in the global collaborator leaderboard. Try another random mix or compare your calls with the crowd.";
}

window.addEventListener("online", () => { void syncCollaboratorPlayersFromServer(); });
