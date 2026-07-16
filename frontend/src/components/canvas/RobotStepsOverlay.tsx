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

/** Stable empty-steps reference so the memo doesn't recompute on an empty panel. */
const EMPTY_STEPS: RobotStep[] = [];

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

/**
 * Editable step-cards panels anchored to the scene's robot-steps frames — the DSL of
 * the robot being authored, as clickable cards. Each pick appends a step; here the user
 * can change a step's action, edit type-text, or delete it. Sibling of BrowseLogOverlay
 * (native frames can't scroll, so the cards live in an HTML panel pinned to the frame).
 */
export function RobotStepsOverlay({
  excalidrawApiRef,
  tick,
  liveSteps,
  onEditSteps,
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
}: {
  frame: ExcalidrawElement;
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  live?: RobotStepsLive;
  onEditSteps: (frameId: string, steps: RobotStep[]) => void;
}) {
  const { t } = useTranslation("canvasUi");
  const persisted = useMemo(
    () => (live ? null : getRobotStepsFrameData(frame)),
    [live, frame],
  );
  const title = live?.title || persisted?.title || "";
  const steps = live?.steps ?? persisted?.steps ?? EMPTY_STEPS;

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
      <div className="sticky top-0 z-10 border-b border-white/10 bg-[#0b0f14]/95 px-6 py-4 backdrop-blur-sm">
        <div className="text-[28px] font-medium uppercase tracking-wide text-emerald-400/80">
          {t("browseLog.robotHeader")}
        </div>
        {title && (
          <div className="mt-1 line-clamp-2 text-[34px] leading-snug text-white/90">
            {title}
          </div>
        )}
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
              <span className="min-w-[48px] text-[30px] font-semibold text-emerald-400/80">
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
                  className="w-[280px] rounded bg-black/40 px-3 py-2 text-[26px] text-white placeholder:text-white/30"
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
