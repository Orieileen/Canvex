import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
} from "@excalidraw/excalidraw/element/types";

/**
 * Typed accessors for the `customData` we attach to Excalidraw elements.
 * Centralized so a field rename propagates once; call sites stay string-free.
 */

/** The `customData.aiChatType` tag we stamp on managed elements (chat frame,
 *  browse-log frame, note pins, placeholders), or undefined for anything we
 *  didn't create. Single accessor so a field rename propagates once. */
export function getAiChatType(el: ExcalidrawElement): string | undefined {
  const cd = el.customData as { aiChatType?: unknown } | undefined;
  return typeof cd?.aiChatType === "string" ? cd.aiChatType : undefined;
}

/** Returns the canonical source URL we stamped when pinning a chat/toolbar
 *  image, or null if this isn't one (user drag-drop / shape / mismatched el). */
export function getAiChatImageUrl(el: ExcalidrawElement): string | null {
  if (el.type !== "image") return null;
  const url = (el as ExcalidrawImageElement).customData?.aiChatImageUrl;
  return typeof url === "string" && url.length > 0 ? url : null;
}
