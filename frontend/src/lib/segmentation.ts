/**
 * Foreground/background segmentation via transformers.js (briaai/RMBG-1.4).
 *
 * 跑在浏览器, 优先 WebGPU, 退到 WASM. 模型 ~170MB, 自动缓存到 IndexedDB
 * 后续访问不再下载.
 *
 * License note: briaai/RMBG-1.4 是 "Bria license" — 免费用于非商业 / 研究.
 * 商业部署需要 Bria 商业授权或换成 MIT/Apache 模型 (Xenova/MODNet, 仅人像).
 * 模型 ID 集中在 MODEL_ID 一个常量里, 换模型时只改这里.
 */

import { AutoModel, AutoProcessor, RawImage } from "@huggingface/transformers";

import { disposeSilently, hasWebGPU, withWebGPURecovery } from "@/lib/transformers-env";

const MODEL_ID = "briaai/RMBG-1.4";

// Loose `any` for model + processor types — transformers.js doesn't ship
// strict types for AutoModel.from_pretrained's return shape across model
// configs. We only use the call-as-function + .input output narrow surface.
/* eslint-disable @typescript-eslint/no-explicit-any */
let modelRef: any = null;
let processorRef: any = null;
let initPromise: Promise<any> | null = null;

/** Drop cached model + processor. */
function resetModel(): void {
  const stale = modelRef;
  modelRef = null;
  processorRef = null;
  initPromise = null;
  disposeSilently(stale);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function getModel(): Promise<void> {
  if (modelRef) return;
  if (initPromise) {
    await initPromise;
    return;
  }
  const device = hasWebGPU() ? "webgpu" : "wasm";
  initPromise = Promise.all([
    AutoModel.from_pretrained(MODEL_ID, { device, dtype: device === "webgpu" ? "fp16" : "fp32" }),
    AutoProcessor.from_pretrained(MODEL_ID),
  ]).then(([m, p]) => {
    modelRef = m;
    processorRef = p;
  });
  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => resetModel());
}

/** Run RMBG-1.4 on a data URL and return a grayscale PNG dataURL of the
 *  foreground alpha mask. White = foreground (subject), black = background.
 *  Output dimensions match the input image. */
export async function computeForegroundMask(imageDataURL: string): Promise<string> {
  // Image decode + preprocessor are pure CPU work — only the model invocation
  // can hit a WebGPU pipeline error, so hoist the decode out of the recovery
  // body to avoid re-decoding on retry. processorRef config doesn't change
  // across re-init (same MODEL_ID), so the pixel_values stay valid.
  await getModel();
  if (!modelRef || !processorRef) throw new Error("segmentation model not ready");
  const image = await RawImage.fromURL(imageDataURL);
  const inputs = await processorRef(image);

  const { output } = await withWebGPURecovery("segmentation", resetModel, async () => {
    // After resetModel, modelRef is null again — re-init before invoking.
    if (!modelRef) await getModel();
    if (!modelRef) throw new Error("segmentation model not ready");
    return modelRef({ input: inputs.pixel_values });
  });

  // output: tensor of shape [1, 1, modelH, modelW] with values in [0, 1].
  // Convert to grayscale RawImage at original input size.
  const maskTensor = output[0].mul(255).to("uint8");
  const small = new RawImage(maskTensor.data, maskTensor.dims[2], maskTensor.dims[1], 1);
  const resized = await small.resize(image.width, image.height);

  // Encode as RGBA PNG via canvas.
  const w = resized.width;
  const h = resized.height;
  const channels = resized.channels;
  const rgba = new Uint8ClampedArray(w * h * 4);
  if (channels === 1) {
    for (let i = 0, j = 0; i < resized.data.length; i++, j += 4) {
      const v = resized.data[i];
      rgba[j] = v; rgba[j + 1] = v; rgba[j + 2] = v; rgba[j + 3] = 255;
    }
  } else if (channels === 4) {
    rgba.set(resized.data);
  } else {
    throw new Error(`unexpected mask channels: ${channels}`);
  }

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context for mask blit");
  ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
  return canvas.toDataURL("image/png");
}
