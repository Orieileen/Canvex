// Canvex RPA — page agent.
// Injected into the target tab (idempotently, re-injected per step). Defines
// window.__canvex: the SAME rich-locator + resolve semantics as the server-side
// v1 (browser_primitives.py _ELEMENT_FROM_POINT_JS + the css→role/name resolver),
// but running in the user's REAL page — so no coordinate re-projection, no Xvfb,
// real IP + real login state.
(() => {
  if (window.__canvex) return; // idempotent — background re-injects each step

  const ACTIONABLE = "a,button,input,select,textarea,[role],[onclick],[tabindex]";

  const isVisible = (el) =>
    !!(el.offsetParent !== null || el.getClientRects().length);

  function implicitRole(el) {
    const t = el.tagName.toLowerCase();
    if (t === "a" && el.hasAttribute("href")) return "link";
    if (t === "button") return "button";
    if (t === "textarea") return "textbox";
    if (t === "select") return "combobox";
    if (t === "input") {
      const it = (el.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(it)) return "button";
      if (it === "checkbox") return "checkbox";
      if (it === "radio") return "radio";
      if (it === "search") return "searchbox";
      return "textbox";
    }
    return "";
  }

  const accName = (el) =>
    (
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("alt") ||
      el.getAttribute("value") ||
      (el.textContent || "").trim()
    ).slice(0, 120);

  // Climb to the nearest actionable ancestor — rescues "I grabbed the wrapping
  // div, I wanted the link inside" (v1 §5.2 same intent).
  function actionable(el) {
    let n = el;
    while (n && n !== document.body) {
      if (n.matches && n.matches(ACTIONABLE)) return n;
      n = n.parentElement;
    }
    return el;
  }

  // A stable-ish CSS path: prefer a unique #id, else tag + :nth-of-type chain.
  function cssPath(el) {
    if (el.id) {
      const sel = "#" + CSS.escape(el.id);
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch (_) {}
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      if (node.id) {
        parts.unshift("#" + CSS.escape(node.id));
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  // Rich locator — same shape the server-side pick returns.
  function locatorOf(el) {
    el = actionable(el);
    const css = cssPath(el);
    let matches = [];
    try {
      matches = [...document.querySelectorAll(css)];
    } catch (_) {}
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || implicitRole(el),
      name: accName(el),
      text: (el.textContent || "").trim().slice(0, 120),
      css,
      nth: Math.max(0, matches.indexOf(el)),
      bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      isPassword:
        el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "password",
    };
  }

  // Resolve a locator back to a single element: css → role/name fallback; prefer
  // the visible match; honor nth; NEVER silently pick .first on ambiguity (v1 §4).
  function resolve(loc) {
    let list = [];
    if (loc && loc.css) {
      try {
        list = [...document.querySelectorAll(loc.css)];
      } catch (_) {}
    }
    if (list.length === 0 && loc && loc.name) {
      list = [...document.querySelectorAll(ACTIONABLE)].filter(
        (e) =>
          accName(e) === loc.name &&
          (!loc.role || (e.getAttribute("role") || implicitRole(e)) === loc.role),
      );
    }
    if (list.length === 0) return { el: null, error: "locator matched 0 elements" };
    if (list.length === 1) return { el: list[0] };
    const vis = list.filter(isVisible);
    if (vis.length === 1) return { el: vis[0] };
    const pool = vis.length ? vis : list;
    if (typeof loc.nth === "number" && loc.nth < pool.length) return { el: pool[loc.nth] };
    return { el: null, error: `ambiguous: ${list.length} matches, no usable nth` };
  }

  // ── AXTree-style snapshot (Phase 2) ────────────────────────────────────────
  // An accessibility-oriented tree of the page (roles + accessible names + nesting)
  // with ephemeral `ref_N` ids the Agent can act on — the Claude-in-Chrome "see the
  // page" method. Computed from the DOM in THIS isolated world (not CDP's computed AX
  // tree) so `ref_N → element → locatorOf` is exact and reuses the pick semantics
  // verbatim; a chosen ref converts to the SAME rich locator a manual pick would.
  // (CDP Accessibility.getFullAXTree is a higher-fidelity swap later — it'd need
  // cross-world plumbing to reach locatorOf, which lives here.)
  let snapRefs = new Map(); // ref_N -> element; rebuilt on every snapshot()
  let snapEpoch = 0; // bumped each snapshot(); a ref carrying an older epoch is rejected

  const IMPLICIT_LANDMARK = {
    nav: "navigation", main: "main", header: "banner",
    footer: "contentinfo", aside: "complementary", form: "form", section: "region",
  };
  const LANDMARK_ROLES = new Set([
    "banner", "navigation", "main", "complementary", "contentinfo", "search", "form", "region",
  ]);

  // A landmark/region container: named ONLY by an explicit label, never by its
  // descendant text (else `main`/`nav` get the whole page's text as their "name").
  function isContainerRole(el) {
    if (IMPLICIT_LANDMARK[el.tagName.toLowerCase()]) return true;
    const role = el.getAttribute("role");
    return role ? LANDMARK_ROLES.has(role) : false;
  }

  // Accessible name, a bit richer than accName (which locatorOf keeps unchanged for
  // pick-consistency): resolve aria-labelledby and <label for>, then fall back.
  function axName(el) {
    const fromIds = (ids) =>
      ids
        .split(/\s+/)
        .map((id) => {
          const n = id && document.getElementById(id);
          return n ? (n.textContent || "").trim() : "";
        })
        .filter(Boolean)
        .join(" ");
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const s = fromIds(labelledby);
      if (s) return s.slice(0, 120);
    }
    if (el.id) {
      try {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab) {
          const s = (lab.textContent || "").trim();
          if (s) return s.slice(0, 120);
        }
      } catch (_) {}
    }
    if (isContainerRole(el))
      return (el.getAttribute("aria-label") || el.getAttribute("title") || "").slice(0, 120);
    return accName(el);
  }

  function axRole(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const t = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(t)) return "heading";
    if (IMPLICIT_LANDMARK[t]) return IMPLICIT_LANDMARK[t];
    if (t === "img" && el.getAttribute("alt")) return "image";
    return implicitRole(el);
  }

  // Is this a landmark worth emitting for orientation? Mirrors ARIA: section/form (and
  // region/form/search roles) count only when they carry an accessible name; header/
  // footer are banner/contentinfo only at the top level. Otherwise unnamed <section>/
  // <form> wrappers flood the tree and burn the node cap before real controls are seen.
  function axLandmark(el) {
    const role = el.getAttribute("role");
    if (role && LANDMARK_ROLES.has(role)) {
      if (role === "region" || role === "form" || role === "search") return !!axName(el);
      return true;
    }
    const t = el.tagName.toLowerCase();
    if (t === "nav" || t === "main" || t === "aside") return true;
    if (t === "header" || t === "footer") return !el.closest("article, section, aside, nav, main");
    if (t === "section" || t === "form") return !!axName(el);
    return false;
  }

  // Stricter than isVisible for the snapshot: also drop visibility:hidden / opacity:0,
  // so the Agent isn't handed a control a human can't see. isVisible first (cheap,
  // short-circuits display:none before the getComputedStyle call).
  function axVisible(el) {
    if (!isVisible(el)) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.opacity !== "0";
  }

  // Worth showing to the Agent? Interactive controls + a little structure for orientation.
  function axInteresting(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.getAttribute("aria-hidden") === "true") return false; // (walk also prunes the subtree)
    const t = el.tagName.toLowerCase();
    if (t === "script" || t === "style" || t === "noscript" || t === "template") return false;
    const candidate =
      el.matches(ACTIONABLE) ||
      /^h[1-6]$/.test(t) ||
      el.getAttribute("role") === "heading" ||
      (t === "img" && el.getAttribute("alt")) ||
      axLandmark(el);
    return candidate ? axVisible(el) : false;
  }

  // Build the tree text + (re)build the ref→element map. Uninteresting wrappers are
  // collapsed: an interesting node's indent reflects its depth among interesting nodes.
  function snapshot(opts) {
    const cap = (opts && opts.max) || 250;
    const refs = new Map();
    const lines = [];
    let seq = 0;
    let capped = false;

    const walk = (node, depth) => {
      // Prune aria-hidden subtrees entirely — an aria-hidden ancestor hides all of its
      // descendants from assistive tech, so none should reach the Agent.
      if (node.nodeType === 1 && node.getAttribute("aria-hidden") === "true") return;
      let childDepth = depth;
      if (node.nodeType === 1 && seq < cap && axInteresting(node)) {
        const ref = "ref_" + ++seq;
        refs.set(ref, node);
        const role = axRole(node);
        const name = axName(node).replace(/\s+/g, " ").trim();
        const pw =
          node.tagName === "INPUT" && (node.getAttribute("type") || "").toLowerCase() === "password"
            ? " (password)"
            : "";
        lines.push(`${"  ".repeat(Math.min(depth, 12))}- ${role}${name ? ` "${name}"` : ""} [${ref}]${pw}`);
        childDepth = depth + 1;
      }
      let child = node.firstElementChild;
      while (child && seq < cap) {
        walk(child, childDepth);
        child = child.nextElementSibling;
      }
      if (child) capped = true; // stopped before exhausting children → genuinely truncated
    };
    snapEpoch += 1;
    if (document.body) walk(document.body, 0);

    snapRefs = refs;
    return {
      url: location.href,
      title: document.title,
      count: seq,
      truncated: capped,
      epoch: snapEpoch,
      text: lines.join("\n"),
    };
  }

  // Convert a ref from the latest snapshot to the durable rich locator (same shape as a
  // manual pick). Refs are ephemeral: a navigation, a re-snapshot (bumps snapEpoch), or
  // the wrong tab invalidates them. When `epoch` is supplied it must match the current
  // snapshot, so a ref from a superseded snapshot can't silently resolve to a different
  // element that happens to share the same ref number.
  function locatorForRef(ref, epoch) {
    if (epoch != null && epoch !== snapEpoch)
      return { error: "ref from a stale snapshot (epoch " + epoch + " ≠ " + snapEpoch + ")" };
    const el = snapRefs.get(ref);
    if (!el) return { error: "unknown or stale ref: " + ref };
    if (!document.contains(el)) return { error: "ref detached from DOM: " + ref };
    return locatorOf(el);
  }

  // Reverse of locatorForRef: which snapshot ref (if any) does this element map to?
  // Used when the user PICKS an element during recording — we bind the pick back to the
  // ref the Agent was reasoning about (Phase 3). Match the element locatorOf actually
  // describes (its actionable form); return null if that isn't a snapshot node. We do NOT
  // climb past it to an ancestor landmark — `main`/`nav` are ancestors of almost anything,
  // so climbing would bind an unrelated click to a landmark ref (wrong + misleading).
  function elementToRef(el) {
    const target = actionable(el);
    for (const [ref, node] of snapRefs) if (node === target) return ref;
    return null;
  }

  // Execute one DSL step in-page via SYNTHETIC events. Superseded by the CDP
  // trusted-input executor in background.js (Phase 1) — kept as the documented DSL
  // semantics and an untrusted-fallback path. `resolve`/`locatorOf` below are still
  // live (the CDP executor calls resolve to find the target's coordinates).
  function execStep(step) {
    try {
      if (step.action === "navigate") {
        // navigation is driven by the background worker (chrome.tabs.update);
        // reaching here means a same-page nav was requested.
        location.assign(step.url);
        return { ok: true };
      }
      const { el, error } = resolve(step.target || {});
      if (!el) return { ok: false, error };
      el.scrollIntoView({ block: "center", inline: "center" });
      if (step.action === "click") {
        el.click();
        return { ok: true };
      }
      if (step.action === "type") {
        el.focus();
        const proto =
          el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
        if (setter) setter.call(el, step.text || "");
        else el.value = step.text || "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        if (step.submit) {
          const form = el.form;
          if (form && form.requestSubmit) form.requestSubmit();
          else if (form) form.submit();
          else
            el.dispatchEvent(
              new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }),
            );
        }
        return { ok: true };
      }
      return { ok: false, error: "unknown action " + step.action };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 150) };
    }
  }

  // ── Pick mode: highlight on hover, capture rich locator on click ────────────
  let picking = false;
  let pickLabel = ""; // what the Agent asked the user to click (shown in the banner)
  let box = null;
  let banner = null;

  const bannerText = () =>
    pickLabel
      ? `CANVEX 点选:${pickLabel} —— 点击只记录该元素,不触发页面  (Esc 退出)`
      : "CANVEX PICKING — 点击不会触发页面,只会记录该元素  (Esc 退出)";

  function ensureChrome() {
    if (!box) {
      box = document.createElement("div");
      box.style.cssText =
        "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #10b981;background:rgba(16,185,129,.12);border-radius:3px;transition:all .03s";
      document.documentElement.appendChild(box);
    }
    if (!banner) {
      banner = document.createElement("div");
      banner.style.cssText =
        "position:fixed;z-index:2147483647;top:0;left:0;right:0;pointer-events:none;background:#065f46;color:#fff;font:600 13px/2.4 system-ui;text-align:center";
      document.documentElement.appendChild(banner);
    }
    banner.textContent = bannerText(); // refresh (label may have changed)
  }
  const move = (e) => {
    if (!picking) return;
    const el = actionable(e.target);
    const r = el.getBoundingClientRect();
    ensureChrome();
    box.style.left = r.x + "px";
    box.style.top = r.y + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
  };
  const click = (e) => {
    if (!picking) return;
    e.preventDefault();
    e.stopPropagation();
    const loc = locatorOf(e.target);
    const ref = elementToRef(e.target); // bind the pick back to the AXTree ref, if any
    try {
      chrome.runtime.sendMessage({ type: "canvex-picked", locator: loc, ref, epoch: snapEpoch });
    } catch (_) {}
  };
  const key = (e) => {
    if (picking && e.key === "Escape") stopPick();
  };
  function startPick(label) {
    pickLabel = label || "";
    if (picking) {
      ensureChrome(); // already armed → just refresh the banner to the new label
      return;
    }
    picking = true;
    ensureChrome();
    document.addEventListener("mousemove", move, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
  }
  function stopPick() {
    picking = false;
    document.removeEventListener("mousemove", move, true);
    document.removeEventListener("click", click, true);
    document.removeEventListener("keydown", key, true);
    if (box) box.remove();
    if (banner) banner.remove();
    box = banner = null;
  }

  window.__canvex = {
    locatorOf,
    resolve,
    execStep,
    snapshot,
    locatorForRef,
    elementToRef,
    startPick,
    stopPick,
    resolveFromPoint: (x, y) => locatorOf(document.elementFromPoint(x, y)),
  };
})();
