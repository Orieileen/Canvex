import { parseAspect } from "@/lib/canvas-image-output-size";

/**
 * 预测一个视频生成 job 会出多大画幅, 让「生成中」的占位框按**真实分辨率**预留, 而不是
 * 一个写死的横向小框。生图那边的对应物是 `imageEditOutputSize`。
 *
 * **为什么不复用 imageEditOutputSize / resolutionEdgePx** —— 三条语义差, 每条都够毒死它:
 *  1. 视频档位 `720p` 是那张 1280×720 的**短边**, 不是边长。生图那边 budget = edge²,
 *     套到视频 16:9 会得到 960×540 而不是 1280×720 (每条边差 4/3 = √(16/9))。
 *  2. `2K` / `4k` 在视频里命名的是**长边** (4K = 3840×2160), 而 `resolutionEdgePx`
 *     里 `4K` = 4096 是**边长** —— 正好反过来, 套上去会算出 7282×4096。
 *  3. 认不出档位时生图回落 2048; 视频必须回落 720p —— 模型没报 allowed_resolutions 时
 *     前端发的是**空串** (ImageEditBar 的 `resolutions.length ? resolution : ""`),
 *     **一定**会走兜底, 而短边 2048 = 3640×2048, 比任何一家真出的都大。
 *
 * **签名里没有「用户选的比例」, 这是故意的。** 画布的视频面板恒为图生视频
 * (use-video-edit 硬性拒非 single-image), 而 sora-2 / wan2.5 / wan2.6 / wan2.7 /
 * kling-3.0-turbo / MiniMax-H3 的文档都写了: 传了参考图之后 aspect_ratio 失效, 方向由
 * 参考图决定 (wan2.5 更狠 —— 传了会报错)。方向只能来自源图。把 aspect 参数从签名里
 * **删掉**, 等于用类型消灭这一族特判, 而不是给每个模型写一个 if。
 *
 * APPROXIMATION —— 这只是个 transient 的加载框。供应商会把边长压到 16 的倍数
 * (480p 16:9 实测 832×480, 本函数算 853×480, 差 2.5%), 后端还会把档位 snap 到这个模型
 * 真收的那一档 (services/agent/tools/video.py 的 resolve_resolution), 前端都看不见。
 */

/** 视频档位的参考画幅是 16:9 —— 供应商保的是**像素面积**而不是短边: 720p 的
 *  16:9 / 9:16 / 1:1 分别是 1280×720 / 720×1280 / 960×960, 三个都是 921600 px。
 *  (apimart 全站只有 wan2.5 / wan2.6 两页给了像素映射表, 两家逐格一致。) */
const VIDEO_TIER_REFERENCE_RATIO = 16 / 9;

/** 认不出档位时的短边。跟 use-video-edit 的 DEFAULT_VIDEO_RESOLUTION 同一个数。 */
const DEFAULT_VIDEO_SHORT_EDGE = 720;

/** `NK` → 长边像素。2560 / 3840 是 UHD/DCI 的行业惯例, **不是** apimart 文档确认的
 *  (他们一页都没写 `2K` / `4k` 的像素)。表外的 K 值退回 n×1000 —— 够用, 这只是个框。 */
const K_TIER_LONG_EDGE: Record<number, number> = { 2: 2560, 4: 3840, 8: 7680 };

/** 视频画质档 → 短边像素。`720p` / `480p` / `1024p` / `768P` 里的数字直接就是短边;
 *  `2K` / `4k` 命名的是长边, 按 16:9 折回短边。认不出 → 720。 */
export function videoTierShortEdgePx(tier: string | undefined): number {
  const text = (tier ?? "").trim().toLowerCase();
  if (text.endsWith("p")) {
    const n = Number(text.slice(0, -1));
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  if (text.endsWith("k")) {
    const n = Number(text.slice(0, -1));
    if (Number.isFinite(n) && n > 0) {
      const longEdge = K_TIER_LONG_EDGE[n] ?? Math.round(n * 1000);
      return Math.round((longEdge * 9) / 16);
    }
  }
  return DEFAULT_VIDEO_SHORT_EDGE;
}

/** 画质档 + 源图宽高 → 这个视频大概出多大画幅。 */
export function videoOutputSize(
  resolution: string | undefined,
  source: { width: number; height: number },
): { width: number; height: number } {
  const shortEdge = videoTierShortEdgePx(resolution);
  const budget = shortEdge * shortEdge * VIDEO_TIER_REFERENCE_RATIO;

  let aw = source.width;
  let ah = source.height;
  // Degenerate (0 / 负 / NaN / Infinity) → 退回 16:9 而不是 1:1: 视频的中位形状是横屏。
  if (!Number.isFinite(aw) || aw <= 0 || !Number.isFinite(ah) || ah <= 0) {
    aw = 16;
    ah = 9;
  }
  // Clamp 同 imageEditOutputSize: 挡住 agent 幻觉出的荒唐比例 —— Infinity 几何会污染
  // placeholder 元素, 存盘时连整个 scene 一起坏。上界覆盖所有真实比例 (≤ 21:9 ≈ 2.33)。
  const ratio = Math.min(16, Math.max(1 / 16, aw / ah));
  return {
    width: Math.round(Math.sqrt(budget * ratio)),
    height: Math.round(Math.sqrt(budget / ratio)),
  };
}

/** **只给 agent 那条路用。** 那边手上没有源图元素 (generate_video 的
 *  `reference_image_urls` 只是 URL, 前端**同步**拿不到宽高, 而 createPlaceholder 是
 *  同步函数), 只能拿 tool-call 里的 `aspect_ratio` 当方向。带参考图时供应商实际按参考图
 *  定向, 所以这是个**猜** —— 猜错也只影响加载框的形状, 而工具栏那条主路径有真源图。
 *
 *  认不出 / 没给 → 16:9, 跟后端 generate_video 的默认值一致。
 *  **工具栏那条路不要用它。** */
export function videoAspectSource(aspect: string | undefined): { width: number; height: number } {
  const parsed = parseAspect(aspect);
  return parsed ? { width: parsed.w, height: parsed.h } : { width: 16, height: 9 };
}
