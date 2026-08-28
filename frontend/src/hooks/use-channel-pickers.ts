import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";

import { canvasService } from "@/services/canvas.service";
import { useStickyModelChoice, type StickyModelChoice } from "@/hooks/use-sticky-model-choice";
import type { CanvasImageModelChoice } from "@/types/canvex";

/** 工具栏上的三个选择器 —— **chat 刻意不在里面**: 聊天模型是全局一条, 不是每次生成挑
 *  一个, 所以它只在配置面板里配, 没有工具栏入口。
 *
 *  这里的字符串是后端的 **picker** 而不是 kind: 一个选择器对应多种 kind (生图 = 内置
 *  image + 模板 custom_image), 按 kind 名字筛的话新加的那种配好了却不出现在选择器里,
 *  而且不报错。哪个 kind 喂哪个选择器由后端 KIND_SPECS 说, 随 schema 下发。
 *
 *  模块级常量 (不是 state / 不是 props): `.map` 出来的 hook 调用顺序必须每次渲染都一样。 */
const PICKER_KINDS = ["image", "angle", "video"] as const;
type PickerKind = (typeof PICKER_KINDS)[number];

// 选中的通道存这里 —— 粘性选择, 跨刷新保留。每种 kind 一个键: 模型集合不相交,
// 共用一个键会让切换 tab 时互相把对方清成默认。
const storageKey = (kind: PickerKind) => `canvex:${kind}-model`;

/** 一个选择器要的全部东西。前四项刻意跟 ImageModelSelector 的 props 同名, 直接摊开传。 */
export interface ChannelPicker {
  models: CanvasImageModelChoice[];
  value: string;
  onChange: (modelId: string) => void;
  onOpenSettings: () => void;
  /** 提交那一刻读最新值 —— 免得把它塞进每个 callback 的依赖数组。 */
  ref: RefObject<string>;
}

export type ChannelPickers = Record<PickerKind, ChannelPicker> & {
  /** 配置面板增删改完调它 —— 否则工具栏还列着已经删掉的通道。 */
  reload: () => void;
};

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

  // 一次请求拿回全部, 各选择器按 kind 自己筛 —— 几种接口形状都不同 (angle 的模型名在
  // URL 路径里、认证是 Key; video 是提交完再长轮询), 混着列会让人选到一个必然发不出去的
  // 组合。
  const byKind = useMemo(
    () =>
      Object.fromEntries(
        PICKER_KINDS.map((k) => [k, models?.filter((m) => m.picker === k) ?? null]),
      ) as Record<PickerKind, CanvasImageModelChoice[] | null>,
    [models],
  );

  // hook 不能进循环体的条件分支, 但可以按一个**长度恒定的模块级数组**逐个调 —— 顺序
  // 每次渲染都一样, 满足 hook 规则。
  const image = useStickyModelChoice(byKind.image, storageKey("image"));
  const angle = useStickyModelChoice(byKind.angle, storageKey("angle"));
  const video = useStickyModelChoice(byKind.video, storageKey("video"));
  const choices: Record<PickerKind, StickyModelChoice> = { image, angle, video };

  return useMemo(() => {
    const pack = (kind: PickerKind): ChannelPicker => ({
      models: byKind[kind] ?? [],
      value: choices[kind].value,
      onChange: choices[kind].setValue,
      onOpenSettings,
      ref: choices[kind].ref,
    });
    return {
      reload,
      image: pack("image"),
      angle: pack("angle"),
      video: pack("video"),
    };
    // choices 由下面三个 sticky 对象拼出来, 依赖列它们本身 (每个都是 useMemo 过的)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, byKind, image, angle, video, onOpenSettings]);
}
