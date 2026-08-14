import { useEffect, useRef, useState, type RefObject } from "react";

import type { CanvasImageModelChoice } from "@/types/canvex";

export interface StickyModelChoice {
  /** 当前选中的 ImageModel.id;空 = 用后端默认通道。 */
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

  // 配置被删掉后, 选中的那个可能已不存在 —— 退回默认, 否则会一直发一个死 id: 提交那条
  // 走 PrimaryKeyRelatedField 会 400, 而这个选择是粘的, 会一直粘着直到用户自己清
  // localStorage。判据是"拉到了列表且里面没有它" —— 把所有供应商都删光 (列表为 [])
  // 恰恰是最需要清掉它的那种情况, 所以不能要求列表非空。
  useEffect(() => {
    if (models && value && !models.some((m) => m.id === value)) setValue("");
  }, [models, value]);

  return { value, setValue, ref };
}
