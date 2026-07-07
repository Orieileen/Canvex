import { type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

import { useFrameAnchoredPanel } from "@/hooks/use-frame-anchored-panel";
import {
  findBrowseMonitorFrames,
  getBrowseMonitorImage,
} from "@/lib/canvas-browse-monitor-frame";

/** Latest live screenshot for a monitor frame, keyed by frame id. Present while
 *  the turn that created the frame runs in THIS session; frames absent from the
 *  map render from their persisted customData URL (e.g. after a reload). */
export interface BrowseMonitorLive {
  image: string;
}

interface BrowseMonitorOverlayProps {
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  /** Bumped every Excalidraw onChange tick — re-projects panels on pan/zoom/move. */
  tick: number;
  liveFrames: Record<string, BrowseMonitorLive>;
}

/**
 * The live-browser panels — the visual sibling of BrowseLogOverlay, sitting to the
 * right of each browse-log frame. Where the log shows WHY (the agent's reasoning),
 * this shows WHAT (the page itself), refreshed per browser-use step. During the
 * turn the image is a streamed JPEG data-URL (React state); after it settles, the
 * frame's persisted final-screenshot URL takes over (survives reload).
 */
export function BrowseMonitorOverlay({
  excalidrawApiRef,
  tick,
  liveFrames,
}: BrowseMonitorOverlayProps) {
  void tick; // re-render trigger; live state read fresh below
  const api = excalidrawApiRef.current;
  if (!api) return null;
  const frames = findBrowseMonitorFrames(api.getSceneElements());
  if (!frames.length) return null;

  return (
    <>
      {frames.map((frame) => (
        <BrowseMonitorPanel
          key={frame.id}
          frame={frame}
          excalidrawApiRef={excalidrawApiRef}
          live={liveFrames[frame.id]}
        />
      ))}
    </>
  );
}

function BrowseMonitorPanel({
  frame,
  excalidrawApiRef,
  live,
}: {
  frame: ExcalidrawElement;
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  live?: BrowseMonitorLive;
}) {
  const { t } = useTranslation("canvasUi");
  // Live streamed frame wins (this session's turn); else the persisted final URL.
  // (Not memoized: getBrowseMonitorImage is a single customData property read —
  // unlike BrowseLogPanel, whose memo guards a real JSON.parse.)
  const image = live?.image || getBrowseMonitorImage(frame);
  const { scrollRef, rect, zoom, width, height } = useFrameAnchoredPanel(
    frame,
    excalidrawApiRef,
  );
  if (!rect) return null;

  return (
    <div
      ref={scrollRef}
      className="absolute z-30 overflow-hidden rounded-sm bg-[#0b0f14]/95 shadow-sm"
      style={{
        left: rect.left,
        top: rect.top,
        width,
        height,
        transform: `scale(${zoom})`,
        transformOrigin: "top left",
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Corner label — the frame's own name shows the "what"; keep this minimal. */}
      <div className="absolute left-4 top-3 z-10 rounded bg-black/50 px-3 py-1 text-[24px] font-medium uppercase tracking-wide text-emerald-400/80">
        {t("browseLog.monitorHeader")}
      </div>
      {image ? (
        <img src={image} alt="" className="h-full w-full object-contain" />
      ) : (
        <div className="flex h-full items-center justify-center text-[30px] text-white/40">
          {t("browseLog.monitorWaiting")}
        </div>
      )}
    </div>
  );
}
