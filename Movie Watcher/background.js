/* Marquee — release watcher
 * Background service worker: scheduling, detection, backoff, alerts.
 *
 * Design rule for this file: nothing here lies to a page.
 * No property overrides, no synthetic input events, no fingerprint edits.
 * A check is a plain tab reload in the user's own browser, and the page
 * is read the same way a reader's eyes read it — rendered visible text.
 */

const ALARM = "marquee-tick";
const MIN_INTERVAL_SEC = 60; // hard floor, not user-adjustable
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const LOG_MAX = 14;

const DEFAULT_CFG = {
  url: "",
  tabId: null,
  title: "",
  scope: "page", // page | zone | selector
  selector: "",
  alsoRequires: "",
  intervalSec: 90,
  jitterPct: 25,
  onFound: "stop", // stop | remind | watch
  maxHours: 6,
  notify: true,
  sound: true,
  ntfyTopic: "",
};

const DEFAULT_RUN = {
  running: false,
  phase: "idle", // idle | waiting | checking | found | blocked | error
  startedAt: 0,
  nextCheckAt: 0,
  lastCheckAt: 0,
  checks: 0,
  found: false,
  backoffLevel: 0,
  detail: "",
  log: [],
};

// ───────────────────────────────────────────────────────────── state helpers

async function getCfg() {
  const { cfg } = await chrome.storage.local.get("cfg");
  return { ...DEFAULT_CFG, ...(cfg || {}) };
}
async function setCfg(patch) {
  const cfg = { ...(await getCfg()), ...patch };
  await chrome.storage.local.set({ cfg });
  return cfg;
}
async function getRun() {
  const { run } = await chrome.storage.local.get("run");
  return { ...DEFAULT_RUN, ...(run || {}) };
}
async function setRun(patch) {
  const run = { ...(await getRun()), ...patch };
  await chrome.storage.local.set({ run });
  return run;
}
async function log(kind, msg) {
  const run = await getRun();
  const entry = { t: Date.now(), kind, msg };
  const next = [entry, ...run.log].slice(0, LOG_MAX);
  await chrome.storage.local.set({ run: { ...run, log: next } });
}

// ──────────────────────────────────────────────────── the in-page detector
// Serialized and injected into the watched tab. Keep it self-contained.
function detectInPage(cfg) {
  const fold = (s) =>
    (s || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();

  const raw = document.body ? document.body.innerText || "" : "";
  const low = raw.toLowerCase();
  const docTitle = (document.title || "").toLowerCase();

  // Does the site look like it pushed back? If so we slow down — we never
  // try to work around it.
  const pushback = [
    "access denied",
    "request blocked",
    "unusual traffic",
    "verify you are human",
    "are you a robot",
    "checking your browser",
    "attention required",
    "too many requests",
    "rate limit",
    "suspicious activity",
    "just a moment",
  ];
  const hit = pushback.find((m) => low.includes(m) || docTitle.includes(m));
  const blocked = Boolean(hit) && raw.length < 3000;

  if (blocked) return { ok: false, blocked: true, reason: hit, chars: raw.length };
  if (raw.length < 200)
    return { ok: false, blocked: false, reason: "page looks empty", chars: raw.length };

  // Pick the region of the page to read.
  let region = raw;
  let regionName = "whole page";

  if (cfg.scope === "selector" && cfg.selector) {
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(cfg.selector));
    } catch (e) {
      return { ok: false, blocked: false, reason: "selector is not valid CSS", chars: raw.length };
    }
    if (!nodes.length)
      return { ok: false, blocked: false, reason: "selector matched nothing", chars: raw.length };
    region = nodes.map((n) => n.innerText || "").join("\n");
    regionName = cfg.selector;
  } else if (cfg.scope === "zone") {
    const folded = fold(raw);
    const opens = ["now showing", "showing now", "now playing", "in cinemas", "current release"];
    const closes = ["coming soon", "upcoming", "next release", "advance booking"];
    let start = -1;
    for (const k of opens) {
      const i = folded.indexOf(fold(k));
      if (i !== -1 && (start === -1 || i < start)) start = i;
    }
    if (start === -1)
      return { ok: false, blocked: false, reason: "no 'now showing' heading found", chars: raw.length };
    let end = folded.length;
    for (const k of closes) {
      const i = folded.indexOf(fold(k), start + 1);
      if (i !== -1 && i < end) end = i;
    }
    region = folded.slice(start, end);
    regionName = "now-showing block";
  }

  const hay = fold(region);
  const needle = fold(cfg.title);
  if (!needle) return { ok: false, blocked: false, reason: "no title set", chars: raw.length };

  let found = hay.includes(needle);
  if (found && cfg.alsoRequires) {
    const extras = cfg.alsoRequires
      .split(",")
      .map((s) => fold(s))
      .filter(Boolean);
    found = extras.every((e) => hay.includes(e));
  }

  return { ok: true, blocked: false, found, region: regionName, chars: raw.length };
}

// ─────────────────────────────────────────────────────────── tab plumbing

async function resolveTab(cfg) {
  if (cfg.tabId != null) {
    try {
      const tab = await chrome.tabs.get(cfg.tabId);
      if (tab) return tab;
    } catch (e) {
      /* tab is gone */
    }
  }
  // Fall back to any tab already sitting on the watched page. tabs.query takes
  // match patterns, which have no query-string part, so build one from the path.
  let pattern;
  try {
    const u = new URL(cfg.url);
    pattern = `${u.protocol}//${u.hostname}${u.pathname}*`;
  } catch (e) {
    return null;
  }
  const all = await chrome.tabs.query({ url: pattern });
  return all[0] || null;
}

function waitForLoad(tabId, timeoutMs = 45000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpd);
      clearTimeout(timer);
      resolve(v);
    };
    const onUpd = (id, info) => {
      if (id === tabId && info.status === "complete") finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────── scheduling

function nextDelayMs(cfg, backoffLevel) {
  let base = Math.max(MIN_INTERVAL_SEC, cfg.intervalSec) * 1000;
  if (backoffLevel > 0) base = Math.min(base * Math.pow(2, backoffLevel), MAX_BACKOFF_MS);
  const j = (cfg.jitterPct || 0) / 100;
  const factor = 1 + (Math.random() * 2 - 1) * j;
  return Math.max(30000, Math.round(base * factor));
}

async function schedule(cfg, run) {
  const delay = nextDelayMs(cfg, run.backoffLevel);
  const at = Date.now() + delay;
  await chrome.alarms.clear(ALARM);
  await chrome.alarms.create(ALARM, { when: at });
  await setRun({ nextCheckAt: at, phase: run.found ? "found" : "waiting" });
}

// ─────────────────────────────────────────────────────────────── the check

let inFlight = false;

async function runCheck() {
  if (inFlight) return;
  inFlight = true;
  try {
    const cfg = await getCfg();
    let run = await getRun();
    if (!run.running) return;

    // Session cap.
    if (cfg.maxHours > 0 && Date.now() - run.startedAt > cfg.maxHours * 3600000) {
      await stopWatch(`Stopped on its own after ${cfg.maxHours}h.`);
      return;
    }

    // "Remind" keeps alerting but stops touching the site entirely.
    if (run.found && cfg.onFound === "remind") {
      await fireAlerts(cfg, "still open");
      await schedule(cfg, run);
      return;
    }

    const tab = await resolveTab(cfg);
    if (!tab) {
      await setRun({ phase: "error", detail: "The watched tab is closed. Reopen the page and pick it again." });
      await log("error", "Watched tab is gone");
      await stopWatch("Lost the tab.");
      return;
    }
    if (tab.id !== cfg.tabId) await setCfg({ tabId: tab.id });

    await setRun({ phase: "checking" });

    // A plain reload. Same request a person makes with Ctrl+R, cache and all.
    // Listen first, then reload, so a fast load can't land before we're ready.
    const loadedP = waitForLoad(tab.id);
    await chrome.tabs.reload(tab.id, { bypassCache: false });
    const loaded = await loadedP;
    if (!loaded) {
      run = await bumpBackoff("Page did not finish loading");
      await schedule(cfg, run);
      return;
    }

    // Give late-rendering listings a moment, like a reader would.
    await sleep(1800 + Math.random() * 1600);

    let result;
    try {
      const [inj] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: detectInPage,
        args: [cfg],
      });
      result = inj && inj.result;
    } catch (e) {
      const why = /permission|host/i.test(e.message || "")
        ? "No permission for this site yet. Press \u201cUse this page\u201d again and allow it."
        : "Could not read the page: " + e.message;
      run = await bumpBackoff(why);
      await schedule(cfg, await getRun());
      return;
    }

    run = await setRun({ checks: (await getRun()).checks + 1, lastCheckAt: Date.now() });

    if (!result) {
      run = await bumpBackoff("No result from the page");
      await schedule(cfg, run);
      return;
    }

    if (result.blocked) {
      run = await bumpBackoff(`Site pushed back (${result.reason})`);
      if (run.backoffLevel === 1) {
        notifyOS(
          "Marquee is slowing down",
          "The site asked you to wait. Checks are now further apart."
        );
      }
      if (run.backoffLevel >= 4) {
        await stopWatch(
          "The site kept refusing. Stopped. Use its own 'notify me' button instead."
        );
        notifyOS(
          "Marquee stopped",
          "The site kept refusing requests, so the watch stopped. Try its built-in alert."
        );
      } else {
        await schedule(cfg, run);
      }
      return;
    }

    if (!result.ok) {
      run = await bumpBackoff(result.reason || "Nothing readable");
      await schedule(cfg, run);
      return;
    }

    // Healthy read — clear any backoff.
    run = await setRun({ backoffLevel: 0, detail: "" });

    if (result.found) {
      await setRun({ found: true, phase: "found" });
      await log("found", `Matched in ${result.region}`);
      await fireAlerts(cfg, result.region);
      if (cfg.onFound === "stop") {
        await stopWatch("Found it.", true);
        return;
      }
    } else {
      await log("check", `Not listed yet (${result.chars.toLocaleString()} chars read)`);
    }

    await schedule(cfg, await getRun());
  } finally {
    inFlight = false;
  }
}

async function bumpBackoff(reason) {
  const run = await getRun();
  const level = Math.min(run.backoffLevel + 1, 6);
  await log("warn", reason);
  return await setRun({ backoffLevel: level, phase: "blocked", detail: reason });
}

// ────────────────────────────────────────────────────────────────── alerts

async function fireAlerts(cfg, where) {
  const title = cfg.title || "Your title";
  const body = `${title} is on the page now — go book.`;

  if (cfg.notify) notifyOS("Tickets are up", body);
  if (cfg.sound) playChime().catch(() => {});
  if (cfg.ntfyTopic) {
    try {
      await fetch(`https://ntfy.sh/${encodeURIComponent(cfg.ntfyTopic)}`, {
        method: "POST",
        headers: { Title: "Tickets are up", Priority: "high", Tags: "clapper" },
        body,
      });
    } catch (e) {
      await log("warn", "Phone push failed: " + e.message);
    }
  }
  chrome.action.setBadgeText({ text: "GO" });
  chrome.action.setBadgeBackgroundColor({ color: "#F0B429" });
}

function notifyOS(title, message) {
  chrome.notifications.create("marquee-" + Date.now(), {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title,
    message,
    priority: 2,
    requireInteraction: true,
  });
}

chrome.notifications.onClicked.addListener(async () => {
  const cfg = await getCfg();
  const tab = await resolveTab(cfg);
  if (tab) {
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });
  }
});

// Offscreen document, purely so a sound can play when no window is focused.
async function playChime() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (!existing.length) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play an alert tone when a watched title appears.",
    });
  }
  chrome.runtime.sendMessage({ type: "marquee-chime" });
}

// ───────────────────────────────────────────────────────── start/stop

async function startWatch() {
  const cfg = await getCfg();
  if (!cfg.url || !cfg.title) throw new Error("Pick a tab and enter a title first.");
  await chrome.action.setBadgeText({ text: "" });
  await chrome.storage.local.set({
    run: {
      ...DEFAULT_RUN,
      running: true,
      phase: "waiting",
      startedAt: Date.now(),
      log: [{ t: Date.now(), kind: "info", msg: `Watching for "${cfg.title}"` }],
    },
  });
  // First check soon, but not instantly — the page is already loaded.
  const at = Date.now() + 5000;
  await chrome.alarms.clear(ALARM);
  await chrome.alarms.create(ALARM, { when: at });
  await setRun({ nextCheckAt: at });
}

async function stopWatch(detail = "", keepFound = false) {
  await chrome.alarms.clear(ALARM);
  const run = await getRun();
  await setRun({
    running: false,
    phase: keepFound || run.found ? "found" : "idle",
    nextCheckAt: 0,
    detail,
  });
  if (detail) await log("info", detail);
}

// ───────────────────────────────────────────────────────────── listeners

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) runCheck();
});

chrome.runtime.onStartup.addListener(async () => {
  const run = await getRun();
  if (run.running) {
    const cfg = await getCfg();
    await schedule(cfg, run);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "state":
        sendResponse({ cfg: await getCfg(), run: await getRun(), minInterval: MIN_INTERVAL_SEC });
        break;
      case "patchCfg":
        sendResponse({ cfg: await setCfg(msg.patch) });
        break;
      case "start":
        try {
          await startWatch();
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        break;
      case "stop":
        await stopWatch("Stopped by you.");
        await chrome.action.setBadgeText({ text: "" });
        sendResponse({ ok: true });
        break;
      case "checkNow":
        await chrome.alarms.clear(ALARM);
        runCheck();
        sendResponse({ ok: true });
        break;
      case "testAlert": {
        const cfg = await getCfg();
        await fireAlerts(cfg, "test");
        chrome.action.setBadgeText({ text: "" });
        sendResponse({ ok: true });
        break;
      }
      case "clearLog":
        await setRun({ log: [] });
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({});
    }
  })();
  return true; // async response
});
