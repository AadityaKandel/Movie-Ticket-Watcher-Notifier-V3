/* Marquee — panel */

const $ = (id) => document.getElementById(id);
const C = 2 * Math.PI * 28; // ring circumference

const isPopup = (() => {
  try {
    return chrome.extension.getViews({ type: "popup" }).includes(window);
  } catch (e) {
    return false;
  }
})();
document.body.classList.add(isPopup ? "is-popup" : "is-tab");

let cfg = null;
let run = null;

const SCOPE_HINTS = {
  page: "Reads every word the page shows. Simplest, and occasionally too eager.",
  zone: "Reads only between a \u201cNow showing\u201d heading and the next \u201cComing soon\u201d one.",
  selector: "Reads only the element you name below. The most precise of the three.",
};
const FOUND_HINTS = {
  stop: "One alert, then Marquee stands down and leaves the site alone.",
  remind: "Alerts again on every cycle but stops loading the page. Kindest to the site.",
  watch: "Keeps loading the page and alerts each time the title is still there.",
};

// ── talking to the worker ────────────────────────────────────────────────

const send = (msg) =>
  new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || {})));

async function pull() {
  const s = await send({ type: "state" });
  cfg = s.cfg;
  run = s.run;
  paint();
}

const patch = (p) => send({ type: "patchCfg", patch: p });

// ── tab picker ───────────────────────────────────────────────────────────

async function fillTabs() {
  const tabs = (await chrome.tabs.query({})).filter((t) => /^https?:/.test(t.url || ""));
  const sel = $("tabPick");
  sel.innerHTML = "";
  if (!tabs.length) {
    sel.append(new Option("No web pages are open", ""));
    return;
  }
  for (const t of tabs) {
    let host = "";
    try {
      host = new URL(t.url).hostname.replace(/^www\./, "");
    } catch (e) { /* ignore */ }
    const label = `${host}  ${(t.title || "").slice(0, 52)}`;
    const opt = new Option(label, String(t.id));
    opt.dataset.url = t.url; // kept here so the permission prompt needs no await
    sel.append(opt);
  }
  if (cfg && cfg.tabId != null && tabs.some((t) => t.id === cfg.tabId)) {
    sel.value = String(cfg.tabId);
  } else {
    const active = tabs.find((t) => t.active);
    if (active) sel.value = String(active.id);
  }
}

$("useTab").addEventListener("click", () => {
  const sel = $("tabPick");
  const opt = sel.selectedOptions[0];
  const id = Number(sel.value);
  if (!id || !opt || !opt.dataset.url) return;
  const url = opt.dataset.url;
  let origin;
  try {
    origin = new URL(url).origin + "/*";
  } catch (e) {
    return;
  }
  // Called synchronously inside the click so Chrome still sees a user gesture.
  chrome.permissions.request({ origins: [origin] }, (granted) => finish(granted, id, url));
});

async function finish(granted, id, url) {
  if (!granted) {
    $("detail").hidden = false;
    $("detail").textContent =
      "Marquee needs your permission for that site before it can read the page.";
    return;
  }
  await patch({ url, tabId: id });
  await pull();
}

// ── field wiring ─────────────────────────────────────────────────────────

const debounce = (fn, ms = 320) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

const bindText = (id, key) =>
  $(id).addEventListener(
    "input",
    debounce(async () => {
      await patch({ [key]: $(id).value });
      await pull();
    })
  );

bindText("title", "title");
bindText("selector", "selector");
bindText("alsoRequires", "alsoRequires");
bindText("ntfyTopic", "ntfyTopic");

$("interval").addEventListener("input", () => {
  $("intervalOut").textContent = humanSecs(Number($("interval").value));
});
$("interval").addEventListener(
  "change",
  async () => {
    await patch({ intervalSec: Number($("interval").value) });
    await pull();
  }
);

$("maxHours").addEventListener("change", async () => {
  await patch({ maxHours: Number($("maxHours").value) });
  await pull();
});

for (const id of ["notify", "sound"]) {
  $(id).addEventListener("change", async () => {
    await patch({ [id]: $(id).checked });
    await pull();
  });
}

function bindSeg(id, key, onPick) {
  $(id).addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    await patch({ [key]: b.dataset.v });
    await pull();
    if (onPick) onPick(b.dataset.v);
  });
}
bindSeg("scope", "scope");
bindSeg("onFound", "onFound");

// ── actions ──────────────────────────────────────────────────────────────

$("toggle").addEventListener("click", async () => {
  if (run && run.running) {
    await send({ type: "stop" });
  } else {
    const r = await send({ type: "start" });
    if (!r.ok) {
      $("detail").hidden = false;
      $("detail").textContent = r.error || "Could not start.";
    }
  }
  await pull();
});

$("checkNow").addEventListener("click", async () => {
  await send({ type: "checkNow" });
  await pull();
});

$("testAlert").addEventListener("click", () => send({ type: "testAlert" }));

$("clearLog").addEventListener("click", async () => {
  await send({ type: "clearLog" });
  await pull();
});

$("expand").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("panel.html") });
  window.close();
});

// ── painting ─────────────────────────────────────────────────────────────

function humanSecs(s) {
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (!m) return `${r}s`;
  return r ? `${m}m ${r}s` : `${m}m`;
}

function mmss(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

function paint() {
  if (!cfg) return;

  // fields (don't clobber a field the user is typing in)
  const act = document.activeElement;
  const set = (id, v) => {
    if ($(id) !== act) $(id).value = v;
  };
  set("title", cfg.title);
  set("selector", cfg.selector);
  set("alsoRequires", cfg.alsoRequires);
  set("ntfyTopic", cfg.ntfyTopic);
  set("interval", cfg.intervalSec);
  set("maxHours", String(cfg.maxHours));
  $("intervalOut").textContent = humanSecs(cfg.intervalSec);
  $("notify").checked = cfg.notify;
  $("sound").checked = cfg.sound;

  for (const [id, key] of [["scope", "scope"], ["onFound", "onFound"]]) {
    for (const b of $(id).querySelectorAll("button[data-v]")) {
      b.setAttribute("aria-checked", String(b.dataset.v === cfg[key]));
    }
  }
  $("scopeHint").textContent = SCOPE_HINTS[cfg.scope] || "";
  $("foundHint").textContent = FOUND_HINTS[cfg.onFound] || "";
  $("selectorField").hidden = cfg.scope !== "selector";

  $("urlHint").textContent = cfg.url
    ? cfg.url
    : "Open the cinema's listings page in a tab, then pick it here.";

  // status
  const shell = $("shell");
  shell.classList.toggle("found", run.phase === "found");
  shell.classList.toggle("halt", run.phase === "blocked" || run.phase === "error");

  const lamp = $("lamp");
  lamp.className = "lamp";
  if (run.phase === "found") lamp.classList.add("found");
  else if (run.phase === "blocked" || run.phase === "error") lamp.classList.add("halt");
  else if (run.running) lamp.classList.add("live");

  const ready = Boolean(cfg.url && cfg.title.trim());
  $("toggle").textContent = run.running ? "Stop watching" : "Start watching";
  $("toggle").classList.toggle("stop", run.running);
  $("toggle").disabled = !ready && !run.running;
  $("checkNow").disabled = !run.running;

  $("watching").innerHTML = cfg.title
    ? `Looking for <strong></strong> on the page you picked.`
    : "Nothing set yet.";
  if (cfg.title) $("watching").querySelector("strong").textContent = cfg.title;

  $("detail").hidden = !run.detail;
  $("detail").textContent = run.detail || "";

  // log
  const log = $("log");
  log.innerHTML = "";
  if (!run.log.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Nothing yet. Start a watch and the checks will show up here.";
    log.append(li);
  }
  for (const e of run.log) {
    const li = document.createElement("li");
    li.className = e.kind;
    const t = document.createElement("time");
    t.textContent = new Date(e.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const m = document.createElement("span");
    m.className = "m";
    m.textContent = e.msg;
    li.append(t, m);
    log.append(li);
  }

  tick();
}

function tick() {
  if (!run) return;
  const arc = $("arc");
  arc.style.strokeDasharray = String(C);

  if (run.phase === "found") {
    $("clock").textContent = cfg.title || "It's up";
    $("state").textContent =
      cfg.onFound === "stop" ? "Found it. Go book." : "Found it, still watching.";
    arc.style.strokeDashoffset = "0";
    return;
  }
  if (run.phase === "checking") {
    $("clock").textContent = "Looking";
    $("state").textContent = `Check ${run.checks + 1}`;
    arc.style.strokeDashoffset = "0";
    return;
  }
  if (!run.running) {
    $("clock").textContent = "—";
    $("state").textContent = run.checks
      ? `Stopped after ${run.checks} ${run.checks === 1 ? "look" : "looks"}`
      : "Not watching";
    arc.style.strokeDashoffset = String(C);
    return;
  }

  const left = run.nextCheckAt - Date.now();
  const total = Math.max(1000, run.nextCheckAt - (run.lastCheckAt || run.startedAt));
  const p = Math.min(1, Math.max(0, left / total));
  arc.style.strokeDashoffset = String(C * (1 - p));
  $("clock").textContent = mmss(left);
  $("state").textContent =
    run.backoffLevel > 0
      ? `Slowed down after ${run.checks} looks`
      : `Next look, ${run.checks} so far`;
}

// ── lifecycle ────────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.run) run = changes.run.newValue;
  if (changes.cfg) cfg = changes.cfg.newValue;
  paint();
});

setInterval(tick, 250);

(async () => {
  await pull();
  await fillTabs();
})();
