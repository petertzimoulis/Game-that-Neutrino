const RUN_VIDEO_COUNT = 15;
const MAX_ANALYTICS_EVENTS = 5000;
const MAX_RECENT_ANALYTICS_EVENTS = 250;
const ROTATION_TIMEZONE = "America/New_York";
const FIRST_ROTATION_DATE = "2026-05-01";
const MANIFEST_SOURCES = [
  ["ntn_4.0_100_videos (1)", "manifest.csv"],
];
const GITHUB_API_ROOT = "https://api.github.com";
const GITHUB_RAW_ROOT = "https://raw.githubusercontent.com";
const REPOSITORY_OWNER = "petertzimoulis";
const REPOSITORY_NAME = "Game-that-Neutrino";
const REPOSITORY_BRANCH = "main";
const GAME_STATE_EPOCH = "reset-20261015-1";
const GAME_DATA_ROOT = `data/${GAME_STATE_EPOCH}`;
const GAME_WRITE_PATHS = new Set(["/api/players", "/api/collaborator-players", "/api/quiz-players", "/api/quick-quiz-players", "/api/achievements", "/api/endless-players"]);
const FRIDAY_DB_PATH = `${GAME_DATA_ROOT}/shared_leaderboard.json`;
const QUIZ_DB_PATH = `${GAME_DATA_ROOT}/quiz_leaderboard.json`;
const QUICK_QUIZ_DB_PATH = `${GAME_DATA_ROOT}/quick_quiz_40.json`;
const ANALYTICS_DB_PATH = "data/analytics_events.json";
const GITHUB_API_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "game-that-neutrino-sites-worker",
  "X-GitHub-Api-Version": "2022-11-28",
};

let catalogVideoIdsPromise = null;

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === "POST" && GAME_WRITE_PATHS.has(url.pathname) && request.headers.get("X-Neutrino-State-Epoch") !== GAME_STATE_EPOCH) {
        return jsonResponse({error: "The game was reset. Reload the page to start a fresh run."}, 409);
      }

      if (url.pathname === "/api/endless-players") {
        return new Response(JSON.stringify({error: "Endless leaderboards use the independent server. Local guest saves remain available."}), {
          status: 503, headers: {"Content-Type": "application/json", "Cache-Control": "no-store"},
        });
      }

      if (url.pathname === "/api/account" || url.pathname.startsWith("/api/account/") || url.pathname.startsWith("/api/auth/")) {
        return new Response(JSON.stringify({error: "Accounts are available on the independent server. You can continue as a guest here."}), {
          status: 503, headers: {"Content-Type": "application/json", "Cache-Control": "private, no-store"},
        });
      }

      if (request.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }));
      }

      if (url.pathname === "/api/achievements") {
        const path = `${GAME_DATA_ROOT}/achievements.json`;
        if (request.method === "GET") return jsonResponse(await readJsonFile(env, path, {profiles: []}));
        if (request.method === "POST") {
          const payload = await parseJsonBody(request);
          const allowed = new Set(["first-call", "hot-hand", "independent", "keen-eye", "sure-shot", "demo-complete", "perfect-demo", "finisher", "explorer", "endless-10", "endless-50", "endless-100", "endless-250", "endless-streak-10", "endless-correct-100"]);
          if (typeof payload?.name !== "string" || !payload.name.trim() || payload.name.trim().length > 80 || !Array.isArray(payload.unlocked) || !payload.unlocked.length || payload.unlocked.length > allowed.size || payload.unlocked.some(id => !allowed.has(id))) throw new HttpError(400, "Invalid achievement profile");
          const result = await updateJsonFile(env, path, {profiles: []}, async db => {
            const nameKey = payload.name.trim().toLowerCase().replace(/\s+/g, " ");
            const profiles = [...(db.profiles || [])];
            const index = profiles.findIndex(profile => profile.nameKey === nameKey);
            const old = index >= 0 ? profiles[index] : {name: payload.name.trim(), nameKey, unlocked: [], firstEarnedAt: nowIso()};
            const profile = {...old, unlocked: [...new Set([...old.unlocked, ...payload.unlocked])].sort()};
            if (index >= 0) profiles[index] = profile; else profiles.push(profile);
            const nextDb = {...db, profiles, updatedAt: nowIso()};
            return {status: 200, body: nextDb, nextDb};
          });
          return jsonResponse(result.body, result.status);
        }
        return jsonResponse({error: "Method not allowed"}, 405);
      }

      if (url.pathname === "/api/health") {
        const db = await loadCurrentFridayDb(env, request);
        return jsonResponse(
          {
            status: "ok",
            ...serializeFridayPayload(db, await loadCatalogVideoIds(env, request)),
          },
        );
      }

      if (url.pathname === "/api/players") {
        if (request.method === "GET") {
          const db = await loadCurrentFridayDb(env, request);
          return jsonResponse(
            serializeFridayPayload(db, await loadCatalogVideoIds(env, request)),
          );
        }

        if (request.method === "POST") {
          const payload = await parseJsonBody(request);
          const catalogVideoIds = await loadCatalogVideoIds(env, request);

          const responsePayload = await updateJsonFile(env, FRIDAY_DB_PATH, defaultFridayDb(), async (db) => {
            const normalizedDb = normalizeFridayDb(db, catalogVideoIds);
            const requestedCycleStart = `${payload?.cycleStart || ""}`.trim();

            if (
              requestedCycleStart &&
              requestedCycleStart !== normalizedDb.activeCycleStart
            ) {
              return {
                status: 409,
                body: {
                  error: "Weekly lineup changed. Start a fresh run for the current Friday slate.",
                  ...serializeFridayPayload(normalizedDb, catalogVideoIds),
                },
                skipWrite: true,
              };
            }

            const updatedDb = {
              ...normalizedDb,
              players: upsertPlayer(normalizedDb.players, payload, "friday"),
              history: upsertHistoryRecord(normalizedDb.history, payload),
              updatedAt: nowIso(),
            };

            return {
              status: 200,
              body: serializeFridayPayload(updatedDb, catalogVideoIds),
              nextDb: updatedDb,
            };
          });

          return jsonResponse(responsePayload.body, responsePayload.status);
        }
      }

      if (url.pathname === "/api/collaborator-players") {
        const path = `${GAME_DATA_ROOT}/collaborator_leaderboard.json`;
        const serialize = db => ({players: sortPlayers(db.players || [], "demo"), history: sortHistory(db.history || []), updatedAt: db.updatedAt || null});
        if (request.method === "GET") return jsonResponse(serialize(await readJsonFile(env, path, defaultQuizDb())));
        if (request.method === "POST") {
          const payload = await parseJsonBody(request);
          if (!payload || typeof payload.name !== "string" || !payload.name.trim() || payload.name.trim().length > 40 || typeof payload.id !== "string" || !payload.id || payload.id.length > 120 || !Array.isArray(payload.answers) || payload.answers.length !== 5 || !Number.isFinite(payload.finalCoins) || !Number.isFinite(Date.parse(payload.completedAt))) throw new HttpError(400, "Submit a complete five-question collaborator run");
          if (payload.answers.some(answer => !answer || typeof answer.videoId !== "string" || !["track", "cascade"].includes(answer.choice) || typeof answer.correct !== "boolean") || new Set(payload.answers.map(answer => answer.videoId)).size !== 5) throw new HttpError(400, "Each run needs five distinct answered clips");
          const totalCorrect = payload.answers.filter(answer => answer.correct).length;
          const record = {...payload, mode: "demo", name: payload.name.trim(), nameKey: payload.name.trim().toLowerCase().replace(/\s+/g, " "), completedAt: new Date(payload.completedAt).toISOString(), totalQuestions: 5, totalCorrect, totalAccuracy: totalCorrect / 5};
          const result = await updateJsonFile(env, path, defaultQuizDb(), async db => {
            const existing = db.players?.find(player => player.nameKey === record.nameKey);
            const players = !existing || existing.completedAt <= record.completedAt ? upsertPlayer(db.players || [], record, "demo") : db.players;
            const nextDb = {...db, players, history: upsertHistoryRecord(db.history || [], record), updatedAt: nowIso()};
            return {status: 200, body: serialize(nextDb), nextDb};
          });
          return jsonResponse(result.body, result.status);
        }
        return jsonResponse({error: "Method not allowed"}, 405);
      }

      if (url.pathname === "/api/quiz-players") {
        if (request.method === "GET") {
          const db = await loadCurrentQuizDb(env);
          return jsonResponse(
            serializeQuizPayload(db, await loadCatalogVideoIds(env, request)),
          );
        }

        if (request.method === "POST") {
          const payload = await parseJsonBody(request);
          const responsePayload = await updateJsonFile(env, QUIZ_DB_PATH, defaultQuizDb(), async (db) => {
            const normalizedDb = normalizeQuizDb(db);
            const updatedDb = {
              ...normalizedDb,
              players: upsertPlayer(normalizedDb.players, payload, "quiz"),
              history: upsertHistoryRecord(normalizedDb.history, payload),
              updatedAt: nowIso(),
            };

            return {
              status: 200,
              body: serializeQuizPayload(updatedDb, await loadCatalogVideoIds(env, request)),
              nextDb: updatedDb,
            };
          });

          return jsonResponse(responsePayload.body, responsePayload.status);
        }
      }

      if (url.pathname === "/api/quick-quiz-players") {
        if (request.method === "GET") {
          const db = await loadCurrentQuizDb(env, QUICK_QUIZ_DB_PATH);
          return jsonResponse(
            serializeQuizPayload(db, await loadCatalogVideoIds(env, request), "quick"),
          );
        }

        if (request.method === "POST") {
          const payload = await parseJsonBody(request);
          const responsePayload = await updateJsonFile(env, QUICK_QUIZ_DB_PATH, defaultQuizDb(), async (db) => {
            const normalizedDb = normalizeQuizDb(db);
            const updatedDb = {
              ...normalizedDb,
              players: upsertPlayer(normalizedDb.players, payload, "quick"),
              history: upsertHistoryRecord(normalizedDb.history, payload),
              updatedAt: nowIso(),
            };

            return {
              status: 200,
              body: serializeQuizPayload(updatedDb, await loadCatalogVideoIds(env, request), "quick"),
              nextDb: updatedDb,
            };
          });

          return jsonResponse(responsePayload.body, responsePayload.status);
        }
      }

      if (url.pathname === "/api/analytics") {
        const db = await loadCurrentAnalyticsDb(env);
        return jsonResponse(serializeAnalyticsPayload(db, url.searchParams.get("view") === "full"));
      }

      if (url.pathname === "/api/analytics-events" && request.method === "POST") {
        const payload = await parseJsonBody(request);

        if (!Array.isArray(payload?.events)) {
          return jsonResponse({ error: "Expected events array" }, 400);
        }

        const responsePayload = await updateJsonFile(
          env,
          ANALYTICS_DB_PATH,
          defaultAnalyticsDb(),
          async (db) => {
            const normalizedDb = normalizeAnalyticsDb(db);
            const updatedDb = {
              ...normalizedDb,
              events: appendAnalyticsEvents(normalizedDb.events, payload.events),
              updatedAt: nowIso(),
            };

            return {
              status: 200,
              body: serializeAnalyticsPayload(updatedDb),
              nextDb: updatedDb,
            };
          },
        );

        return jsonResponse(responsePayload.body, responsePayload.status);
      }

      return fetchRepositoryAsset(request, url.pathname);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      return jsonResponse(
        {
          error: error instanceof Error ? error.message : "Unexpected server error",
        },
        status,
      );
    }
  },
};

function jsonResponse(payload, status = 200) {
  return withCors(
    new Response(JSON.stringify(payload), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    }),
  );
}

function withCors(response) {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, X-Neutrino-State-Epoch");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Cache-Control", "no-store");
  return response;
}

async function parseJsonBody(request) {
  const text = await request.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new HttpError(400, "Invalid JSON");
  }
}

async function loadCatalogVideoIds(env, request) {
  if (!catalogVideoIdsPromise) {
    catalogVideoIdsPromise = (async () => {
      const videoIds = [];

      for (const [folderName, manifestFile] of MANIFEST_SOURCES) {
        const response = await fetchRepositoryAsset(
          request,
          buildAssetPath("videos", folderName, manifestFile),
        );

        if (!response.ok) {
          throw new Error(`Failed to load manifest ${manifestFile}`);
        }

        const csvText = await response.text();
        const rows = parseCsv(csvText);

        for (const row of rows) {
          const fileName = `${row.video || row.Video || ""}`.trim();

          if (!fileName) {
            continue;
          }

          videoIds.push(`${folderName}/${fileName}`);
        }
      }

      if (!videoIds.length) {
        throw new Error("No manifest videos were found.");
      }

      return videoIds;
    })();
  }

  return catalogVideoIdsPromise;
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

function buildAssetPath(...segments) {
  return `/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

function buildPackagedAssetPath(pathname) {
  if (!pathname || pathname === "/") {
    return "/index.html";
  }

  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

function buildRepositoryAssetUrl(pathname) {
  return `${GITHUB_RAW_ROOT}/${REPOSITORY_OWNER}/${REPOSITORY_NAME}/${REPOSITORY_BRANCH}${buildPackagedAssetPath(pathname)}`;
}

function fetchRepositoryAsset(request, pathname) {
  const assetUrl = buildRepositoryAssetUrl(pathname);
  const accept = request.headers.get("accept");

  return fetch(
    new Request(assetUrl, {
      method: "GET",
      headers: accept ? { Accept: accept } : undefined,
    }),
  );
}

function nowIso() {
  return new Date().toISOString();
}

function localTodayIso() {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: ROTATION_TIMEZONE,
  });
}

function getActiveCycleStartIso(todayIso = localTodayIso()) {
  if (todayIso < FIRST_ROTATION_DATE) {
    return FIRST_ROTATION_DATE;
  }

  const cycleDate = new Date(`${todayIso}T12:00:00Z`);
  const weekday = cycleDate.getUTCDay();
  const daysSinceFriday = (weekday + 2) % 7;
  cycleDate.setUTCDate(cycleDate.getUTCDate() - daysSinceFriday);
  return cycleDate.toISOString().slice(0, 10);
}

function getActiveCycleEndIso(cycleStartIso) {
  const endDate = new Date(`${cycleStartIso}T12:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() + 6);
  return endDate.toISOString().slice(0, 10);
}

function buildWeeklyVideoIds(cycleStartIso, catalogVideoIds) {
  const rng = seededRandom(`game-that-neutrino-weekly-${cycleStartIso}`);
  const selectionSize = Math.min(RUN_VIDEO_COUNT, catalogVideoIds.length);
  const pool = [...catalogVideoIds];
  const selected = [];

  while (selected.length < selectionSize && pool.length) {
    const index = Math.floor(rng() * pool.length);
    selected.push(pool.splice(index, 1)[0]);
  }

  return selected;
}

function seededRandom(seedText) {
  let hash = 2166136261;

  for (let index = 0; index < seedText.length; index += 1) {
    hash ^= seedText.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return () => {
    hash += 0x6d2b79f5;
    let t = hash;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function defaultFridayDb() {
  return {
    players: [],
    history: [],
    updatedAt: null,
    activeCycleStart: null,
    activeCycleEnd: null,
    activeVideoIds: [],
  };
}

function defaultQuizDb() {
  return {
    players: [],
    history: [],
    updatedAt: null,
  };
}

function defaultAnalyticsDb() {
  return {
    events: [],
    updatedAt: null,
  };
}

function normalizeFridayDb(db, catalogVideoIds) {
  const cycleStart = getActiveCycleStartIso();
  const cycleEnd = getActiveCycleEndIso(cycleStart);
  const normalized = {
    players: Array.isArray(db?.players) ? db.players : [],
    history: Array.isArray(db?.history) ? db.history : [],
    updatedAt: typeof db?.updatedAt === "string" || db?.updatedAt === null ? db.updatedAt : null,
    activeCycleStart:
      typeof db?.activeCycleStart === "string" || db?.activeCycleStart === null
        ? db.activeCycleStart
        : null,
    activeCycleEnd:
      typeof db?.activeCycleEnd === "string" || db?.activeCycleEnd === null
        ? db.activeCycleEnd
        : null,
    activeVideoIds: Array.isArray(db?.activeVideoIds) ? db.activeVideoIds : [],
  };

  if (!normalized.history.length && normalized.players.length) {
    normalized.history = sortHistory(normalized.players);
  }

  if (normalized.activeCycleStart !== cycleStart) {
    normalized.players = [];
    normalized.updatedAt = nowIso();
    normalized.activeCycleStart = cycleStart;
    normalized.activeCycleEnd = cycleEnd;
    normalized.activeVideoIds = buildWeeklyVideoIds(cycleStart, catalogVideoIds);
    return normalized;
  }

  normalized.activeCycleEnd = cycleEnd;

  if (!isValidActiveVideoIds(normalized.activeVideoIds, catalogVideoIds)) {
    normalized.activeVideoIds = buildWeeklyVideoIds(cycleStart, catalogVideoIds);
  }

  return normalized;
}

function normalizeQuizDb(db) {
  const normalized = {
    players: Array.isArray(db?.players) ? db.players : [],
    history: Array.isArray(db?.history) ? db.history : [],
    updatedAt: typeof db?.updatedAt === "string" || db?.updatedAt === null ? db.updatedAt : null,
  };

  if (!normalized.history.length && normalized.players.length) {
    normalized.history = sortHistory(normalized.players);
  }

  return normalized;
}

function normalizeAnalyticsDb(db) {
  return {
    events: Array.isArray(db?.events) ? db.events : [],
    updatedAt: typeof db?.updatedAt === "string" || db?.updatedAt === null ? db.updatedAt : null,
  };
}

function isValidActiveVideoIds(activeVideoIds, catalogVideoIds) {
  if (!Array.isArray(activeVideoIds)) {
    return false;
  }

  if (activeVideoIds.length !== Math.min(RUN_VIDEO_COUNT, catalogVideoIds.length)) {
    return false;
  }

  const catalogSet = new Set(catalogVideoIds);
  return activeVideoIds.every(
    (videoId) => typeof videoId === "string" && catalogSet.has(videoId),
  );
}

function sortPlayers(players, mode) {
  if (mode === "quiz" || mode === "quick") {
    return [...players].sort((left, right) => {
      if ((right.totalCorrect || 0) !== (left.totalCorrect || 0)) {
        return (right.totalCorrect || 0) - (left.totalCorrect || 0);
      }

      if ((right.totalAccuracy || 0) !== (left.totalAccuracy || 0)) {
        return (right.totalAccuracy || 0) - (left.totalAccuracy || 0);
      }

      if (`${left.completedAt || ""}` !== `${right.completedAt || ""}`) {
        return `${left.completedAt || ""}`.localeCompare(`${right.completedAt || ""}`);
      }

      return `${left.name || ""}`.localeCompare(`${right.name || ""}`);
    });
  }

  return [...players].sort((left, right) => {
    if ((right.finalCoins || 0) !== (left.finalCoins || 0)) {
      return (right.finalCoins || 0) - (left.finalCoins || 0);
    }

    if ((right.totalAccuracy || 0) !== (left.totalAccuracy || 0)) {
      return (right.totalAccuracy || 0) - (left.totalAccuracy || 0);
    }

    return `${left.name || ""}`.localeCompare(`${right.name || ""}`);
  });
}

function upsertPlayer(players, playerRecord, mode) {
  const nameKey = `${playerRecord?.nameKey || ""}`.trim();

  if (!nameKey) {
    throw new HttpError(400, "Missing nameKey");
  }

  const nextPlayers = [...players];
  const existingIndex = nextPlayers.findIndex(
    (player) => `${player?.nameKey || ""}`.trim() === nameKey,
  );

  if (existingIndex >= 0) {
    nextPlayers[existingIndex] = playerRecord;
  } else {
    nextPlayers.push(playerRecord);
  }

  return sortPlayers(nextPlayers, mode);
}

function upsertHistoryRecord(history, playerRecord) {
  const recordId = `${playerRecord?.id || ""}`.trim();

  if (!recordId) {
    return [...history];
  }

  const nextHistory = [...history];
  const existingIndex = nextHistory.findIndex(
    (record) => `${record?.id || ""}`.trim() === recordId,
  );

  if (existingIndex >= 0) {
    nextHistory[existingIndex] = playerRecord;
  } else {
    nextHistory.push(playerRecord);
  }

  return sortHistory(nextHistory);
}

function sortHistory(history) {
  return [...history].sort((left, right) => {
    if (`${left.completedAt || ""}` !== `${right.completedAt || ""}`) {
      return `${left.completedAt || ""}`.localeCompare(`${right.completedAt || ""}`);
    }

    if (`${left.startedAt || ""}` !== `${right.startedAt || ""}`) {
      return `${left.startedAt || ""}`.localeCompare(`${right.startedAt || ""}`);
    }

    return `${left.id || ""}`.localeCompare(`${right.id || ""}`);
  });
}

function appendAnalyticsEvents(existingEvents, incomingEvents) {
  const nextEvents = [...existingEvents];

  for (const event of incomingEvents) {
    if (!event || typeof event !== "object") {
      continue;
    }

    const eventType = `${event.type || ""}`.trim();
    const timestamp = `${event.timestamp || ""}`.trim();

    if (!eventType || !timestamp) {
      continue;
    }

    nextEvents.push(event);
  }

  if (nextEvents.length > MAX_ANALYTICS_EVENTS) {
    return nextEvents.slice(-MAX_ANALYTICS_EVENTS);
  }

  return nextEvents;
}

function serializeFridayPayload(db, catalogVideoIds) {
  return {
    players: sortPlayers(db.players || [], "friday"),
    history: sortHistory(db.history || []),
    updatedAt: db.updatedAt,
    activeCycleStart: db.activeCycleStart,
    activeCycleEnd: db.activeCycleEnd,
    activeVideoIds: db.activeVideoIds || [],
    runVideoCount: Array.isArray(db.activeVideoIds) ? db.activeVideoIds.length : 0,
    catalogSize: catalogVideoIds.length,
  };
}

function serializeQuizPayload(db, catalogVideoIds, mode = "quiz") {
  return {
    players: sortPlayers(db.players || [], mode),
    history: sortHistory(db.history || []),
    updatedAt: db.updatedAt,
    catalogSize: catalogVideoIds.length,
  };
}

function buildAnalyticsSummary(events) {
  const eventCounts = {};
  const modeCounts = {};
  const sessionIds = new Set();
  const playerNames = new Set();

  for (const event of events) {
    if (!event || typeof event !== "object") {
      continue;
    }

    const eventType = `${event.type || ""}`.trim() || "unknown";
    const mode = `${event.mode || ""}`.trim() || "unknown";
    const sessionId = `${event.sessionId || ""}`.trim();
    const playerName = `${event.nameKey || ""}`.trim();

    eventCounts[eventType] = (eventCounts[eventType] || 0) + 1;
    modeCounts[mode] = (modeCounts[mode] || 0) + 1;

    if (sessionId) {
      sessionIds.add(sessionId);
    }

    if (playerName) {
      playerNames.add(playerName);
    }
  }

  return {
    totalEvents: events.length,
    uniqueSessions: sessionIds.size,
    uniquePlayers: playerNames.size,
    eventCounts: Object.fromEntries(
      Object.entries(eventCounts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
    ),
    modeCounts: Object.fromEntries(
      Object.entries(modeCounts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
    ),
  };
}

function serializeAnalyticsPayload(db, full = false) {
  const events = Array.isArray(db.events) ? db.events : [];
  return {
    updatedAt: db.updatedAt,
    summary: buildAnalyticsSummary(events),
    recentEvents: events.slice(-MAX_RECENT_ANALYTICS_EVENTS),
    ...(full ? {events} : {}),
  };
}

async function loadCurrentFridayDb(env, request) {
  const catalogVideoIds = await loadCatalogVideoIds(env, request);
  const db = await readJsonFile(env, FRIDAY_DB_PATH, defaultFridayDb());
  return normalizeFridayDb(db, catalogVideoIds);
}

async function loadCurrentQuizDb(env, path = QUIZ_DB_PATH) {
  const db = await readJsonFile(env, path, defaultQuizDb());
  return normalizeQuizDb(db);
}

async function loadCurrentAnalyticsDb(env) {
  const db = await readJsonFile(env, ANALYTICS_DB_PATH, defaultAnalyticsDb());
  return normalizeAnalyticsDb(db);
}

async function updateJsonFile(env, path, defaultValue, updater, attempt = 0) {
  const file = await readJsonFileWithSha(env, path, defaultValue);
  const result = await updater(file.data);

  if (result.skipWrite) {
    return result;
  }

  try {
    await writeJsonFile(env, path, result.nextDb, `Update ${path}`, file.sha);
    return result;
  } catch (error) {
    if (attempt < 3 && isConflictError(error)) {
      return updateJsonFile(env, path, defaultValue, updater, attempt + 1);
    }

    throw error;
  }
}

function isConflictError(error) {
  return error instanceof HttpError && (error.status === 409 || error.status === 422);
}

async function readJsonFile(env, path, defaultValue) {
  const { data } = await readJsonFileWithSha(env, path, defaultValue);
  return data;
}

async function readJsonFileWithSha(env, path, defaultValue) {
  const token = env.GITHUB_TOKEN;
  const headers = { ...GITHUB_API_HEADERS };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(
    `${GITHUB_API_ROOT}/repos/${REPOSITORY_OWNER}/${REPOSITORY_NAME}/contents/${path}?ref=${REPOSITORY_BRANCH}`,
    {
      headers,
    },
  );

  if (response.status === 404) {
    return {
      data: defaultValue,
      sha: null,
    };
  }

  if (!response.ok) {
    throw new HttpError(response.status, `Failed to read ${path}`);
  }

  const payload = await response.json();
  const content = typeof payload.content === "string" ? payload.content.replace(/\n/g, "") : "";
  const decoded = JSON.parse(atob(content));

  return {
    data: decoded,
    sha: payload.sha || null,
  };
}

async function writeJsonFile(env, path, data, message, sha = undefined) {
  const token = env.GITHUB_TOKEN;

  if (!token) {
    throw new HttpError(500, "Missing GITHUB_TOKEN");
  }

  const body = {
    message,
    content: btoa(JSON.stringify(data, null, 2)),
    branch: REPOSITORY_BRANCH,
  };

  if (sha) {
    body.sha = sha;
  }

  const response = await fetch(
    `${GITHUB_API_ROOT}/repos/${REPOSITORY_OWNER}/${REPOSITORY_NAME}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        ...GITHUB_API_HEADERS,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    let details = "";

    try {
      const payload = await response.json();
      details = typeof payload?.message === "string" && payload.message
        ? `: ${payload.message}`
        : "";
    } catch (error) {
      details = "";
    }

    throw new HttpError(response.status, `Failed to write ${path}${details}`);
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
