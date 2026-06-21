import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

/**
 * 每个 scene 一个「聊天框」—— 一个原生 Excalidraw frame 元素, ChatFrameOverlay 把
 * 可滚动的聊天面板锚定在它上面。frame 本身可拖动/缩放/删除, 面板永远跟着它走。
 * 标记打在 customData.aiChatType 上 (跟旧的 note-text 同一字段, 方便统一识别)。
 */
export const CHAT_FRAME_MARKER = "chat-frame";
/** 旧版直接拼到画布上的聊天文字 (note-text); 建聊天框时一并清掉, 避免和面板里的
 *  历史重复显示。 */
export const CHAT_NOTE_MARKER = "note-text";

export const CHAT_FRAME_WIDTH = 2048;
export const CHAT_FRAME_HEIGHT = 2048;

function aiChatType(el: ExcalidrawElement): string | undefined {
  const cd = el.customData as { aiChatType?: unknown } | undefined;
  return typeof cd?.aiChatType === "string" ? cd.aiChatType : undefined;
}

/** 当前 scene 的聊天框 (原生 frame), 没有则返 null。 */
export function findChatFrame(
  elements: readonly ExcalidrawElement[],
): ExcalidrawElement | null {
  for (const el of elements) {
    if (!el.isDeleted && el.type === "frame" && aiChatType(el) === CHAT_FRAME_MARKER) {
      return el;
    }
  }
  return null;
}

/** 旧版聊天文字 pin —— 建聊天框时过滤掉。 */
export function isChatNoteElement(el: ExcalidrawElement): boolean {
  return aiChatType(el) === CHAT_NOTE_MARKER;
}
