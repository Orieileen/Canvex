// Canvex RPA — Canvas-page bridge.
// Injected ONLY on the Canvex web origin (see manifest content_scripts). Relays
// messages between the Canvas page (window.postMessage) and the extension
// background (chrome.runtime) — so the page can drive robots WITHOUT knowing the
// extension ID (no externally_connectable / no key pinning needed).
//
// Protocol (page side):
//   page → ext : window.postMessage({ __canvexTo: "ext", payload }, "*")
//   ext  → page: window.postMessage({ __canvexFrom: "ext", payload }, "*")
//   handshake  : page posts {__canvexTo:"ext", payload:{type:"canvex-ping"}}
//                bridge answers {__canvexFrom:"ext", payload:{type:"canvex-ready"}}

(() => {
  const announce = () =>
    window.postMessage({ __canvexFrom: "ext", payload: { type: "canvex-ready" } }, "*");

  // Page → background. A ping is answered locally; everything else is forwarded.
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__canvexTo !== "ext") return;
    const payload = e.data.payload || {};
    if (payload.type === "canvex-ping") {
      announce();
      return;
    }
    try {
      chrome.runtime.sendMessage(payload);
    } catch (_) {
      /* background asleep / context invalidated — page will re-ping */
    }
  });

  // Background → page (run events, pick-saved, etc.).
  chrome.runtime.onMessage.addListener((msg) => {
    window.postMessage({ __canvexFrom: "ext", payload: msg }, "*");
  });

  // The content script runs at document_start; announce now and once more after
  // load so a late-mounting page listener still catches us.
  announce();
  window.addEventListener("load", announce);
})();
