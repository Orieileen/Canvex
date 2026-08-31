/**
 * 画质档(分辨率档位)的解析与挑选。
 *
 * 住在 lib 而不是某个 hook 里: 生图和视频**两边都要用**, 而它不碰 React、service 或
 * 画布。放在 use-video-edit 里的话, 生图面板得从一个视频 hook 里 import 一个纯函数。
 *
 * **后端 `services/image_client.py` 有一份一模一样的** (`_resolution_value` /
 * `nearest_resolution`)。那边是真正的兜底 —— agent 挑的档、以及请求真正发出去前的归一
 * 都过它; 这边只负责让选择器不显示一个模型收不了的档。两边规则必须一致, 分叉的表现是
 * "界面上选的档和实际出图的档不一样", 而且没有任何报错。
 */

/** 一个画质档在「贵 / 清晰」这条轴上的位置 —— 约等于**边长像素**。认不出给 null。
 *
 *  `1K` → 1000, `4k` → 4000, `0.5K` → 500, `720p` → 720。
 *  `NMP` = N 百万像素 (flux-2 用这个计) → 换算成边长 1024×√N, 所以 `4MP` (2048²) 落在
 *  2K 附近而不是 4K 附近 —— 照字面读成 4 的话它会排到 0.5K 前面。 */
export function resolutionValue(tier: string): number | null {
  const text = tier.trim().toLowerCase();
  if (!text) return null;
  if (text.endsWith("mp")) {
    const mp = Number(text.slice(0, -2));
    return Number.isFinite(mp) && mp > 0 ? 1024 * Math.sqrt(mp) : null;
  }
  const unit = text.endsWith("k") ? 1000 : 1;
  const head = text.replace(/[pk]+$/, "");
  if (!head) return null;
  const value = Number(head);
  return Number.isFinite(value) ? value * unit : null;
}

/** 用户选的画质档 → 这个模型真的收的那一个。`allowed` 为空 = 原样返回。
 *
 *  先大小写不敏感对一遍(同一档各家写 `1K` / `1k`), 再挑数值最近的, 平手取低的那个 ——
 *  画质是按档计费的。 */
export function nearestResolution(want: string, allowed: readonly string[]): string {
  if (!allowed.length) return want;
  const hit = allowed.find((r) => r.toLowerCase() === want.trim().toLowerCase());
  if (hit) return hit;
  const target = resolutionValue(want);
  if (target === null) return allowed[0];
  let best = allowed[0];
  let bestScore = Infinity;
  let bestValue = Infinity;
  for (const tier of allowed) {
    const value = resolutionValue(tier);
    if (value === null) continue;
    const score = Math.abs(value - target);
    if (score < bestScore || (score === bestScore && value < bestValue)) {
      best = tier;
      bestScore = score;
      bestValue = value;
    }
  }
  return best;
}

/** 画质档 → 这一档大概出多少边长像素, 用来给生成中的占位框预留位置。
 *
 *  跟 `resolutionValue` 分开是因为两者量的不是一回事: 那个只要**顺序**对(所以 `2K` 记
 *  成 2000 就够), 这个要的是**真像素**(`2K` 是 2048)。混用的话占位框会小 2%, 不致命,
 *  但两个函数各自的取舍会互相拖累。
 *
 *  认不出时回落到 2048 —— 跟这个功能之前写死的默认值一样。 */
export function resolutionEdgePx(tier: string | undefined): number {
  const text = (tier ?? "").trim().toLowerCase();
  if (text.endsWith("mp")) {
    const mp = Number(text.slice(0, -2));
    if (Number.isFinite(mp) && mp > 0) return Math.round(1024 * Math.sqrt(mp));
  }
  if (text.endsWith("k")) {
    const n = Number(text.slice(0, -1));
    if (Number.isFinite(n) && n > 0) return Math.round(n * 1024);
  }
  if (text.endsWith("p")) {
    const n = Number(text.slice(0, -1));
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return 2048;
}
