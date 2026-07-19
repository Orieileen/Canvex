// Canvex RPA — popup. Preloads a demo robot, drives pick/run, renders steps+log.

// The demo robot: exactly what got IP-blocked server-side — here it runs in YOUR
// browser (your real residential IP). navigate Google → type "iPhone 17" → submit
// (Enter) the search. NOTE: a literal "click the Search button" step also works,
// but only via a *pick* (which captures a unique locator) — Google renders two
// name=btnK buttons, so a hardcoded `input[name=btnK]` is ambiguous and the
// resolver (correctly) refuses to guess. So the demo uses submit for reliability.
const DEMO = [
  { action: "navigate", url: "https://www.google.com" },
  { action: "type", target: { css: "textarea[name=q]" }, text: "iPhone 17", submit: true },
];

const $ = (id) => document.getElementById(id);

function renderSteps(steps) {
  $("steps").innerHTML =
    !steps || !steps.length
      ? '<span class="hint">还没有步骤。点「开始点选」在页面里点元素,或直接跑 Demo。</span>'
      : steps
          .map((s, i) => {
            const label =
              s.action === "navigate"
                ? s.url
                : (s.target && (s.target.name || s.target.css)) || "";
            const extra = s.action === "type" ? ` = "${s.text || ""}"` : "";
            const refBadge = s.ref ? ` <span style="color:#38bdf8">[${s.ref}]</span>` : "";
            return `<div class="s">${i + 1}. <b>${s.action}</b> ${label}${extra}${refBadge}</div>`;
          })
          .join("");
}

function renderLog(log) {
  $("log").innerHTML = (log || [])
    .map((e) => {
      if (e.type === "done")
        return `<div class="${e.ok ? "ok" : "failed"}">— 完成:${e.ran}/${e.steps} 步 ${
          e.ok ? "✓" : "✗"
        }</div>`;
      const cls = e.status === "ok" ? "ok" : e.status === "failed" ? "failed" : "";
      return `<div class="${cls}">步骤 ${e.index + 1} ${e.action} → ${e.status}${
        e.error ? " (" + e.error + ")" : ""
      }</div>`;
    })
    .join("");
  $("log").scrollTop = $("log").scrollHeight;
}

function refresh() {
  chrome.storage.local.get({ steps: [], log: [] }, ({ steps, log }) => {
    renderSteps(steps);
    renderLog(log);
  });
}

$("demo").onclick = () => {
  chrome.storage.local.set({ steps: DEMO, log: [] });
  chrome.runtime.sendMessage({ type: "canvex-run", steps: DEMO });
};
$("run").onclick = () =>
  chrome.storage.local.get({ steps: [] }, ({ steps }) => {
    if (steps.length) chrome.runtime.sendMessage({ type: "canvex-run", steps });
  });
$("pick").onclick = () => chrome.runtime.sendMessage({ type: "canvex-pick-start" });
$("pickstop").onclick = () => chrome.runtime.sendMessage({ type: "canvex-pick-stop" });
$("clear").onclick = () => chrome.storage.local.set({ steps: [], log: [] });

// ── Phase 2: AXTree snapshot + ref→locator ──────────────────────────────────
let snapCtx = { tabId: null, epoch: null }; // pins ref lookups to the snapshot's tab+epoch
const esc = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

function renderSnap(snap) {
  if (!snap || snap.error) {
    $("snapmeta").textContent = "快照失败:" + ((snap && snap.error) || "unknown");
    $("snaptree").textContent = "";
    return;
  }
  $("snapmeta").textContent = `${snap.count} 个可交互/结构元素${snap.truncated ? " (已截断)" : ""} — ${snap.title || snap.url}`;
  // Escape the whole tree, then turn [ref_N] tokens into clickable spans.
  $("snaptree").innerHTML = esc(snap.text).replace(
    /\[(ref_\d+)\]/g,
    (_m, r) => `[<span class="ref" data-ref="${r}">${r}</span>]`,
  );
  $("locout").textContent = "";
}

$("snap").onclick = () => {
  $("snapmeta").textContent = "拍快照中…";
  chrome.runtime.sendMessage({ type: "canvex-snapshot" });
};
// Click a ref → resolve it to a rich locator, pinned to the snapshot's tab + epoch.
$("snaptree").onclick = (e) => {
  const ref = e.target && e.target.getAttribute && e.target.getAttribute("data-ref");
  if (!ref) return;
  $("locout").textContent = ref + " → 解析中…";
  chrome.runtime.sendMessage({
    type: "canvex-ref-locator",
    ref,
    tabId: snapCtx.tabId,
    epoch: snapCtx.epoch,
  });
};

// Live updates while the popup is open.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "canvex-run-event") refresh();
  else if (msg.type === "canvex-picked-saved") {
    // Show the pick ↔ AXTree ref binding (Phase 3).
    $("locout").textContent =
      `已点选 ${msg.ref ? "↔ " + msg.ref : "(不在当前快照中)"} → ` + JSON.stringify(msg.locator);
    refresh();
  } else if (msg.type === "canvex-snapshot-result") {
    snapCtx = { tabId: msg.tabId, epoch: msg.snap && msg.snap.epoch };
    renderSnap(msg.snap);
  } else if (msg.type === "canvex-ref-locator-result")
    $("locout").textContent = `${msg.ref} → ` + JSON.stringify(msg.locator);
});
chrome.storage.onChanged.addListener(refresh);
refresh();
