import { useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

import { useFrameAnchoredPanel } from "@/hooks/use-frame-anchored-panel";
import { imagePointToViewport, viewportRectToImageBox } from "@/lib/excalidraw-bounds";
import {
  findBrowseMonitorFrames,
  getBrowseMonitorImage,
} from "@/lib/canvas-browse-monitor-frame";
import type { FlowLocator } from "@/types/canvex";

/** Latest live screenshot for a monitor frame, keyed by frame id. Present while
 *  the turn that created the frame runs in THIS session; frames absent from the
 *  map render from their persisted customData URL (e.g. after a reload). */
export interface BrowseMonitorLive {
  image: string;
}

/** Interaction mode of the on-canvas browser. `watch` = passive (the agent drives);
 *  `pick` = a click resolves the element under it and does NOT trigger it (RPA
 *  authoring). Drive/takeover (real input dispatch for login) is a later addition. */
export type BrowserMode = "watch" | "pick";

interface BrowseMonitorOverlayProps {
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  /** Bumped every Excalidraw onChange tick — re-projects panels on pan/zoom/move. */
  tick: number;
  liveFrames: Record<string, BrowseMonitorLive>;
  /** RPA authoring plumbing. `pickable` is true once a flow_session token exists (a
   *  live authoring browser), which enables the Pick toggle + click-to-target. */
  mode: BrowserMode;
  onModeChange: (mode: BrowserMode) => void;
  onPick: (frameId: string, vx: number, vy: number) => void;
  viewport: { width: number; height: number } | null;
  picked: FlowLocator | null;
  pickable: boolean;
}

/**
 * The live-browser panels — the visual sibling of BrowseLogOverlay, sitting to the
 * right of each browse-log frame. Where the log shows WHY (the agent's reasoning),
 * this shows WHAT (the page itself). In RPA authoring the panel becomes interactive:
 * switch it to Pick mode and click an element to target it (the click resolves on the
 * LIVE DOM via a separate request; it does not trigger the element).
 */
export function BrowseMonitorOverlay({
  excalidrawApiRef,
  tick,
  liveFrames,
  mode,
  onModeChange,
  onPick,
  viewport,
  picked,
  pickable,
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
          mode={mode}
          onModeChange={onModeChange}
          onPick={onPick}
          viewport={viewport}
          picked={picked}
          pickable={pickable}
        />
      ))}
    </>
  );
}

function BrowseMonitorPanel({
  frame,
  excalidrawApiRef,
  live,
  mode,
  onModeChange,
  onPick,
  viewport,
  picked,
  pickable,
}: {
  frame: ExcalidrawElement;
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  live?: BrowseMonitorLive;
  mode: BrowserMode;
  onModeChange: (mode: BrowserMode) => void;
  onPick: (frameId: string, vx: number, vy: number) => void;
  viewport: { width: number; height: number } | null;
  picked: FlowLocator | null;
  pickable: boolean;
}) {
  const { t } = useTranslation("canvasUi");
  const imgRef = useRef<HTMLImageElement>(null);
  // Live streamed frame wins (this session's turn); else the persisted final URL.
  const image = live?.image || getBrowseMonitorImage(frame);
  const { scrollRef, rect, zoom, width, height } = useFrameAnchoredPanel(
    frame,
    excalidrawApiRef,
  );
  if (!rect) return null;

  const picking = pickable && mode === "pick";

  // Click on the (object-contain) screenshot → page-viewport px → onPick. Resolving
  // happens backend-side on the LIVE DOM, so this is accurate even if the frame lags.
  const handleImgClick = (e: React.MouseEvent) => {
    if (!picking || !viewport || !imgRef.current) return;
    e.stopPropagation();
    const vp = imagePointToViewport(
      imgRef.current.getBoundingClientRect(),
      e.clientX,
      e.clientY,
      viewport,
    );
    if (vp) onPick(frame.id, vp.vx, vp.vy);
  };

  // Last-picked element highlight, in the panel's world coord system (which then scales).
  const highlight =
    picked && viewport ? viewportRectToImageBox(picked.bbox, width, height, viewport) : null;

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
        outline: picking ? "6px solid rgba(16,185,129,0.9)" : undefined,
        outlineOffset: "-6px",
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Corner label — the frame's own name shows the "what"; keep this minimal. */}
      <div className="absolute left-4 top-3 z-10 rounded bg-black/50 px-3 py-1 text-[24px] font-medium uppercase tracking-wide text-emerald-400/80">
        {t("browseLog.monitorHeader")}
      </div>

      {/* Mode toggle — only when an authoring session is live. */}
      {pickable && (
        <div
          className="absolute right-4 top-3 z-20 flex gap-1 rounded bg-black/60 p-1"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {(["watch", "pick"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onModeChange(m);
              }}
              className={
                "rounded px-3 py-1 text-[22px] font-medium " +
                (mode === m
                  ? "bg-emerald-500 text-black"
                  : "text-white/70 hover:text-white")
              }
            >
              {t(m === "watch" ? "browseLog.modeWatch" : "browseLog.modePick")}
            </button>
          ))}
        </div>
      )}

      {image ? (
        <img
          ref={imgRef}
          src={image}
          alt=""
          onClick={handleImgClick}
          className={
            "h-full w-full object-contain " + (picking ? "cursor-crosshair" : "")
          }
        />
      ) : (
        <div className="flex h-full items-center justify-center text-[30px] text-white/40">
          {t("browseLog.monitorWaiting")}
        </div>
      )}

      {/* Pick highlight + label of the last resolved element. */}
      {highlight && picked && (
        <>
          <div
            className="pointer-events-none absolute z-10 rounded-sm border-[4px] border-amber-400"
            style={{
              left: highlight.left,
              top: highlight.top,
              width: highlight.width,
              height: highlight.height,
            }}
          />
          <div
            className="pointer-events-none absolute z-20 max-w-[70%] truncate rounded bg-amber-400 px-3 py-1 text-[22px] font-medium text-black"
            style={{ left: highlight.left, top: Math.max(0, highlight.top - 34) }}
          >
            {picked.role || picked.tag}
            {picked.name ? ` · ${picked.name}` : ""}
          </div>
        </>
      )}

      {/* Pick hint banner. */}
      {picking && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded bg-emerald-500/90 px-4 py-1 text-[22px] font-medium text-black">
          {t("browseLog.pickHint")}
        </div>
      )}
    </div>
  );
}
