import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
} from "@excalidraw/excalidraw/element/types";

/**
 * Typed accessors for the `customData` we attach to Excalidraw elements.
 * Centralized so a field rename propagates once; call sites stay string-free.
 */

/** Returns the canonical source URL we stamped when pinning a chat/toolbar
 *  image, or null if this isn't one (user drag-drop / shape / mismatched el). */
export function getAiChatImageUrl(el: ExcalidrawElement): string | null {
  if (el.type !== "image") return null;
  const url = (el as ExcalidrawImageElement).customData?.aiChatImageUrl;
  return typeof url === "string" && url.length > 0 ? url : null;
}
