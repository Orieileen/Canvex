import { env } from "@huggingface/transformers";

env.allowRemoteModels = true;
env.allowLocalModels = false;

/** True if the browser supports WebGPU. transformers.js silently falls back
 *  to WASM when we ask for webgpu and it's unavailable; this lets UI surface
 *  accurate "may take a few seconds on CPU" hints. */
export function hasWebGPU(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

/** Detect WebGPU pipeline / device corruption errors that warrant disposing
 *  the cached singleton and retrying with a fresh init.
 *
 *  Common triggers in dev: Vite HMR remounts the component but the module-
 *  level pipeline ref keeps pointing at an internally-broken WebGPU compute
 *  pipeline, so every subsequent inference fails the same way (`undefined.
 *  getBindGroupLayout`). In prod: GPUDevice can be lost on tab visibility
 *  change, GPU driver crash, or extended idle. Either way, the recovery is
 *  the same — toss the singleton, re-init.
 *
 *  Pattern matches the visible message text rather than error type because
 *  transformers.js wraps these in its own opaque execution-error class. */
export function isWebGPUPipelineError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message;
  return (
    m.includes("getBindGroupLayout") ||
    m.includes("device is destroyed") ||
    m.includes("device was lost") ||
    m.includes("GPUDevice")
  );
}

/** Run an inference body with single-shot WebGPU recovery: on a
 *  pipeline-corruption error, dispose the cached singleton via `reset()` and
 *  re-run `body()` once. A second failure (or a non-recovery error) bubbles.
 *
 *  Both consumers (depth + segmentation) share this envelope; per-call
 *  differences are encoded in `body()` (which fetches the fresh singleton
 *  internally) and `reset()` (which knows which module's cache to drop). */
export async function withWebGPURecovery<T>(
  label: string,
  reset: () => void,
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body();
  } catch (err) {
    if (!isWebGPUPipelineError(err)) throw err;
    console.warn(`[${label}] WebGPU pipeline error, retrying with fresh init:`, err);
    reset();
    return body();
  }
}

/** Best-effort async dispose for transformers.js pipeline / model singletons.
 *  `dispose()` is optional (older builds), can return sync-void or async-Promise
 *  depending on version, AND may throw synchronously on a corrupted instance.
 *  `try` covers the sync path; `Promise.resolve` + `.catch` covers the async one.
 *  Caller has already nulled the singleton ref and must keep moving. */
export function disposeSilently(target: { dispose?: () => unknown } | null): void {
  try {
    void Promise.resolve(target?.dispose?.()).catch(() => {});
  } catch {
    // sync throw from dispose() body — same recovery as async reject: ignore.
  }
}
