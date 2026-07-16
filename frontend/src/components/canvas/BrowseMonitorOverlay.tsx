import { useRef, useState, type RefObject } from "react";
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
 *  `pick` = a click RESOLVES the element under it and does NOT trigger it (RPA
 *  authoring); `drive` = takeover — a click/keystroke is REAL input (log in / captcha).
 *  Pick and drive are distinct server endpoints; drive frames are never persisted. */
export type BrowserMode = "watch" | "pick" | "drive";

/** One drive (real input) action + its payload. */
export interface DriveAction {
  action: "click" | "type" | "key";
  x?: number;
  y?: number;
  text?: string;
  key?: string;
}

interface BrowseMonitorOverlayProps {
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  /** Bumped every Excalidraw onChange tick — re-projects panels on pan/zoom/move. */
  tick: number;
  liveFrames: Record<string, BrowseMonitorLive>;
  /** RPA authoring plumbing. `pickable` is true once a flow_session token exists (a
   *  live authoring browser), which enables Pick + Drive. */
  mode: BrowserMode;
  onModeChange: (mode: BrowserMode) => void;
  onPick: (frameId: string, vx: number, vy: number) => void;
  /** Drive (real input) — click/type/key on the live page (login / captcha). */
  onDrive: (frameId: string, drive: DriveAction) => void;
  viewport: { width: number; height: number } | null;
  picked: FlowLocator | null;
  pickable: boolean;
}

/**
 * The live-browser panels — the visual sibling of BrowseLogOverlay. Where the log shows
 * WHY (the agent's reasoning), this shows WHAT (the page). In RPA authoring the panel is
 * interactive: Pick mode click = resolve an element (no trigger); Drive mode click /
 * keystroke = REAL input so the user can log in / pass a captcha. The two are visually
 * unmistakable (green vs red chrome) because in drive a click actually fires.
 */
export function BrowseMonitorOverlay({
  excalidrawApiRef,
  tick,
  liveFrames,
  mode,
  onModeChange,
  onPick,
  onDrive,
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
          onDrive={onDrive}
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
  onDrive,
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
  onDrive: (frameId: string, drive: DriveAction) => void;
  viewport: { width: number; height: number } | null;
  picked: FlowLocator | null;
  pickable: boolean;
}) {
  const { t } = useTranslation("canvasUi");
  const imgRef = useRef<HTMLImageElement>(null);
  const [driveText, setDriveText] = useState("");
  // Live streamed frame wins (this session's turn); else the persisted final URL.
  const image = live?.image || getBrowseMonitorImage(frame);
  const { scrollRef, rect, zoom, width, height } = useFrameAnchoredPanel(
    frame,
    excalidrawApiRef,
  );
  if (!rect) return null;

  const picking = pickable && mode === "pick";
  const driving = pickable && mode === "drive";

  // Click on the (object-contain) screenshot. Pick mode → resolve (onPick); drive mode →
  // REAL click (onDrive). Both map screen px → page-viewport px the same way.
  const handleImgClick = (e: React.MouseEvent) => {
    if ((!picking && !driving) || !viewport || !imgRef.current) return;
    e.stopPropagation();
    const vp = imagePointToViewport(
      imgRef.current.getBoundingClientRect(),
      e.clientX,
      e.clientY,
      viewport,
    );
    if (!vp) return;
    if (picking) onPick(frame.id, vp.vx, vp.vy);
    else onDrive(frame.id, { action: "click", x: vp.vx, y: vp.vy });
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
        outline: driving
          ? "6px solid rgba(239,68,68,0.95)"
          : picking
            ? "6px solid rgba(16,185,129,0.9)"
            : undefined,
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
          {(["watch", "pick", "drive"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onModeChange(m);
              }}
              className={
                "rounded px-3 py-1 text-[22px] font-medium " +
                (mode !== m
                  ? "text-white/70 hover:text-white"
                  : m === "drive"
                    ? "bg-red-500 text-white"
                    : m === "pick"
                      ? "bg-emerald-500 text-black"
                      : "bg-white/80 text-black")
              }
            >
              {t(
                m === "watch"
                  ? "browseLog.modeWatch"
                  : m === "pick"
                    ? "browseLog.modePick"
                    : "browseLog.modeDrive",
              )}
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
            "h-full w-full object-contain " +
            (picking ? "cursor-crosshair" : driving ? "cursor-pointer" : "")
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

      {/* Drive banner — REAL input. Unmistakably red; carries a type/Enter affordance so
          the user can fill a login form (click a field, type, Enter). */}
      {driving && (
        <div
          className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded bg-red-500/95 px-4 py-2"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className="text-[22px] font-semibold uppercase tracking-wide text-white">
            {t("browseLog.driveHint")}
          </span>
          <input
            value={driveText}
            onChange={(e) => setDriveText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                onDrive(frame.id, { action: "type", text: driveText });
                onDrive(frame.id, { action: "key", key: "Enter" });
                setDriveText("");
              }
            }}
            placeholder={t("browseLog.driveTypePlaceholder")}
            className="w-[220px] rounded bg-black/40 px-3 py-1 text-[22px] text-white placeholder:text-white/40"
          />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDrive(frame.id, { action: "type", text: driveText });
              setDriveText("");
            }}
            className="rounded bg-white/20 px-3 py-1 text-[22px] text-white hover:bg-white/30"
          >
            {t("browseLog.driveType")}
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDrive(frame.id, { action: "key", key: "Enter" });
            }}
            className="rounded bg-white/20 px-3 py-1 text-[22px] text-white hover:bg-white/30"
          >
            {t("browseLog.driveEnter")}
          </button>
        </div>
      )}
    </div>
  );
}
