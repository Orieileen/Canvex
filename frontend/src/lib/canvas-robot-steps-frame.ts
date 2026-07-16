import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

import { CHAT_FRAME_WIDTH } from "@/lib/canvas-chat-frame";
import { getAiChatType } from "@/lib/excalidraw-custom-data";
import type { RobotStep } from "@/types/canvex";

/**
 * 「机器人步骤框」—— RPA 编写时用户点选的元素累积成的步骤 DSL,渲染成可编辑卡片
 * (RobotStepsOverlay)。跟 browse-log / monitor 一样是场景内的单例原生 frame;标记打在
 * customData.aiChatType,步骤本体存 customData 的 JSON 数组以便随场景 autosave + 重载还在。
 */
export const ROBOT_STEPS_FRAME_MARKER = "robot-steps-frame";

/** customData 键 —— 读写两侧必须一致 (autosave 回读同名键)。 */
export const ROBOT_STEPS_TITLE_KEY = "robotTitle";
export const ROBOT_STEPS_KEY = "robotSteps";
/** 是否允许该机器人执行「写操作」步骤 (提交表单 / 点支付·删除等) —— 默认 false (只读)。
 *  跟步骤一样存 customData 以便随场景 autosave + 重载还在, 保存时随 allow_writes 发给后端。 */
export const ROBOT_STEPS_ALLOW_WRITES_KEY = "robotAllowWrites";

/** 与主聊天框同宽,矮一些 —— 卡片自己滚动。 */
export const ROBOT_STEPS_FRAME_WIDTH = CHAT_FRAME_WIDTH;
export const ROBOT_STEPS_FRAME_HEIGHT = 1024;

export function isRobotStepsFrame(el: ExcalidrawElement): boolean {
  return (
    !el.isDeleted && el.type === "frame" && getAiChatType(el) === ROBOT_STEPS_FRAME_MARKER
  );
}

/** Sole writer of the stored shape (JSON array — faithful per-step round-trip). */
export function serializeRobotSteps(steps: RobotStep[]): string {
  return JSON.stringify(steps);
}

export function findRobotStepsFrames(
  elements: readonly ExcalidrawElement[],
): ExcalidrawElement[] {
  return elements.filter(isRobotStepsFrame);
}

/** 单例:当前 scene 的机器人步骤框 (第一个),没有则 null (跟 findChatFrame 一个路子)。 */
export function findRobotStepsFrame(
  elements: readonly ExcalidrawElement[],
): ExcalidrawElement | null {
  return elements.find(isRobotStepsFrame) ?? null;
}

/** 从一个步骤框读出标题 + 已持久化的步骤 + 是否允许写操作 (customData)。解析失败 / 非数组 → 空。 */
export function getRobotStepsFrameData(el: ExcalidrawElement): {
  title: string;
  steps: RobotStep[];
  allowWrites: boolean;
} {
  const cd = (el.customData ?? {}) as Record<string, unknown>;
  const title =
    typeof cd[ROBOT_STEPS_TITLE_KEY] === "string" ? (cd[ROBOT_STEPS_TITLE_KEY] as string) : "";
  const allowWrites = cd[ROBOT_STEPS_ALLOW_WRITES_KEY] === true;
  const raw = cd[ROBOT_STEPS_KEY];
  let steps: RobotStep[] = [];
  if (typeof raw === "string" && raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        steps = parsed.filter(
          (s): s is RobotStep =>
            !!s && typeof s === "object" && typeof (s as RobotStep).action === "string",
        );
      }
    } catch {
      steps = [];
    }
  }
  return { title, steps, allowWrites };
}
