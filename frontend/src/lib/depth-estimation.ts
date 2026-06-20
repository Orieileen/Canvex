/**
 * Depth estimation via transformers.js (Depth-Anything-V2-Small).
 *
 * 跑在浏览器, 优先 WebGPU, 退到 WASM. 模型 + ONNX 运行时第一次访问会
 * 下载约 50MB, 浏览器自动缓存到 IndexedDB.
 *
 * 单例 pipeline —— 第一次调用时初始化 (lazy), 后续重用. 避免每次推理都
 * reload 模型 (会非常慢).
 */

import { pipeline, type DepthEstimationPipeline } from "@huggingface/transformers";

import { disposeSilently, hasWebGPU, withWebGPURecovery } from "@/lib/transformers-env";

export { hasWebGPU };

let pipelineRef: DepthEstimationPipeline | null = null;
let pipelinePromise: Promise<DepthEstimationPipeline> | null = null;

/** Drop the cached pipeline so the next call re-initializes from scratch.
 *  Used after WebGPU device-loss / pipeline-corruption errors and on Vite
 *  HMR dispose. */
function resetPipeline(): void {
  // Null first, dispose async — concurrent getPipeline() must see null
  // immediately so it kicks a fresh init instead of finding the half-dead ref.
  const stale = pipelineRef;
  pipelineRef = null;
  pipelinePromise = null;
  disposeSilently(stale);
}

/** Get (or lazily init) the depth-estimation pipeline. Concurrent callers
 *  share the same in-flight load. */
async function getPipeline(): Promise<DepthEstimationPipeline> {
  if (pipelineRef) return pipelineRef;
  if (pipelinePromise) return pipelinePromise;
  const device = hasWebGPU() ? "webgpu" : "wasm";
  pipelinePromise = pipeline("depth-estimation", "onnx-community/depth-anything-v2-small", {
    device,
    // fp16 on WebGPU = ~50% smaller model + faster inference; fp32 fallback on WASM
    dtype: device === "webgpu" ? "fp16" : "fp32",
  }) as Promise<DepthEstimationPipeline>;
  try {
    pipelineRef = await pipelinePromise;
    return pipelineRef;
  } finally {
    pipelinePromise = null;
  }
}

if (import.meta.hot) {
  // HMR reset — the most common trigger of `getBindGroupLayout undefined`
  // in dev is a Vite hot-update keeping the module singleton alive while
  // the underlying GPUDevice context drifts. Force re-init on every accept.
  import.meta.hot.dispose(() => resetPipeline());
}

/** Run depth estimation on a data URL. Returns a grayscale PNG dataURL of the
 *  depth map (same aspect ratio as input, scaled to model's input size).
 *
 *  Output mapping: pipeline output is a RawImage with depth values normalized
 *  to [0, 1] in a single channel. We render to an OffscreenCanvas (or fallback
 *  HTMLCanvasElement) and read out a PNG — that's what gets cached as a
 *  scene file alongside the original photo. */
export async function computeDepthMap(imageDataURL: string): Promise<string> {
  // Pipeline accepts URL strings (incl data URLs) and returns
  // { depth: RawImage, predicted_depth: Tensor }. We use the RawImage form
  // for direct canvas blit.
  const result = await withWebGPURecovery("depth-estimation", resetPipeline, async () => {
    const pipe = await getPipeline();
    return pipe(imageDataURL);
  });
  const depthImage = Array.isArray(result) ? result[0].depth : result.depth;
  if (!depthImage) throw new Error("depth pipeline returned no depth map");

  // RawImage has { data: Uint8ClampedArray, width, height, channels }
  // Channels for depth = 1; we expand to RGBA for canvas.
  const { data, width, height, channels } = depthImage;
  const rgba = new Uint8ClampedArray(width * height * 4);
  if (channels === 1) {
    for (let i = 0, j = 0; i < data.length; i++, j += 4) {
      const v = data[i];
      rgba[j] = v; rgba[j + 1] = v; rgba[j + 2] = v; rgba[j + 3] = 255;
    }
  } else if (channels === 3) {
    // Some pipeline configs return RGB depth viz; flatten to luminance
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
      const v = (data[i] + data[i + 1] + data[i + 2]) / 3;
      rgba[j] = v; rgba[j + 1] = v; rgba[j + 2] = v; rgba[j + 3] = 255;
    }
  } else if (channels === 4) {
    rgba.set(data);
  } else {
    throw new Error(`unexpected depth channels: ${channels}`);
  }

  // Orient the depth map so foreground is always BRIGHT — this matters
  // because (a) the mockup mask shader expects foreground = high values,
  // and (b) Depth-Anything-V2 outputs disparity but on some photos
  // (especially "subject on plain background") the model flips the
  // convention. Heuristic: center pixels are typically the subject; corners
  // are typically background. If corners are brighter than center, invert.
  if (shouldInvertDepth(rgba, width, height)) {
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = 255 - rgba[i];
      rgba[i + 1] = 255 - rgba[i + 1];
      rgba[i + 2] = 255 - rgba[i + 2];
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not acquire 2d canvas context for depth blit");
  const img = new ImageData(rgba, width, height);
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

/** Compare average brightness of the central 25% area vs the four corner
 *  patches. If corners are brighter (background closer than subject in DA's
 *  output), the depth map is "inverted" relative to our convention.
 *  Pure heuristic — works on photos with a single centered subject. */
function shouldInvertDepth(rgba: Uint8ClampedArray, w: number, h: number): boolean {
  const sample = (x0: number, y0: number, w0: number, h0: number) => {
    let sum = 0;
    let n = 0;
    for (let y = y0; y < y0 + h0; y += 4) {
      for (let x = x0; x < x0 + w0; x += 4) {
        sum += rgba[(y * w + x) * 4];
        n++;
      }
    }
    return n > 0 ? sum / n : 0;
  };
  const cw = Math.max(8, Math.floor(w * 0.25));
  const ch = Math.max(8, Math.floor(h * 0.25));
  const center = sample(Math.floor((w - cw) / 2), Math.floor((h - ch) / 2), cw, ch);
  const cornerSize = Math.max(8, Math.floor(Math.min(w, h) * 0.1));
  const corners = (
    sample(0, 0, cornerSize, cornerSize) +
    sample(w - cornerSize, 0, cornerSize, cornerSize) +
    sample(0, h - cornerSize, cornerSize, cornerSize) +
    sample(w - cornerSize, h - cornerSize, cornerSize, cornerSize)
  ) / 4;
  return corners > center;
}
