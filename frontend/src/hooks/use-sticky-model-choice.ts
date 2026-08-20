import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { CanvasImageModelChoice } from "@/types/canvex";

export interface StickyModelChoice {
  /** 当前选中的 ImageModel.id。只有在**一个通道都没配**时才是空 —— 列表非空时这里
   *  一定是一条真实存在的记录 (见下面的自动落位)。 */
  value: string;
  setValue: (id: string) => void;
  /** 提交那一刻读最新值, 免得把它塞进每个 callback 的依赖数组。 */
  ref: RefObject<string>;
}

/**
 * 一个"粘的"模型选择 —— localStorage 初值 + ref 同步 + 配置被删后自动退回默认。
 *
 * **粘的**: 画布是连续多轮的, 每次生成都重选很烦; 这跟 per-message 的 SkillSelector
 * 刻意相反。
 *
 * 生图和 angle 各要一份 —— 两边的模型集合不相交 (fal 的视角模型发不了生图请求, 反之
 * 亦然), 共用一个 id 只会让其中一边永远选不中。抽成 hook 而不是抄第二遍: 这四件事一件
 * 都不能少, 手抄必然漏掉最后那条"配置被删后退回默认"。
 *
 * `models` 传**已按 kind 筛过**的那份。null = 还没成功拉到 (加载中 / 请求失败),
 * [] = 确实一个都没配。这个区分是必需的: 空列表说明"选中的那个真的没了"该清掉, 拉取
 * 失败只说明这次没问到, 拿它去清用户的选择是错的。
 */
export function useStickyModelChoice(
  models: CanvasImageModelChoice[] | null,
  storageKey: string,
): StickyModelChoice {
  const [value, setValue] = useState<string>(() => {
    try {
      return window.localStorage.getItem(storageKey) ?? "";
    } catch {
      return ""; // 隐私模式下 localStorage 会抛
    }
  });

  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
    try {
      window.localStorage.setItem(storageKey, value);
    } catch {
      // 持久化失败不影响本次会话
    }
  }, [value, storageKey]);

  // 选择自动落位到列表第一条, 两种情况都靠它:
  //   - 选中的配置被删/停用了 —— 不清掉的话会一直发一个死 id (提交那条走
  //     PrimaryKeyRelatedField 会 400), 而这个选择是粘的, 会一直粘到用户自己清
  //     localStorage。
  //   - 从来没选过 (首次打开) —— 以前这里停在空值 = 「后端默认」, 那一项已经去掉了,
  //     所以空值必须落到一个真实通道上, 否则用户看到的是个没有含义的空按钮。
  // 判据是"拉到了列表且里面没有当前值"。列表为 [] (供应商删光了) 时留空, 那时候没有
  // 任何可落的位置, 选择器会显示引导去配置的空态。
  useEffect(() => {
    if (!models) return; // null = 这次没问到, 不能据此动用户的选择
    if (models.length === 0) {
      if (value) setValue("");
      return;
    }
    if (!models.some((m) => m.id === value)) setValue(models[0].id);
  }, [models, value]);

  // 只在 value 真的变了时换身份 —— setValue 和 ref 本来就是稳定的。返回一个新字面量的
  // 话, 上层 useChannelPickers 那个 useMemo 会把它当成"变了", 于是每次渲染都重建整个
  // ChannelPickers 和三个 picker 的 props 对象, 那个 useMemo 就白写了。
  return useMemo(() => ({ value, setValue, ref }), [value]);
}
