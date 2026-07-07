import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

import { CHAT_FRAME_WIDTH } from "@/lib/canvas-chat-frame";
import { getAiChatType } from "@/lib/excalidraw-custom-data";

/**
 * 「浏览日志框」—— 每次触发 browse 工具的对话轮各一个原生 Excalidraw frame，
 * 摞在主聊天框 (canvas-chat-frame) 下方。BrowseLogOverlay 把一个可滚动的日志
 * 面板锚在它上面 (跟 ChatFrameOverlay 同一套「像图片一样随缩放」的投影手法)。
 *
 * 标记同样打在 customData.aiChatType 上 (跟 chat-frame / note-text 同字段)。
 * 标题 (browseTitle) = 触发这轮的用户消息；日志正文 (browseLog) 落进 customData
 * 以便随场景自动保存、刷新后仍在 —— 直播期间前端用 React state 渲染，settle 时
 * 把累计文本写回 customData 持久化 (见 canvex-workspace)。
 */
export const BROWSE_LOG_FRAME_MARKER = "browse-log-frame";

/** customData 键 —— 字符串读写两侧必须一致 (场景 autosave 回读同名键)。
 *  browseLog 存的是「行数组的 JSON」而非换行拼接串:一条 browser-use 日志本身
 *  可能含换行 (如 Final Result 块),用 \n join+split 会把它拆成多行,重载后与
 *  直播视图不一致。存 JSON 数组则逐行忠实往返。 */
export const BROWSE_LOG_TITLE_KEY = "browseTitle";
export const BROWSE_LOG_TEXT_KEY = "browseLog";

/** 与主聊天框同宽 —— createBrowseLogFrame 把日志框对齐到聊天框的 x 并摞在其下方,
 *  等宽才对齐;直接引用 CHAT_FRAME_WIDTH (而非再写一个 2048 字面量) 让这个不变量
 *  在聊天框改宽时自动跟随。高度矮一些:日志是流水,面板自己滚动。 */
export const BROWSE_LOG_FRAME_WIDTH = CHAT_FRAME_WIDTH;
export const BROWSE_LOG_FRAME_HEIGHT = 1024;

export function isBrowseLogFrame(el: ExcalidrawElement): boolean {
  return (
    !el.isDeleted && el.type === "frame" && getAiChatType(el) === BROWSE_LOG_FRAME_MARKER
  );
}

/** Serialize the live line buffer for storage in customData (JSON array — see
 *  BROWSE_LOG_TEXT_KEY). Sole writer of the stored shape. */
export function serializeBrowseLog(lines: string[]): string {
  return JSON.stringify(lines);
}

/** 当前 scene 的所有浏览日志框 (按场景顺序)。 */
export function findBrowseLogFrames(
  elements: readonly ExcalidrawElement[],
): ExcalidrawElement[] {
  return elements.filter(isBrowseLogFrame);
}

/** 从一个浏览日志框读出标题 + 已持久化的日志行 (customData)。日志优先按 JSON
 *  数组解析 (逐行忠实往返);解析失败或非数组时回落到按 \n 切分 (兼容旧值 / 空)。 */
export function getBrowseLogFrameData(el: ExcalidrawElement): {
  title: string;
  lines: string[];
} {
  const cd = (el.customData ?? {}) as Record<string, unknown>;
  const title = typeof cd[BROWSE_LOG_TITLE_KEY] === "string" ? (cd[BROWSE_LOG_TITLE_KEY] as string) : "";
  const raw = cd[BROWSE_LOG_TEXT_KEY];
  let lines: string[] = [];
  if (typeof raw === "string" && raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) lines = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      // 极早期(JSON 化之前)写入的换行拼接值 —— 按 \n 尽量还原成行。
      lines = raw.split("\n");
    }
  }
  return { title, lines };
}
