import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";

import { canvasService } from "@/services/canvas.service";
import { useStickyModelChoice } from "@/hooks/use-sticky-model-choice";
import type { CanvasImageModelChoice } from "@/types/canvex";

// 选中的通道存这里 —— 粘性选择, 跨刷新保留。两种 kind 各一个键: 模型集合不相交,
// 共用一个键会让切换 tab 时互相把对方清成默认。
const IMAGE_MODEL_KEY = "canvex:image-model";
const ANGLE_MODEL_KEY = "canvex:angle-model";

/** 一个选择器要的全部东西。前四项刻意跟 ImageModelSelector 的 props 同名, 直接摊开传。 */
export interface ChannelPicker {
  models: CanvasImageModelChoice[];
  value: string;
  onChange: (modelId: string) => void;
  onOpenSettings: () => void;
  /** 提交那一刻读最新值 —— 免得把它塞进每个 callback 的依赖数组。 */
  ref: RefObject<string>;
}

export interface ChannelPickers {
  image: ChannelPicker;
  angle: ChannelPicker;
  /** 配置面板增删改完调它 —— 否则工具栏还列着已经删掉的通道。 */
  reload: () => void;
}

/**
 * 生图 / angle 两个通道选择器的全部状态。
 *
 * **必须挂在不随 scene 重挂载的那一层** (CanvexWorkspacePage), 不能挂在 CanvasArea ——
 * 后者按 sceneId 加了 key, 每换一张画布就整棵重建, 于是这份跟画布毫无关系的全局配置会
 * 跟着重新 GET 一遍, 中间还会闪回 null(两个选择器短暂显示"未配置")。
 *
 * 收成一个 hook 而不是把七八个 useState/useMemo 摊在页面组件里: 页面那一层只关心
 * "把它传给谁", 不关心它由哪几段状态拼出来。
 */
export function useChannelPickers(onOpenSettings: () => void): ChannelPickers {
  // null = 还没成功拉到 (首次加载中 / 请求失败), [] = 确实一个都没配 —— 这个区分被
  // useStickyModelChoice 用来判断该不该清掉失效的选择。
  const [models, setModels] = useState<CanvasImageModelChoice[] | null>(null);

  const reload = useCallback(() => {
    canvasService
      .listImageModels()
      .then(({ data }) => setModels(data))
      // 后端不可达 → 回到"未知", 选择器照常引导去配置页, 但不会据此清掉用户的选择
      .catch(() => setModels(null));
  }, []);
  useEffect(() => reload(), [reload]);

  // 一次请求拿回全部, 两个选择器各自按 kind 筛 —— 两边的接口形状不同 (angle 的模型名在
  // URL 路径里、认证是 Key), 混着列会让人选到一个必然发不出去的组合。
  const imageChoices = useMemo(
    () => models?.filter((m) => m.kind === "image") ?? null,
    [models],
  );
  const angleChoices = useMemo(
    () => models?.filter((m) => m.kind === "angle") ?? null,
    [models],
  );

  const image = useStickyModelChoice(imageChoices, IMAGE_MODEL_KEY);
  const angle = useStickyModelChoice(angleChoices, ANGLE_MODEL_KEY);

  return useMemo(
    () => ({
      reload,
      image: {
        models: imageChoices ?? [],
        value: image.value,
        onChange: image.setValue,
        onOpenSettings,
        ref: image.ref,
      },
      angle: {
        models: angleChoices ?? [],
        value: angle.value,
        onChange: angle.setValue,
        onOpenSettings,
        ref: angle.ref,
      },
    }),
    [reload, imageChoices, angleChoices, image, angle, onOpenSettings],
  );
}
