import { useEffect, useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

import { elementScreenRect } from "@/lib/excalidraw-bounds";
import { forwardWheelToExcalidrawCanvas } from "@/lib/excalidraw-wheel-forward";
import {
  findBrowseLogFrames,
  getBrowseLogFrameData,
} from "@/lib/canvas-browse-log-frame";

/** Live per-turn transcript for a browse-log frame, keyed by frame id. Present
 *  while (and after) the turn that created the frame runs in THIS session;
 *  frames absent from the map render from their persisted customData instead
 *  (e.g. after a page reload). */
export interface BrowseLogLive {
  title: string;
  lines: string[];
}

interface BrowseLogOverlayProps {
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  /** Bumped every Excalidraw onChange tick — re-projects panels on pan/zoom/move
   *  (mirrors the sibling overlays). */
  tick: number;
  liveLogs: Record<string, BrowseLogLive>;
}

/**
 * Scrollable log panels anchored to the scene's browse-log frames — the sibling
 * of ChatFrameOverlay, one panel per frame. Each frame narrates one browse
 * tool-run (browser-use's step log), titled with the message that triggered it.
 * Native frames can't scroll their contents, so the log lives in these HTML
 * panels (not canvas text); each tracks its frame's live screen rect every tick,
 * so it moves/zooms with the frame and stays pinned inside it.
 */
export function BrowseLogOverlay({
  excalidrawApiRef,
  tick,
  liveLogs,
}: BrowseLogOverlayProps) {
  void tick; // re-render trigger; live state read fresh below
  const api = excalidrawApiRef.current;
  if (!api) return null;
  const frames = findBrowseLogFrames(api.getSceneElements());
  if (!frames.length) return null;

  return (
    <>
      {frames.map((frame) => (
        <BrowseLogPanel
          key={frame.id}
          frame={frame}
          excalidrawApiRef={excalidrawApiRef}
          live={liveLogs[frame.id]}
        />
      ))}
    </>
  );
}

function BrowseLogPanel({
  frame,
  excalidrawApiRef,
  live,
}: {
  frame: ExcalidrawElement;
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  live?: BrowseLogLive;
}) {
  const { t } = useTranslation("canvasUi");
  const scrollRef = useRef<HTMLDivElement>(null);

  const api = excalidrawApiRef.current;
  const app = api?.getAppState();
  const zoom = app?.zoom?.value ?? 1;
  const rect =
    app
      ? elementScreenRect(frame, {
          zoom,
          scrollX: app.scrollX ?? 0,
          scrollY: app.scrollY ?? 0,
        })
      : null;

  // Live transcript wins (this session's turn); else fall back to the text
  // persisted in customData (survived a reload).
  const persisted = getBrowseLogFrameData(frame);
  const title = live?.title || persisted.title;
  const lines =
    live?.lines ?? (persisted.log ? persisted.log.split("\n") : []);

  // Stick to the bottom as lines stream in.
  const lineCount = lines.length;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lineCount]);

  // Wheel routing gated on selection (mirrors ChatFrameOverlay):
  //   frame SELECTED → wheel scrolls the log; NOT selected → forwarded to canvas
  //   (pan); a zoom gesture (ctrl/⌘+wheel) always drives canvas zoom.
  const frameId = frame.id;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const isZoom = e.ctrlKey || e.metaKey;
      const api = excalidrawApiRef.current;
      const selected = !!api?.getAppState().selectedElementIds?.[frameId];
      if (selected && !isZoom) {
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      forwardWheelToExcalidrawCanvas(e);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [frameId, excalidrawApiRef]);

  if (!rect) return null;
  const width = frame.width;
  const height = frame.height;

  return (
    <div
      ref={scrollRef}
      className="absolute z-30 overflow-y-auto overflow-x-hidden overscroll-contain rounded-sm bg-[#0b0f14]/95 shadow-sm"
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
      {/* Header: the triggering user message. Sticky so it stays visible while
          the log scrolls. */}
      <div className="sticky top-0 border-b border-white/10 bg-[#0b0f14]/95 px-6 py-4 backdrop-blur-sm">
        <div className="text-[28px] font-medium uppercase tracking-wide text-emerald-400/80">
          {t("browseLog.header")}
        </div>
        {title && (
          <div className="mt-1 line-clamp-2 text-[36px] leading-snug text-white/90">
            {title}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1 p-6 font-mono text-[30px] leading-relaxed text-emerald-200/90">
        {lines.length === 0 ? (
          <p className="text-white/40">{t("browseLog.waiting")}</p>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-words">
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
