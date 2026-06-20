import { useCallback, useRef, type RefObject } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

/**
 * "Back to latest element" — canvex 同款交互。Agent 流式生成时, 用户可能
 * 已经把画布拖远; 一次点击把视口跳回最近改动 (`element.updated` 最大) 的元素,
 * 第二次点击切到次新, 再点回最新, 形成 latest ⇄ previous toggle, 方便比对前后.
 */

function getLatestPair(elements: readonly ExcalidrawElement[]) {
  const live = elements
    .filter((e) => !e.isDeleted)
    .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  return { latest: live[0] ?? null, previous: live[1] ?? null };
}

export function useBackToLatest(
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>,
) {
  const lastJumpedIdRef = useRef<string | null>(null);

  const jumpToLatest = useCallback(() => {
    const api = excalidrawApiRef.current;
    if (!api) return;
    const { latest, previous } = getLatestPair(api.getSceneElements());
    if (!latest) return;
    const target =
      previous && lastJumpedIdRef.current === latest.id ? previous : latest;
    lastJumpedIdRef.current = target.id;
    api.scrollToContent(target, {
      fitToViewport: false,
      animate: true,
      duration: 300,
    });
  }, [excalidrawApiRef]);

  return { jumpToLatest };
}
