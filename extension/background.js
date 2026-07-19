// Canvex RPA — background service worker (the orchestrator).
//
// Phase 1 (CDP): execution runs on TRUSTED input via chrome.debugger. Clicks and
// keystrokes are dispatched with the DevTools protocol (Input.dispatchMouseEvent /
// dispatchKeyEvent / insertText), so pages see `isTrusted=true` events — the whole
// point of moving RPA into the user's real browser: real IP + real fingerprint +
// input that behaviour-based bot detection can't distinguish from a human.
//
// Split of concerns:
//   • RESOLVE / MEASURE stays in the page (chrome.scripting → window.__canvex.resolve),
//     because reading the DOM needs no trust and returns plain JSON. It hands back the
//     target's viewport-CSS-px center — the exact coordinate space CDP Input.* uses —
//     AND hit-tests that the target is actually topmost there (occlusion guard), so a
//     cookie/consent overlay can't silently eat the click.
//   • DISPATCH goes through CDP for trusted events.
//
// The hard part of in-browser replay: a `navigate` (or a click that navigates) reloads
// the page and DESTROYS the injected page-agent. So run state lives HERE, not in the
// page: we drive step→step from the worker, re-inject page-agent.js each step, and
// gate advancement on the tab reaching `complete` — arming the watcher BEFORE the
// action so a fast navigation can't slip past us. The debugger stays attached across
// same-tab navigations, so we attach once per run and detach at the end.

const runs = {}; // tabId -> { steps, index, canvasTabId }
const attached = new Set(); // tabIds this worker currently has the debugger attached to
const detaching = {}; // tabId -> Promise while a detach is in flight (serializes re-attach)
// authoringTabId -> { command_id, canvasTabId }: a pick is async — canvex-pick-start comes
// from the Canvas tab, but the pick fires LATER from the authoring tab. This remembers who
// armed it so the result routes back to that Agent/command, not just the popup. (Phase 4)
// ALSO mirrored into chrome.storage.session under "pick:<tabId>" so a multi-minute human
// pick survives MV3 service-worker eviction (~30s idle) — the click later wakes a fresh
// worker whose in-memory pendingPick is empty.
const pendingPick = {};

// Mirror of robot_runner._is_state_changing: a type+submit, or a click on a destructive-
// looking control, may mutate external state → must be gated behind the robot's allowWrites
// (the server run path enforces this; the in-browser trusted executor must too). Keep the
// keyword list in sync with backend/studio/services/agent/robot_runner.py:_DESTRUCTIVE_KEYWORDS.
const _DESTRUCTIVE_KEYWORDS = [
  "submit", "save", "pay", "buy", "order", "checkout", "purchase", "delete", "remove",
  "confirm", "send", "publish", "transfer", "withdraw", "apply", "place order",
  "提交", "保存", "支付", "付款", "购买", "下单", "结算", "删除", "移除", "确认", "发送",
  "发布", "转账", "提现",
];
function isStateChanging(step) {
  if (step.action === "type" && step.submit) return true;
  if (step.action !== "click") return false;
  const t = step.target || {};
  const hay = `${t.name || ""} ${t.text || ""} ${t.css || ""}`.toLowerCase();
  return _DESTRUCTIVE_KEYWORDS.some((kw) => hay.includes(kw));
}

let isMac = false;
try {
  chrome.runtime.getPlatformInfo((info) => {
    isMac = !!info && info.os === "mac";
  });
} catch (_) {}

function activeTab() {
  return new Promise((res) =>
    chrome.tabs.query({ active: true, currentWindow: true }, (t) => res(t[0])),
  );
}

// Deliver a message to the extension's own contexts (the popup) via runtime, AND — when a
// Canvas/authoring tab id is known — to that tab's content-script bridge (content scripts
// don't receive runtime.sendMessage, only tabs.sendMessage to their tab). Both sends
// swallow the "no receiver" error when that surface isn't listening.
function broadcast(msg, tabId) {
  chrome.runtime.sendMessage(msg).catch(() => {});
  if (tabId != null) chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

// Serialize the persisted-log read-modify-write so back-to-back events (a step's
// "ok" and the run's "done" fire ~1ms apart) can't clobber each other's append.
let logWrite = Promise.resolve();
function report(evt, canvasTabId) {
  logWrite = logWrite.then(
    () =>
      new Promise((res) => {
        chrome.storage.local.get({ log: [] }, ({ log }) => {
          log.push({ ...evt, t: Date.now() });
          chrome.storage.local.set({ log: log.slice(-200) }, res);
        });
      }),
  );
  // The popup (an extension context) hears runtime messages; the Canvas page hears via its
  // bridge content script (tabs.sendMessage to ITS tab) — so a bridge-initiated run also
  // pushes events to that tab.
  broadcast({ type: "canvex-run-event", evt }, canvasTabId);
}

// ── CDP (chrome.debugger) plumbing ──────────────────────────────────────────
// A tab can have only ONE debugger client; if DevTools (or another debugging
// extension) is open on it, attach fails. Canvas-initiated runs open a fresh tab, so
// that's a non-issue in the common path.
function forget(tabId) {
  // A run torn down externally (run tab closed, or the user hit "Cancel" on Chrome's
  // debugging infobar / DevTools took over) must still emit a terminal `done`, or the
  // caller (Canvas run-status cards / popup) is left with steps stuck "running" forever
  // and runInBrowser's message listener never detaches. `_done` dedups against the normal
  // completion path (runStep) so a mid-step tab-close can't double-report.
  const run = runs[tabId];
  if (run && !run._done) {
    run._done = true;
    report(
      { type: "done", ok: false, steps: run.steps.length, ran: run.index, error: "run tab closed or debugger detached" },
      run.canvasTabId,
    );
  }
  attached.delete(tabId);
  delete detaching[tabId];
  delete runs[tabId];
  delete pendingPick[tabId];
  chrome.storage.session.remove("pick:" + tabId).catch(() => {});
}
// External detach: the user hit "Cancel" on Chrome's debugging infobar, or DevTools
// took over. Tear the run down instead of leaving stale state behind.
chrome.debugger.onDetach.addListener((source) => {
  if (source && source.tabId != null) forget(source.tabId);
});
// Target tab closed mid-run — reap it (no detach is possible on a gone tab).
chrome.tabs.onRemoved.addListener((tabId) => forget(tabId));

function cdp(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(res);
    });
  });
}

function rawAttach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}
function rawDetach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError; // swallow "not attached" on a tab already gone
      resolve();
    });
  });
}

async function attachDebugger(tabId) {
  if (detaching[tabId]) await detaching[tabId]; // let a prior run's detach finish first
  if (attached.has(tabId)) return;
  try {
    await rawAttach(tabId);
  } catch (e) {
    if (!/already attached/i.test(e.message)) throw e;
    // "already attached" is ambiguous: our OWN stale session (worker restarted, Set
    // lost) vs. DevTools / another extension owning the tab (which we can't command).
    // Reclaim by detaching then re-attaching — detach only works on a session WE own,
    // so a foreign owner makes the re-attach fail and we surface an actionable error
    // instead of a later opaque "Debugger is not attached" mid-run.
    await rawDetach(tabId);
    try {
      await rawAttach(tabId);
    } catch (e2) {
      throw new Error(
        "Close DevTools (or another debugging extension) on this tab and retry — " + e2.message,
      );
    }
  }
  attached.add(tabId);
}

function detachDebugger(tabId) {
  if (!attached.has(tabId)) return Promise.resolve();
  const p = rawDetach(tabId).then(() => {
    attached.delete(tabId);
    if (detaching[tabId] === p) delete detaching[tabId];
  });
  detaching[tabId] = p;
  return p;
}

// Trusted left click at a viewport coordinate: move → press → release. `buttons`
// reflects what's STILL held, so release is 0 (a real mouseup with nothing held).
async function cdpClick(tabId, x, y) {
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

// Select-all in the focused field (Cmd+A on mac, Ctrl+A elsewhere) so a subsequent
// insertText REPLACES any existing value instead of appending. CDP modifier bitmask:
// Alt=1, Ctrl=2, Meta/Command=4, Shift=8.
async function cdpSelectAll(tabId) {
  const base = { modifiers: isMac ? 4 : 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 };
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

// Trusted Enter — submits forms / triggers search. text:"\r" makes it register as a
// character where a bare keyDown wouldn't.
async function cdpEnter(tabId) {
  const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...base });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

// ── Step orchestration ──────────────────────────────────────────────────────
// Wait until a (freshly-created) tab is loaded + settled. Used for the about:blank
// tab we open for bridge runs — a plain "is it ready yet" wait, not a nav gate.
function waitComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpd);
      setTimeout(resolve, 300);
    };
    const onUpd = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId, (t) => {
      if (chrome.runtime.lastError) return finish();
      if (t && t.status === "complete") finish();
    });
    setTimeout(finish, timeoutMs);
  });
}

// Settle after an action that MIGHT navigate. Armed BEFORE the action so the
// loading→complete transition can never be missed (the bug that made waitComplete
// latch the pre-navigation "complete" and run the next step on a stale DOM). If no
// navigation starts within graceMs, the action stayed on-page and we settle.
function navGate(tabId, graceMs = 1200, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let navigated = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpd);
      clearTimeout(graceTimer);
      clearTimeout(hardTimer);
      setTimeout(resolve, 400);
    };
    const onUpd = (id, info) => {
      if (id !== tabId) return;
      if (info.status === "loading") {
        navigated = true;
        clearTimeout(graceTimer);
      }
      if (info.status === "complete" && navigated) finish();
    };
    chrome.tabs.onUpdated.addListener(onUpd);
    const graceTimer = setTimeout(() => {
      if (!navigated) finish();
    }, graceMs);
    const hardTimer = setTimeout(finish, timeoutMs);
  });
}

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["page-agent.js"] });
}

// Resolve a rich locator to its on-screen center, IN the page (isolated world, shares
// window.__canvex with the injected page-agent). Scrolls it into view first so the
// coordinate is inside the viewport, then hit-tests: if the point isn't the target (or
// its ancestor/descendant), something is on top (overlay/sticky/backdrop) or the center
// got clamped off-target — fail the step loudly instead of silently clicking the wrong
// thing and reporting success.
async function resolvePoint(tabId, target) {
  await inject(tabId);
  const out = await chrome.scripting.executeScript({
    target: { tabId },
    func: (loc) => {
      const r = window.__canvex.resolve(loc || {});
      if (!r.el) return { ok: false, error: r.error };
      const el = r.el;
      el.scrollIntoView({ block: "center", inline: "center" });
      const rect = el.getBoundingClientRect();
      if (!rect.width && !rect.height) return { ok: false, error: "element has zero size" };
      const vw = window.innerWidth || document.documentElement.clientWidth;
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const x = Math.min(Math.max(rect.left + rect.width / 2, 1), vw - 1);
      const y = Math.min(Math.max(rect.top + rect.height / 2, 1), vh - 1);
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(hit === el || el.contains(hit) || hit.contains(el)))
        return { ok: false, error: "target occluded at click point (overlay/sticky element, or off-screen center)" };
      return { ok: true, x, y };
    },
    args: [target || {}],
  });
  return (out && out[0] && out[0].result) || { ok: false, error: "resolve returned nothing" };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// After the trusted focus-click, give the page a beat before typing — a search box (Google)
// or a framework input (React) may show suggestions / RE-RENDER the field on focus, which
// would otherwise leave insertText landing nowhere. Tunable.
const TYPE_FOCUS_SETTLE_MS = 120;

// Re-establish focus on the ACTUAL resolved element (it may have been swapped out by an
// on-focus re-render) so the trusted keystrokes land in it. Deterministic el.focus()/select()
// — the trust that matters for bot-detection is the KEYSTROKES (insertText), not the focus.
// Re-establish focus on the ACTUAL resolved element (an on-focus re-render may have swapped
// it out) so the trusted keystrokes land in it. Returns whether the locator still matches an
// element: false ⇒ an on-focus re-render REMOVED it with no locator-matching replacement, so
// a following insertText would land nowhere and the caller fails the step. (We don't check
// document.activeElement — it's the shadow host, not the field, for inputs in a shadow root.)
// No inject(): resolvePoint injected page-agent earlier in this same type step, and a focus-
// click can't navigate a text field, so window.__canvex (isolated world) is still live.
async function focusTarget(tabId, target) {
  const out = await chrome.scripting.executeScript({
    target: { tabId },
    func: (loc) => {
      const r = window.__canvex.resolve(loc || {});
      const el = r.el;
      if (!el || typeof el.focus !== "function") return false;
      el.focus();
      try {
        if (typeof el.select === "function") el.select();
      } catch (_) {}
      return true;
    },
    args: [target || {}],
  });
  return !!(out && out[0] && out[0].result);
}

async function runStep(tabId) {
  const run = runs[tabId];
  if (!run) return;
  const step = run.steps[run.index];
  report({ type: "step", index: run.index, action: step.action, status: "running" }, run.canvasTabId);

  let result;
  try {
    if (step.action === "navigate") {
      const gate = navGate(tabId); // arm before triggering navigation
      await chrome.tabs.update(tabId, { url: step.url });
      await gate;
      result = { ok: true };
    } else if (isStateChanging(step) && !run.allowWrites) {
      // Write-gate parity with the server runner: a submit / pay / delete-type step needs
      // the robot's allow_writes. Enforced HERE (the trusted CDP executor) so both the
      // Canvas "run in my browser" and the popup run paths are covered.
      result = { ok: false, error: "write-gated: enable allow_writes to run this step" };
    } else {
      const pt = await resolvePoint(tabId, step.target);
      if (!pt.ok) {
        result = { ok: false, error: pt.error };
      } else if (step.action === "click") {
        const gate = navGate(tabId); // the click may navigate — watch from before it
        await cdpClick(tabId, pt.x, pt.y);
        await gate;
        result = { ok: true };
      } else if (step.action === "type") {
        const gate = navGate(tabId); // submit may navigate — watch from before it
        await cdpClick(tabId, pt.x, pt.y); // trusted focus (fires the page's focus handlers)
        await sleep(TYPE_FOCUS_SETTLE_MS); // let on-focus suggestions / re-renders settle
        const focused = await focusTarget(tabId, step.target); // re-focus the (maybe re-rendered) element
        if (!focused) {
          // The target vanished after the focus-click (an on-focus re-render dropped it with
          // no locator-matching replacement). Typing now would go nowhere yet report success —
          // the exact silent no-op this path guards against. Fail the step instead.
          result = { ok: false, error: "type target disappeared after focus (re-render); nothing typed" };
        } else {
          await cdpSelectAll(tabId); // replace any existing value
          await cdp(tabId, "Input.insertText", { text: step.text || "" });
          if (step.submit) await cdpEnter(tabId);
          await gate;
          result = { ok: true };
        }
      } else {
        result = { ok: false, error: "unknown action " + step.action };
      }
    }
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e).slice(0, 150) };
  }

  report(
    {
      type: "step",
      index: run.index,
      action: step.action,
      status: result.ok ? "ok" : "failed",
      error: result.error,
    },
    run.canvasTabId,
  );

  run.index += 1;
  if (result.ok && run.index < run.steps.length) {
    runStep(tabId);
  } else {
    // `_done` guards against a double terminal event: if the tab closed mid-step,
    // forget() (via onRemoved) may already have reported `done` for this run.
    if (!run._done) {
      run._done = true;
      report({ type: "done", ok: result.ok, steps: run.steps.length, ran: run.index }, run.canvasTabId);
    }
    delete runs[tabId];
    detachDebugger(tabId);
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  (async () => {
    if (msg.type === "canvex-run") {
      const canvasTabId = sender.tab ? sender.tab.id : null;
      // Guard BEFORE any side effect: canvas-bridge forwards page payloads verbatim,
      // so an empty/malformed steps list could otherwise create an orphan tab + a stuck
      // debugger attach with no `done` ever emitted (caller hangs).
      if (!Array.isArray(msg.steps) || msg.steps.length === 0) {
        report({ type: "done", ok: false, steps: 0, ran: 0, error: "no steps to run" }, canvasTabId);
        return;
      }
      // Runs from the Canvas page (msg.newTab) open a fresh tab so the robot never
      // hijacks the Canvas tab; runs from the popup use the active tab.
      let tabId;
      if (msg.newTab) {
        const tab = await chrome.tabs.create({ url: "about:blank", active: true });
        tabId = tab.id;
        await waitComplete(tabId);
      } else {
        tabId = (await activeTab()).id;
      }
      await chrome.storage.local.set({ log: [] });
      try {
        await attachDebugger(tabId);
      } catch (e) {
        report(
          {
            type: "done",
            ok: false,
            steps: msg.steps.length,
            ran: 0,
            error: "debugger attach failed: " + String((e && e.message) || e).slice(0, 120),
          },
          canvasTabId,
        );
        if (msg.newTab) chrome.tabs.remove(tabId).catch(() => {}); // don't leak the tab we opened
        return;
      }
      // Remember the Canvas tab (present only for bridge-initiated runs) so run events
      // get pushed back to that page, not just the popup. allowWrites gates state-changing
      // steps (default off) — parity with the server runner.
      runs[tabId] = { steps: msg.steps, index: 0, canvasTabId, allowWrites: !!msg.allowWrites };
      runStep(tabId);
    } else if (msg.type === "canvex-open-tab") {
      // Phase 4: open (+ navigate) a tab for the Agent to author against, and return its id
      // so subsequent snapshot/pick commands pin to it. active:true so the user sees it.
      let reply;
      try {
        const tab = await chrome.tabs.create({ url: msg.url || "about:blank", active: true });
        await waitComplete(tab.id);
        const info = await chrome.tabs.get(tab.id).catch(() => null);
        reply = {
          type: "canvex-open-tab-result",
          command_id: msg.command_id || null,
          tabId: tab.id,
          url: (info && info.url) || msg.url || "",
          title: (info && info.title) || "",
        };
      } catch (e) {
        reply = {
          type: "canvex-open-tab-result",
          command_id: msg.command_id || null,
          error: String((e && e.message) || e).slice(0, 150),
        };
      }
      broadcast(reply, sender.tab ? sender.tab.id : null);
    } else if (msg.type === "canvex-pick-start") {
      // Optional msg.label tells the user what the Agent wants clicked (shown in-page).
      // Phase 4: msg.tabId pins the pick to the AUTHORING tab (not the active tab); the
      // command_id + requesting Canvas tab are remembered (pendingPick) so the eventual
      // pick — which fires LATER, from the authoring tab — routes back to that Agent.
      const tabId = msg.tabId != null ? msg.tabId : (await activeTab()).id;
      if (tabId != null) {
        const entry = {
          command_id: msg.command_id || null,
          canvasTabId: sender.tab ? sender.tab.id : null,
        };
        pendingPick[tabId] = entry;
        // Persist so a multi-minute human pick survives MV3 worker eviction: the later
        // click wakes a fresh worker whose in-memory pendingPick is empty (recovered below).
        chrome.storage.session.set({ ["pick:" + tabId]: entry }).catch(() => {});
        await chrome.tabs.update(tabId, { active: true }).catch(() => {}); // bring it to front
        await inject(tabId);
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (label) => window.__canvex.startPick(label),
          args: [msg.label || ""],
        });
      }
    } else if (msg.type === "canvex-pick-stop") {
      const tabId = msg.tabId != null ? msg.tabId : (await activeTab()).id;
      if (tabId != null) {
        delete pendingPick[tabId];
        chrome.storage.session.remove("pick:" + tabId).catch(() => {});
        await chrome.scripting
          .executeScript({ target: { tabId }, func: () => window.__canvex.stopPick() })
          .catch(() => {});
      }
    } else if (msg.type === "canvex-picked") {
      // A pick fired in the content script (the AUTHORING tab) → route the result back to
      // whoever armed the pick (the popup and/or the Canvas tab that sent canvex-pick-start),
      // tagged with that command_id + AXTree ref.
      const authoringTabId = sender.tab ? sender.tab.id : null;
      let pend = (authoringTabId != null && pendingPick[authoringTabId]) || null;
      if (!pend && authoringTabId != null) {
        // In-memory entry gone (MV3 evicted the worker mid-pick) → recover the route.
        const g = await chrome.storage.session.get("pick:" + authoringTabId).catch(() => ({}));
        pend = g["pick:" + authoringTabId] || null;
      }
      pend = pend || {};
      if (authoringTabId != null) {
        delete pendingPick[authoringTabId];
        chrome.storage.session.remove("pick:" + authoringTabId).catch(() => {});
        // Agent-armed picks (command_id present) are ONE-SHOT: disarm pick mode so the
        // authoring tab isn't left click-hijacked and the next step's banner re-arms fresh.
        // Manual popup picks (no command_id) keep the arm-once/pick-many recording flow.
        if (pend.command_id)
          chrome.scripting
            .executeScript({ target: { tabId: authoringTabId }, func: () => window.__canvex.stopPick() })
            .catch(() => {});
      }
      // Only the popup's manual recording appends to storage.local.steps; an Agent pick's
      // step goes to the canvas via the backend's robot_steps, so don't pollute that buffer.
      if (!pend.command_id) {
        chrome.storage.local.get({ steps: [] }, ({ steps }) => {
          steps.push({ action: "click", target: msg.locator, provenance: "picked", ref: msg.ref || null });
          chrome.storage.local.set({ steps });
        });
      }
      const reply = {
        type: "canvex-picked-saved",
        command_id: pend.command_id || null,
        locator: msg.locator,
        ref: msg.ref || null,
        epoch: msg.epoch,
      };
      broadcast(reply, pend.canvasTabId);
    } else if (msg.type === "canvex-snapshot") {
      // Phase 2: AXTree-style snapshot of a tab, for the Agent to "see" the page.
      // Read-only (chrome.scripting, no CDP/trust needed). Rebuilds the ref→element map.
      let snap;
      let tabId = null;
      try {
        tabId = msg.tabId != null ? msg.tabId : (await activeTab()).id;
        if (tabId == null) throw new Error("no active tab");
        await inject(tabId);
        const out = await chrome.scripting.executeScript({
          target: { tabId },
          func: (o) => window.__canvex.snapshot(o),
          args: [{ max: msg.max || 250 }],
        });
        snap = (out && out[0] && out[0].result) || { error: "no snapshot result" };
      } catch (e) {
        snap = { error: String((e && e.message) || e).slice(0, 150) };
      }
      // Reply carries command_id (to correlate the Agent's request) + tabId + epoch (inside
      // snap) so the caller can pin follow-up ref lookups to the SAME snapshot.
      const reply = { type: "canvex-snapshot-result", command_id: msg.command_id || null, tabId, snap };
      broadcast(reply, sender.tab ? sender.tab.id : null);
    } else if (msg.type === "canvex-ref-locator") {
      // Phase 2: convert a snapshot ref → durable rich locator (same shape as a pick).
      // tabId + epoch pin the lookup to the exact snapshot that produced the ref.
      let locator;
      let tabId = null;
      try {
        tabId = msg.tabId != null ? msg.tabId : (await activeTab()).id;
        if (tabId == null) throw new Error("no active tab");
        await inject(tabId);
        const out = await chrome.scripting.executeScript({
          target: { tabId },
          func: (ref, epoch) => window.__canvex.locatorForRef(ref, epoch),
          args: [msg.ref, msg.epoch != null ? msg.epoch : null],
        });
        locator = (out && out[0] && out[0].result) || { error: "no locator result" };
      } catch (e) {
        locator = { error: String((e && e.message) || e).slice(0, 150) };
      }
      const reply = {
        type: "canvex-ref-locator-result",
        command_id: msg.command_id || null,
        tabId,
        ref: msg.ref,
        locator,
      };
      broadcast(reply, sender.tab ? sender.tab.id : null);
    }
  })();
  return false;
});
