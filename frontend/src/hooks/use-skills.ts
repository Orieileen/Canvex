import { useCallback, useEffect, useState } from "react";

import { canvasService } from "@/services/canvas.service";
import type { CanvasSkill } from "@/types/canvex";

/** agent 当前**看得见**哪些 skill —— SkillSelector popover 列的就是这个。
 *
 *  `reload` 给 SkillLibrary 面板用: 装/卸/停用之后不重拉的话, popover 里还列着已经
 *  卸掉的那条, 而用户刚在旁边的面板上亲手删了它。 */
export interface SkillList {
  skills: CanvasSkill[];
  reload: () => void;
}

/**
 * **必须挂在不随 scene 重挂载的那一层** (CanvexWorkspacePage), 不能挂在 CanvasArea ——
 * 后者按 sceneId 加了 key, 每换一张画布就整棵重建, 于是这份跟画布毫无关系的全局列表会
 * 跟着重新 GET 一遍。跟 useChannelPickers 搬上来的是同一个理由。
 *
 * 拉失败静默吞掉: skill 列表拉不到只是没法用 SkillSelector (它在 `skills` 为空时
 * 干脆不渲染), 不该把聊天主流程也拖下水。
 */
export function useSkills(): SkillList {
  const [skills, setSkills] = useState<CanvasSkill[]>([]);

  const reload = useCallback(() => {
    canvasService
      .listSkills()
      .then((resp) => setSkills(resp.data))
      .catch((err) => {
        console.warn("[canvas] failed to load skill list", err);
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { skills, reload };
}
