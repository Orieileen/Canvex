import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

import {
  DEFAULT_ADJUSTMENTS,
  DEFAULT_COLOR_MIX,
  isColorMixActive,
  type ColorMix,
  type ImageAdjustments,
} from "@/lib/image-adjustments";

/**
 * 调色绑定 — 存在图片元素的 `customData.adjust`。调整是非破坏性的常驻图层:
 * 原图文件不变,`ImageAdjustOverlay` 按绑定把调好的样子就地叠在原图上(无新图),
 * 面板关掉/切走也保持;`reset` 删绑定即还原原图。镜像 `canvas-mockup.ts` 的写法。
 */
export interface AdjustBinding {
  values: ImageAdjustments;
  colorMix: ColorMix;
}

export const ADJUST_CUSTOM_DATA_KEY = "adjust" as const;

export const DEFAULT_ADJUST_BINDING: AdjustBinding = {
  values: DEFAULT_ADJUSTMENTS,
  colorMix: DEFAULT_COLOR_MIX,
};

/** 全 0 + colorMix 中性 → 视为无调整(overlay 跳过、reset 删绑定、重置按钮隐藏)。 */
export function isAdjustNeutral(binding: AdjustBinding): boolean {
  if (Object.values(binding.values).some((n) => n !== 0)) return false;
  return !isColorMixActive(binding.colorMix);
}

/** 防御性读取 —— customData 是 `Record<string, unknown>`,持久化数据可能畸形。
 *  缺字段用默认补齐(向后兼容旧绑定);形状不符返回 null。 */
export function getAdjustBinding(el: ExcalidrawElement): AdjustBinding | null {
  const cd = el.customData;
  if (!cd || typeof cd !== "object") return null;
  const raw = (cd as Record<string, unknown>)[ADJUST_CUSTOM_DATA_KEY];
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Partial<AdjustBinding>;
  if (!b.values || typeof b.values !== "object") return null;
  return {
    values: { ...DEFAULT_ADJUSTMENTS, ...(b.values as Partial<ImageAdjustments>) },
    colorMix: { ...DEFAULT_COLOR_MIX, ...((b.colorMix as Partial<ColorMix>) ?? {}) },
  };
}

/** customData patch:写入/更新 adjust 绑定,保留其他 key。 */
export function withAdjustBinding(
  existingCustomData: ExcalidrawElement["customData"],
  binding: AdjustBinding,
): Record<string, unknown> {
  return {
    ...((existingCustomData as Record<string, unknown> | undefined) ?? {}),
    [ADJUST_CUSTOM_DATA_KEY]: binding,
  };
}

/** customData patch:删除 adjust 绑定(还原原图),保留其他 key。 */
export function withoutAdjustBinding(
  existingCustomData: ExcalidrawElement["customData"],
): Record<string, unknown> {
  const cd = (existingCustomData as Record<string, unknown> | undefined) ?? {};
  const { [ADJUST_CUSTOM_DATA_KEY]: _drop, ...rest } = cd;
  void _drop;
  return rest;
}
