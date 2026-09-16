# Movie-Ticket-Watcher-Notifier-V3
This is an update from the first movie ticket watcher notifier. Since the first one had 2 versions, this is the third version of this title. It does exactly what it is meant to do but it is browser-integrated, and solves detection issues. No package installation required.


# App Name: Marquee

A release watcher that lives inside the browser you already use. It reloads one
page you choose, on a loose rhythm, and tells you the moment a title you're
waiting on shows up.

---

## What Marquee does instead

It removes the automation layer rather than disguising it.

| | v2 | Marquee |
|---|---|---|
| Browser | separate Chromium, debug port open | your normal browser, normal launch |
| `navigator.webdriver` | `true` | `false` — genuinely not automated |
| Profile | empty throwaway directory | your real profile, cookies and history |
| Behavioural telemetry | none, ever | your own, because it's your browser |
| Patched natives | four | none |
| Rhythm | fixed interval | jittered, with a one-minute floor |
| On pushback | kept going | backs off, then stops |

There's no driver, no debug port and no injected deception. A check is
`chrome.tabs.reload()` on a tab in the browser you're sitting in front of —
the same navigation as pressing Ctrl+R, from a profile that already carries
whatever clearance your ordinary browsing earned. Reading the page means
reading `innerText` on the tab you opened yourself, which is what's on your
screen, not a crawl of the site.

Nothing is spoofed because nothing needs to be.

---

## Before you use it, try this if the website supports it

The cheapest watcher is the one the site runs for you, and it will always beat
polling on latency:

- Most chains have a **notify-me / "remind me"** button on unreleased titles.
  It's a database row on their side and an email or push the second the listing
  goes live. Zero requests from you.
- Theatre **newsletters and social accounts** usually announce advance booking
  before the listing page updates.
- **TMDB** has a free, documented API with release dates by region, if you want
  a heads-up a day or two out rather than a minute or two.

Use Marquee for the case those don't cover: a specific screen at a specific
theatre where the site has no alert of its own.

---

## Install

1. Open `chrome://extensions` (Edge: `edge://extensions`, Brave:
   `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select **[this folder](https://github.com/AadityaKandel/Movie-Ticket-Watcher-Notifier-V3/tree/main/Movie%20Watcher)**.

Chrome 120 or newer. Works in Chrome, Edge, Brave, Opera and any other
Chromium browser.

**Firefox** needs two manifest edits: replace
`"background": { "service_worker": "background.js" }` with
`"background": { "scripts": ["background.js"] }`, and drop `"offscreen"` from
permissions (the chime won't play; notifications still will). Then load it
from `about:debugging`.

You do not need a special browser. Use the one you browse in every day —
that's the entire point, since its profile is what carries your history.

## Use

1. Open the cinema's listings page in a normal tab and leave it open.
2. Click the Marquee icon.
3. Pick that tab under **Page**, press **Use this page**, and allow the
   permission prompt. Marquee can only touch the one site you approve.
4. Type the **Title** exactly as the site spells it. Accents and punctuation
   are ignored, so `Amelie` matches `Amélie`.
5. Press **Start watching**.

Leave the tab open and the browser running. Use other tabs freely — the watched
tab reloads in the background and doesn't steal focus. There's no need to keep
the window focused, and no hotkey to configure.

### Settings

**Where on the page**
- *Anywhere* — the whole rendered page. Simplest, occasionally too eager.
- *Now showing* — only between a "Now showing" style heading and the next
  "Coming soon" one. This is v2's zone logic, kept.
- *A part I pick* — only inside a CSS selector you give it. Most precise.
  Right-click the listings block on the site, Inspect, Copy selector.

**Must also say** — extra words that must appear in the same region. Setting
this to `book` stops a Coming Soon mention from setting the alarm off.

**Roughly every** — 1 to 15 minutes. Each wait is nudged ±25% at random. One
minute is a hard floor and isn't adjustable.

**When it shows up**
- *Tell me and stop* — one alert, then it leaves the site alone.
- *Keep reminding* — alerts every cycle but stops loading the page entirely.
  Kindest option if you might miss the first alert.
- *Keep checking* — keeps loading and alerts while the title is still there.

**How you hear about it** — desktop notification, a chime that plays even with
the browser in the background, and optional push to your phone via
[ntfy](https://ntfy.sh): install the app, subscribe to a topic name only you
know, and paste the same name in. Press **Test** to check the whole chain
before you rely on it.

## If it still gets blocked

Then the site is challenging ordinary visitors too, and no amount of tuning on
this side is the answer. Slow the interval to 5 minutes or more, and take the
notify-me button. Marquee will stop on its own after four refusals rather than
keep pushing.

## Files

```
manifest.json    permissions and wiring
background.js    scheduling, the in-page detector, backoff, alerts
panel.html/css/js  the interface, used as both popup and full page
offscreen.html/js  plays the chime when no window is focused
```
