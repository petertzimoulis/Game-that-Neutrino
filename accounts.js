// Optional accounts: guest play stays available, with private cloud saves after login.
const accountState = {
  user: null, ready: false, show: false, tab: "login", busy: false,
  error: "", username: "", status: "guest", revision: 0,
  saving: null, timer: null, conflict: null, epoch: 0, fingerprint: "",
};

function accountSnapshot() {
  const recent = loadStorage(STORAGE_KEYS.completedRuns, []);
  const names = new Set([state.lastName, state.currentRun?.name, state.savedEndlessRun?.name, state.lastCompletedRun?.name, ...recent.map(run => run.name)].filter(Boolean).map(normalizeName));
  return {
    currentRun: state.currentRun,
    lastCompletedRun: state.lastCompletedRun,
    completedRuns: recent,
    trophies: Object.fromEntries(Object.entries(state.localTrophies).filter(([key]) => names.has(key))),
    lastName: state.lastName,
    selectedMode: state.selectedMode,
    pendingRuns: state.pendingCollaboratorRuns.slice(-20).map(run => ({...run, mode: run.mode || "demo"})),
    endlessRun: state.currentRun?.mode === "endless" ? state.currentRun : state.savedEndlessRun,
    pendingEndless: state.pendingEndlessRuns.slice(-20),
  };
}

function captureAccountProgress() {
  const completed = state.lastCompletedRun;
  const recent = loadStorage(STORAGE_KEYS.completedRuns, []);
  if (completed?.id && !recent.some(run => run.id === completed.id)) {
    localStorage.setItem(STORAGE_KEYS.completedRuns, JSON.stringify([...recent, completed].slice(-10)));
  }
  localStorage.setItem(STORAGE_KEYS.lastCompletedRun, JSON.stringify(completed));
  const fingerprint = JSON.stringify(accountSnapshot());
  if (fingerprint === accountState.fingerprint) return;
  accountState.fingerprint = fingerprint;
  if (progressStorageOwner) localStorage.setItem(STORAGE_KEYS.accountDirty, "true");
  queueAccountSave();
}

function queueAccountSave() {
  if (!accountState.user || accountState.conflict) return;
  if (accountState.timer) window.clearTimeout(accountState.timer);
  accountState.status = "pending";
  accountState.timer = window.setTimeout(() => { void saveAccountProgress(); }, 750);
  renderAccountHeader();
}

async function accountRequest(path, data) {
  const body = data === undefined ? undefined : JSON.stringify(data);
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeout = controller ? window.setTimeout(() => controller.abort(), 15000) : null;
  try {
    const response = await fetch(path, {
      method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
      headers: {"Content-Type": "application/json", "X-Neutrino-Request": "1"},
      ...(body ? {body, keepalive: body.length < 55000} : {}),
      ...(controller ? {signal: controller.signal} : {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || "Accounts are temporarily unavailable. You can still play as a guest.");
      error.status = response.status;
      throw error;
    }
    return payload;
  } finally {
    if (timeout !== null) window.clearTimeout(timeout);
  }
}

function writeLocalSnapshot(progress) {
  state.currentRun = normalizeStoredRun(progress.currentRun || null);
  if (state.currentRun) state.currentRun.isFinalizing = false;
  state.lastCompletedRun = progress.lastCompletedRun || null;
  state.localTrophies = progress.trophies || {};
  state.lastName = progress.lastName || accountState.user?.username || "";
  state.selectedMode = ["demo", "friday", "quiz", "quick", "endless"].includes(progress.selectedMode) ? progress.selectedMode : "demo";
  state.pendingCollaboratorRuns = Array.isArray(progress.pendingRuns) ? progress.pendingRuns : [];
  state.savedEndlessRun = progress.endlessRun || (state.currentRun?.mode === "endless" ? state.currentRun : null);
  state.endlessProfiles = loadStorage(STORAGE_KEYS.endlessProfiles, {});
  if (state.savedEndlessRun && typeof saveEndlessProfile === "function") saveEndlessProfile(state.savedEndlessRun);
  state.pendingEndlessRuns = Array.isArray(progress.pendingEndless) ? progress.pendingEndless : [];
  for (const [key, value] of Object.entries({
    currentRun: state.currentRun, lastCompletedRun: state.lastCompletedRun,
    trophies: state.localTrophies, lastName: state.lastName, selectedMode: state.selectedMode,
    pendingCollaboratorRuns: state.pendingCollaboratorRuns, completedRuns: progress.completedRuns || [],
    collaboratorMigration: true,
    savedEndlessRun: state.savedEndlessRun, endlessOutbox: state.pendingEndlessRuns,
  })) localStorage.setItem(STORAGE_KEYS[key], JSON.stringify(value));
  if (state.currentRun) state.selectedMode = state.currentRun.mode;
  state.trophyNotice = [];
  accountState.fingerprint = JSON.stringify(accountSnapshot());
}

function readLocalSnapshot() {
  return {
    currentRun: loadStorage(STORAGE_KEYS.currentRun, null),
    lastCompletedRun: loadStorage(STORAGE_KEYS.lastCompletedRun, null),
    completedRuns: loadStorage(STORAGE_KEYS.completedRuns, []),
    trophies: loadStorage(STORAGE_KEYS.trophies, {}), lastName: loadStorage(STORAGE_KEYS.lastName, ""),
    selectedMode: loadStorage(STORAGE_KEYS.selectedMode, "demo"),
    pendingRuns: loadStorage(STORAGE_KEYS.pendingCollaboratorRuns, []),
    endlessRun: loadStorage(STORAGE_KEYS.savedEndlessRun, null),
    pendingEndless: loadStorage(STORAGE_KEYS.endlessOutbox, []),
  };
}

function becomeGuest() {
  accountState.epoch++;
  if (accountState.timer) window.clearTimeout(accountState.timer);
  accountState.user = null;
  accountState.conflict = null;
  accountState.status = "guest";
  configureProgressStorage(null);
  writeLocalSnapshot(readLocalSnapshot());
}

async function restoreAccount(payload, guestProgress = null) {
  const user = payload.user;
  accountState.epoch++;
  accountState.user = user;
  accountState.username = user.username;
  configureProgressStorage(user.username);
  const local = readLocalSnapshot();
  const dirty = loadStorage(STORAGE_KEYS.accountDirty, false);
  const revision = loadStorage(STORAGE_KEYS.accountRevision, 0);
  const remote = payload.progress || {};
  const hasRemote = Object.keys(remote).length > 0;
  accountState.revision = payload.revision;
  accountState.conflict = null;
  accountState.error = "";
  if (dirty && revision !== payload.revision) {
    writeLocalSnapshot(local);
    accountState.conflict = payload;
    accountState.status = "conflict";
    accountState.error = "There are different saved copies on this device and your account. Choose which progress to keep.";
    accountState.show = true;
  } else if (dirty || !hasRemote) {
    writeLocalSnapshot(dirty ? local : (guestProgress || {...local, lastName: user.username}));
    localStorage.setItem(STORAGE_KEYS.accountDirty, "true");
    localStorage.setItem(STORAGE_KEYS.accountRevision, JSON.stringify(payload.revision));
    await saveAccountProgress();
  } else {
    writeLocalSnapshot(remote);
    localStorage.setItem(STORAGE_KEYS.accountRevision, JSON.stringify(payload.revision));
    localStorage.setItem(STORAGE_KEYS.accountDirty, "false");
    accountState.status = "saved";
  }
  state.showIntro = false;
  render();
  void syncAllDataFromServer({force: true});
}

async function saveAccountProgress() {
  if (!accountState.user || accountState.conflict) return;
  if (accountState.saving) return accountState.saving;
  captureAccountProgress();
  if (accountState.timer) window.clearTimeout(accountState.timer);
  if (!loadStorage(STORAGE_KEYS.accountDirty, false)) return;
  const epoch = accountState.epoch;
  const snapshot = accountSnapshot();
  const fingerprint = JSON.stringify(snapshot);
  accountState.status = "saving";
  renderAccountHeader();
  const saving = (async () => {
    try {
      const result = await accountRequest("/api/account/progress", {
        owner: accountState.user.username, revision: accountState.revision, progress: snapshot,
      });
      if (epoch !== accountState.epoch) return;
      accountState.revision = result.revision;
      localStorage.setItem(STORAGE_KEYS.accountRevision, JSON.stringify(result.revision));
      const changed = JSON.stringify(accountSnapshot()) !== fingerprint;
      localStorage.setItem(STORAGE_KEYS.accountDirty, JSON.stringify(changed));
      accountState.status = changed ? "pending" : "saved";
    } catch (error) {
      if (epoch !== accountState.epoch) return;
      accountState.status = "offline";
      if (error.status === 409) {
        const latest = await accountRequest("/api/account").catch(() => null);
        if (epoch !== accountState.epoch) return;
        if (latest?.user?.username === accountState.user?.username) {
          accountState.conflict = latest;
          accountState.status = "conflict";
        }
      }
      if (error.status === 401) {
        becomeGuest();
        render();
      }
      accountState.error = error.message;
    } finally {
      if (epoch === accountState.epoch) renderAccountHeader();
      accountState.saving = null;
    }
  })();
  accountState.saving = saving;
  await saving;
  if (epoch === accountState.epoch && accountState.status === "pending") queueAccountSave();
}

function renderAccountHeader() {
  const root = document.querySelector("#account-controls");
  if (!root) return;
  const user = accountState.user;
  const labels = {saved:"Progress saved",saving:"Saving…",pending:"Saving…",offline:"Saved on this device · retry sync",conflict:"Choose saved progress"};
  root.innerHTML = `<button type="button" class="ghost-button account-button" data-account-action="open"><span>${user ? escapeHtml(user.username) : "Log in / Sign up"}</span><small>${user ? labels[accountState.status] || "Account" : "Optional · guest play welcome"}</small></button>`;
}

function renderAccountControls() {
  renderAccountHeader();
  const root = document.querySelector("#account-modal-root");
  if (!root) return;
  document.body.classList.toggle("account-open", accountState.show);
  const page = document.querySelector(".page-shell");
  if (page) page.inert = accountState.show || state.showIntro || state.showAchievements;
  if (!accountState.show) { root.innerHTML = ""; return; }
  const user = accountState.user;
  const register = accountState.tab === "register";
  const recent = loadStorage(STORAGE_KEYS.completedRuns, []);
  root.innerHTML = `<div class="account-backdrop"><section class="account-dialog" role="dialog" aria-modal="true" aria-labelledby="account-title" tabindex="-1">
    <div class="table-caption"><div><p class="eyebrow">${user ? "Your account" : "Keep your progress"}</p><h2 class="card-title" id="account-title">${user ? escapeHtml(user.username) : register ? "Create an account" : "Welcome back"}</h2></div><button type="button" class="ghost-button" data-account-action="close" aria-label="Close account dialog">Close ×</button></div>
    <p class="subtle-copy">${user ? "Your unfinished game, recent results, and trophies can follow you to another device." : "Log in to save your games and trophies across devices. You can always play without an account."}</p>
    ${accountState.error ? `<p class="account-error" role="alert">${escapeHtml(accountState.error)}</p>` : ""}
    ${user ? `<div class="account-summary"><span>${state.currentRun ? `Unfinished ${escapeHtml(MODE_CONFIGS[state.currentRun.mode]?.title || "game")}` : "Ready for your next game"}</span><span>${recent.length} recent saved run${recent.length === 1 ? "" : "s"}</span><span>${accountState.status === "saved" ? "Progress saved to your account" : accountState.status === "conflict" ? "Two saved copies need your choice" : "Progress is saved on this device"}</span></div>
      ${accountState.conflict ? `<div class="button-row"><button type="button" class="primary-button" data-account-action="load-cloud">Use account progress</button><button type="button" class="secondary-button" data-account-action="keep-local">Keep this device’s progress</button></div>` : `<div class="button-row"><button type="button" class="primary-button" data-account-action="save" ${accountState.busy ? "disabled" : ""}>Save progress now</button><button type="button" class="ghost-button" data-account-action="logout" ${accountState.busy ? "disabled" : ""}>Log out</button></div>`}
      ${recent.length ? `<div class="account-recent"><h3>Recent games</h3>${[...recent].reverse().map(run => `<p><strong>${escapeHtml(MODE_CONFIGS[run.mode]?.title || "Game")}</strong><span>${Number(run.totalCorrect) || 0} / ${Number(run.totalQuestions) || run.answers?.length || 0} correct${typeof run.finalCoins === "number" ? ` · ${run.finalCoins} coins` : ""}</span></p>`).join("")}</div>` : ""}` : `
      <div class="account-tabs" role="group" aria-label="Account action"><button type="button" class="${!register ? "is-active" : ""}" data-account-action="login-tab" aria-pressed="${!register}">Log in</button><button type="button" class="${register ? "is-active" : ""}" data-account-action="register-tab" aria-pressed="${register}">Sign up</button></div>
      <form id="account-form" class="name-form">
        <label for="account-username">Username</label><input class="text-input" id="account-username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" pattern="[A-Za-z0-9_\-]{3,32}" minlength="3" maxlength="32" value="${escapeHtml(accountState.username)}" required aria-describedby="account-username-help" />
        <small id="account-username-help" class="subtle-copy">3–32 letters, numbers, underscores, or hyphens.</small>
        <label for="account-password">Password</label><input class="text-input" id="account-password" name="password" type="password" autocomplete="${register ? "new-password" : "current-password"}" minlength="8" maxlength="128" required aria-describedby="account-password-help" />
        <small id="account-password-help" class="subtle-copy">At least 8 characters.${register ? " Keep it somewhere safe; this account uses no email address." : ""}</small>
        <button class="primary-button" type="submit" ${accountState.busy ? "disabled" : ""}>${accountState.busy ? "Please wait…" : register ? "Create account & save progress" : "Log in"}</button>
      </form><button type="button" class="ghost-button account-guest" data-account-action="close">Continue as guest</button>`}
  </section></div>`;
}

function openAccount() {
  accountState.show = true;
  state.showIntro = false;
  state.showAchievements = false;
  state.showHelp = false;
  state.showAnalysis = false;
  render();
  requestAnimationFrame(() => document.querySelector(accountState.user ? ".account-dialog" : "#account-username")?.focus());
}

document.addEventListener("submit", async event => {
  if (event.target.id !== "account-form") return;
  event.preventDefault();
  if (accountState.busy) return;
  const fields = new FormData(event.target);
  const username = `${fields.get("username") || ""}`;
  const password = `${fields.get("password") || ""}`;
  const guest = progressStorageOwner ? null : accountSnapshot();
  accountState.busy = true;
  accountState.username = username;
  accountState.error = "";
  renderAccountControls();
  try {
    const payload = await accountRequest(`/api/auth/${accountState.tab === "register" ? "register" : "login"}`, {username, password});
    accountState.show = false;
    await restoreAccount(payload, guest);
  } catch (error) {
    accountState.error = error.message;
  } finally {
    accountState.busy = false;
    renderAccountControls();
  }
});

document.addEventListener("click", async event => {
  const button = event.target.closest("[data-account-action]");
  if (!button) return;
  const action = button.dataset.accountAction;
  if (accountState.busy && !["close"].includes(action)) return;
  if (action === "open") { openAccount(); return; }
  if (action === "close") {
    accountState.show = false;
    renderAccountControls();
    document.querySelector("#account-controls button")?.focus();
    return;
  }
  if (action.endsWith("-tab")) {
    accountState.tab = action === "register-tab" ? "register" : "login";
    accountState.error = "";
    renderAccountControls();
    document.querySelector("#account-username")?.focus();
    return;
  }
  accountState.busy = true;
  accountState.error = "";
  try {
    if (action === "logout") {
      await saveAccountProgress();
      await accountRequest("/api/auth/logout", {});
      becomeGuest();
      accountState.show = false;
      accountState.error = "";
      render();
    } else if (action === "save") {
      await saveAccountProgress();
    } else if (action === "load-cloud" && accountState.conflict) {
      const payload = accountState.conflict;
      accountState.conflict = null;
      writeLocalSnapshot(payload.progress);
      accountState.revision = payload.revision;
      localStorage.setItem(STORAGE_KEYS.accountRevision, JSON.stringify(payload.revision));
      localStorage.setItem(STORAGE_KEYS.accountDirty, "false");
      accountState.status = "saved";
      render();
      void syncAllDataFromServer({force:true});
    } else if (action === "keep-local" && accountState.conflict) {
      accountState.revision = accountState.conflict.revision;
      accountState.conflict = null;
      localStorage.setItem(STORAGE_KEYS.accountDirty, "true");
      await saveAccountProgress();
    }
  } catch (error) {
    accountState.error = error.message;
  } finally {
    accountState.busy = false;
    renderAccountControls();
  }
});

document.addEventListener("keydown", event => {
  if (!accountState.show) return;
  if (event.key === "Escape") {
    accountState.show = false;
    renderAccountControls();
    document.querySelector("#account-controls button")?.focus();
  } else if (event.key === "Tab") {
    const items = [...document.querySelectorAll("#account-modal-root button:not(:disabled), #account-modal-root input")];
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement.classList?.contains("account-dialog"))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});

window.addEventListener("online", () => { void saveAccountProgress(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void saveAccountProgress();
});
window.addEventListener("pagehide", () => { void saveAccountProgress(); });

accountState.fingerprint = JSON.stringify(accountSnapshot());
renderAccountControls();
const accountInitialization = (async () => {
  const epoch = accountState.epoch;
  try {
    const payload = await accountRequest("/api/account");
    if (epoch !== accountState.epoch) return;
    if (payload.user) await restoreAccount(payload);
    else if (progressStorageOwner) { becomeGuest(); render(); }
  } catch (error) {
    accountState.error = "Account sync is unavailable. You can keep playing; progress stays on this device.";
  } finally {
    accountState.ready = true;
    renderAccountControls();
  }
})();
