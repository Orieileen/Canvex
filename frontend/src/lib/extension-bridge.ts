// Talks to the Canvex RPA browser extension (if the user installed it) via
// window.postMessage, relayed by the extension's `canvas-bridge` content script.
// No extension ID / externally_connectable needed — the content script only
// loads on the Canvex origin and bridges page <-> background.

type BridgeInbound = {
  __canvexFrom?: "ext";
  payload?: { type?: string; command_id?: string | null; evt?: RobotRunEvent; [k: string]: unknown };
};

function post(payload: unknown) {
  window.postMessage({ __canvexTo: "ext", payload }, window.location.origin);
}

/** Fire-and-forget one message to the extension (no reply awaited) — e.g. to disarm a
 *  pick banner (`canvex-pick-stop`) that outlived the Agent's request. */
export function postToExtension(payload: Record<string, unknown>): void {
  post(payload);
}

/** Resolve true if the Canvex extension answers a ping within `timeoutMs`. */
export function detectExtension(timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMsg);
      resolve(v);
    };
    const onMsg = (e: MessageEvent<BridgeInbound>) => {
      if (e.source !== window || e.data?.__canvexFrom !== "ext") return;
      if (e.data.payload?.type === "canvex-ready") finish(true);
    };
    window.addEventListener("message", onMsg);
    post({ type: "canvex-ping" });
    setTimeout(() => finish(false), timeoutMs);
  });
}

export type RobotRunEvent =
  | { type: "step"; index: number; action: string; status: "running" | "ok" | "failed"; error?: string }
  | { type: "done"; ok: boolean; ran: number; steps: number };

/** Send ONE command to the extension and resolve with its reply payload, correlated by
 *  `command_id` (the extension echoes it on every Phase-4 reply). Used to relay the Agent's
 *  `ext_command` frames (open-tab / snapshot / pick-start / ref-locator). Resolves
 *  `{ error }` on timeout so the caller can report it back to the backend rather than hang.
 *  `timeoutMs` should exceed the backend's wait for that op — a human pick is slow. */
export function sendExtCommand(
  payload: { type: string; command_id: string; [k: string]: unknown },
  timeoutMs = 30000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: Record<string, unknown>) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMsg);
      resolve(result);
    };
    const onMsg = (e: MessageEvent<BridgeInbound>) => {
      if (e.source !== window || e.data?.__canvexFrom !== "ext") return;
      const p = e.data.payload;
      if (p && p.command_id === payload.command_id) finish(p as Record<string, unknown>);
    };
    window.addEventListener("message", onMsg);
    post(payload);
    setTimeout(() => finish({ error: "extension command timed out" }), timeoutMs);
  });
}

/** Send a robot's steps to the extension to run in the user's browser (a fresh
 *  tab, real IP + login state). `allowWrites` gates state-changing steps (submit / pay /
 *  delete) — the extension refuses them when false, parity with the server runner.
 *  `onEvent` fires per step + a final `done`. Returns an unsubscribe fn (auto-unsubscribes
 *  after `done`). */
export function runInBrowser(
  steps: unknown[],
  allowWrites: boolean,
  onEvent: (evt: RobotRunEvent) => void,
): () => void {
  const onMsg = (e: MessageEvent<BridgeInbound>) => {
    if (e.source !== window || e.data?.__canvexFrom !== "ext") return;
    const p = e.data.payload;
    if (p?.type === "canvex-run-event" && p.evt) {
      onEvent(p.evt);
      if (p.evt.type === "done") stop();
    }
  };
  const stop = () => window.removeEventListener("message", onMsg);
  window.addEventListener("message", onMsg);
  post({ type: "canvex-run", steps, allowWrites, newTab: true });
  return stop;
}
