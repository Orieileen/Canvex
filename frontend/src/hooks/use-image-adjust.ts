import { useCallback, type RefObject } from "react";
import { newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import type {
  AdjustKey,
  BandChannel,
  ColorBand,
  ImageAdjustments,
} from "@/lib/image-adjustments";
import {
  DEFAULT_ADJUST_BINDING,
  getAdjustBinding,
  withAdjustBinding,
  withoutAdjustBinding,
  type AdjustBinding,
} from "@/lib/canvas-adjust";

/**
 * 调色写入器 —— 调整值持久化在图片元素的 `customData.adjust`(见 canvas-adjust.ts)。
 * 无本地态、无 Apply:改值即就地生效(`ImageAdjustOverlay` 常驻渲染),原图文件不动,
 * `reset` 删绑定还原。面板显示的值由页面从 customData 重算后下传(同 mockup)。
 * 写入走 `newElementWith`(bump version)+ `updateScene`,Excalidraw 才认作真改动。
 */
export interface UseImageAdjust {
  setValue: (baseId: string, key: AdjustKey, value: number) => void;
  setBand: (baseId: string, band: ColorBand, channel: BandChannel, value: number) => void;
  reset: (baseId: string) => void;
  autoEnhance: (baseId: string) => void;
}

/** 魔棒:温和的一键增强预设。 */
const AUTO_ENHANCE: Partial<ImageAdjustments> = {
  light: 6,
  contrast: 10,
  vibrance: 14,
  clarity: 8,
};

export function useImageAdjust({
  excalidrawApiRef,
}: {
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
}): UseImageAdjust {
  const patchBinding = useCallback(
    (baseId: string, mutate: (b: AdjustBinding) => AdjustBinding) => {
      const api = excalidrawApiRef.current;
      if (!api) return;
      const elements = api.getSceneElements();
      const target = elements.find((el) => el.id === baseId);
      if (!target || target.type !== "image") return;
      const current = getAdjustBinding(target) ?? DEFAULT_ADJUST_BINDING;
      const updated = newElementWith(target, {
        customData: withAdjustBinding(target.customData, mutate(current)),
      });
      api.updateScene({ elements: elements.map((el) => (el.id === baseId ? updated : el)) });
    },
    [excalidrawApiRef],
  );

  const setValue = useCallback(
    (baseId: string, key: AdjustKey, value: number) => {
      patchBinding(baseId, (b) => ({ ...b, values: { ...b.values, [key]: value } }));
    },
    [patchBinding],
  );

  const setBand = useCallback(
    (baseId: string, band: ColorBand, channel: BandChannel, value: number) => {
      patchBinding(baseId, (b) => ({
        ...b,
        colorMix: { ...b.colorMix, [band]: { ...b.colorMix[band], [channel]: value } },
      }));
    },
    [patchBinding],
  );

  const autoEnhance = useCallback(
    (baseId: string) => {
      patchBinding(baseId, (b) => ({ ...b, values: { ...b.values, ...AUTO_ENHANCE } }));
    },
    [patchBinding],
  );

  const reset = useCallback(
    (baseId: string) => {
      const api = excalidrawApiRef.current;
      if (!api) return;
      const elements = api.getSceneElements();
      const target = elements.find((el) => el.id === baseId);
      if (!target || target.type !== "image" || !getAdjustBinding(target)) return;
      const updated = newElementWith(target, {
        customData: withoutAdjustBinding(target.customData),
      });
      api.updateScene({ elements: elements.map((el) => (el.id === baseId ? updated : el)) });
    },
    [excalidrawApiRef],
  );

  return { setValue, setBand, reset, autoEnhance };
}
