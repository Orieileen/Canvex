import { useMemo, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

import { useFrameAnchoredPanel } from "@/hooks/use-frame-anchored-panel";
import {
  findRobotStepsFrames,
  getRobotStepsFrameData,
} from "@/lib/canvas-robot-steps-frame";
import type { RobotStep } from "@/types/canvex";

/** Stable empty refs so the memos don't recompute on empty panels. */
const EMPTY_STEPS: RobotStep[] = [];
const EMPTY_STATUS: Record<number, RunStatus> = {};

export type RunStatus = "running" | "ok" | "failed";

/** Live per-turn steps for a robot-steps frame, keyed by frame id. Present while the
 *  user is authoring in THIS session; frames absent from the map render from their
 *  persisted customData (e.g. after a reload). */
export interface RobotStepsLive {
  title: string;
  steps: RobotStep[];
}

interface RobotStepsOverlayProps {
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  /** Bumped every Excalidraw onChange tick — re-projects panels on pan/zoom/move. */
  tick: number;
  liveSteps: Record<string, RobotStepsLive>;
  onEditSteps: (frameId: string, steps: RobotStep[]) => void;
  onSave: (frameId: string) => void;
  onRun: (frameId: string) => void;
  /** Toggle the robot's write-gate opt-in (allow submits / pay·delete clicks). The
   *  current value is read from the frame's customData, so no companion state prop. */
  onToggleAllowWrites: (frameId: string, allow: boolean) => void;
  /** Per-frame, per-step-index status while a robot runs. */
  runStatus: Record<string, Record<number, RunStatus>>;
  /** frameId → saved robot id (presence enables Run). */
  savedFrames: Record<string, string>;
}

/** Human-readable target of a step: "role · name/text/css". */
function targetLabel(step: RobotStep): string {
  if (step.action === "navigate") return step.url || "";
  const tgt = step.target;
  if (!tgt) return "—";
  const head = tgt.name || tgt.text || tgt.css || tgt.tag;
  const role = tgt.role || tgt.tag;
  return head && head !== role ? `${role} · ${head}` : role;
}

const STATUS_DOT: Record<RunStatus, string> = {
  running: "bg-amber-400 animate-pulse",
  ok: "bg-emerald-400",
  failed: "bg-red-500",
};

/**
 * Editable step-cards panels anchored to the scene's robot-steps frames — the DSL of
 * the robot being authored, as clickable cards. Each pick appends a step; here the user
 * can change a step's action, edit type-text, delete it, or Save the list as a named
 * robot and Run it (per-step status streams back onto the cards).
 */
export function RobotStepsOverlay({
  excalidrawApiRef,
  tick,
  liveSteps,
  onEditSteps,
  onSave,
  onRun,
  onToggleAllowWrites,
  runStatus,
  savedFrames,
}: RobotStepsOverlayProps) {
  void tick; // re-render trigger; live state read fresh below
  const api = excalidrawApiRef.current;
  if (!api) return null;
  const frames = findRobotStepsFrames(api.getSceneElements());
  if (!frames.length) return null;

  return (
    <>
      {frames.map((frame) => (
        <RobotStepsPanel
          key={frame.id}
          frame={frame}
          excalidrawApiRef={excalidrawApiRef}
          live={liveSteps[frame.id]}
          onEditSteps={onEditSteps}
          onSave={onSave}
          onRun={onRun}
          onToggleAllowWrites={onToggleAllowWrites}
          status={runStatus?.[frame.id] ?? EMPTY_STATUS}
          saved={!!savedFrames?.[frame.id]}
        />
      ))}
    </>
  );
}

function RobotStepsPanel({
  frame,
  excalidrawApiRef,
  live,
  onEditSteps,
  onSave,
  onRun,
  onToggleAllowWrites,
  status,
  saved,
}: {
  frame: ExcalidrawElement;
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  live?: RobotStepsLive;
  onEditSteps: (frameId: string, steps: RobotStep[]) => void;
  onSave: (frameId: string) => void;
  onRun: (frameId: string) => void;
  onToggleAllowWrites: (frameId: string, allow: boolean) => void;
  status: Record<number, RunStatus>;
  saved: boolean;
}) {
  const { t } = useTranslation("canvasUi");
  const persisted = useMemo(
    () => (live ? null : getRobotStepsFrameData(frame)),
    [live, frame],
  );
  const title = live?.title || persisted?.title || "";
  const steps = live?.steps ?? persisted?.steps ?? EMPTY_STEPS;
  // allow_writes is persisted-only (customData), never part of live authoring state, so
  // read it straight from the frame (reuse `persisted` when it's already parsed).
  const allowWrites = (persisted ?? getRobotStepsFrameData(frame)).allowWrites;

  const { scrollRef, rect, zoom, width, height } = useFrameAnchoredPanel(
    frame,
    excalidrawApiRef,
    steps.length,
  );

  const edit = (i: number, patch: Partial<RobotStep>) =>
    onEditSteps(
      frame.id,
      steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
    );
  const remove = (i: number) =>
    onEditSteps(
      frame.id,
      steps.filter((_, idx) => idx !== i),
    );

  if (!rect) return null;

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
      <div className="sticky top-0 z-10 flex items-center gap-4 border-b border-white/10 bg-[#0b0f14]/95 px-6 py-4 backdrop-blur-sm">
        <div className="min-w-0 flex-1">
          <div className="text-[28px] font-medium uppercase tracking-wide text-emerald-400/80">
            {t("browseLog.robotHeader")}
          </div>
          {title && (
            <div className="mt-1 line-clamp-1 text-[34px] leading-snug text-white/90">
              {title}
            </div>
          )}
        </div>
        {/* Write-gate toggle — off (read-only) by default; amber when armed, since it lets
            the robot submit forms / click pay·delete. Value lives in the frame's customData. */}
        <button
          type="button"
          role="switch"
          aria-checked={allowWrites}
          title={t("browseLog.robotAllowWritesHint")}
          onClick={(e) => {
            e.stopPropagation();
            onToggleAllowWrites(frame.id, !allowWrites);
          }}
          className={
            "flex items-center gap-2 rounded px-5 py-2 text-[26px] font-medium " +
            (allowWrites
              ? "bg-amber-500 text-black hover:bg-amber-400"
              : "bg-white/10 text-white/70 hover:bg-white/20")
          }
        >
          <span
            className={
              "h-4 w-4 shrink-0 rounded-full " + (allowWrites ? "bg-black/70" : "bg-white/25")
            }
          />
          {t("browseLog.robotAllowWrites")}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSave(frame.id);
          }}
          className="rounded bg-white/10 px-5 py-2 text-[26px] font-medium text-white hover:bg-white/20"
        >
          {t("browseLog.robotSave")}
        </button>
        <button
          type="button"
          disabled={!saved}
          onClick={(e) => {
            e.stopPropagation();
            onRun(frame.id);
          }}
          className="rounded bg-emerald-500 px-5 py-2 text-[26px] font-medium text-black enabled:hover:bg-emerald-400 disabled:opacity-40"
        >
          {t("browseLog.robotRun")}
        </button>
      </div>

      <div className="flex flex-col gap-3 p-6">
        {steps.length === 0 ? (
          <p className="text-[28px] leading-relaxed text-white/40">
            {t("browseLog.robotEmpty")}
          </p>
        ) : (
          steps.map((step, i) => (
            <div
              key={i}
              className="flex items-center gap-3 rounded-md border border-white/10 bg-white/5 px-4 py-3"
            >
              <span
                className={
                  "h-4 w-4 shrink-0 rounded-full " +
                  (status[i] ? STATUS_DOT[status[i]] : "bg-white/15")
                }
              />
              <span className="min-w-[40px] text-[30px] font-semibold text-emerald-400/80">
                {i + 1}
              </span>
              <select
                value={step.action}
                onChange={(e) =>
                  edit(i, { action: e.target.value as RobotStep["action"] })
                }
                className="rounded bg-black/40 px-3 py-2 text-[26px] text-white"
              >
                <option value="click">{t("browseLog.stepClick")}</option>
                <option value="type">{t("browseLog.stepType")}</option>
                <option value="navigate">{t("browseLog.stepNavigate")}</option>
              </select>
              <span className="min-w-0 flex-1 truncate text-[28px] text-white/85">
                {targetLabel(step)}
              </span>
              {step.action === "type" && (
                <input
                  value={step.text ?? ""}
                  placeholder={t("browseLog.stepTypeText")}
                  onChange={(e) => edit(i, { text: e.target.value })}
                  className="w-[260px] rounded bg-black/40 px-3 py-2 text-[26px] text-white placeholder:text-white/30"
                />
              )}
              {step.provenance && (
                <span className="rounded bg-emerald-500/20 px-3 py-1 text-[22px] uppercase tracking-wide text-emerald-300/80">
                  {step.provenance}
                </span>
              )}
              <button
                type="button"
                onClick={() => remove(i)}
                title={t("browseLog.stepDelete")}
                className="rounded px-3 py-1 text-[32px] leading-none text-white/40 hover:text-red-400"
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
