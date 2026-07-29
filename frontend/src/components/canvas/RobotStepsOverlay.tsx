import { useMemo, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

import { useFrameAnchoredPanel } from "@/hooks/use-frame-anchored-panel";
import {
  findRobotStepsFrames,
  getRobotStepsFrameData,
} from "@/lib/canvas-robot-steps-frame";
import type { RobotStep } from "@/types/canvex";

export type RunStatus = "running" | "ok" | "failed";

/** Per-step run state on a card: the status dot + the failure reason (shown inline on a
 *  failed step). Populated as a run streams `robot_step` / extension run events back. */
export interface RunStepState {
  status: RunStatus;
  error?: string;
}

/** Stable empty refs so the memos don't recompute on empty panels. */
const EMPTY_STEPS: RobotStep[] = [];
const EMPTY_STATUS: Record<number, RunStepState> = {};

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
  /** Rename the robot (persisted to customData; Save sends it as the robot name). */
  onEditTitle: (frameId: string, title: string) => void;
  onSave: (frameId: string) => void;
  /** Toggle the robot's write-gate opt-in (allow submits / pay·delete clicks). The
   *  current value is read from the frame's customData, so no companion state prop. */
  onToggleAllowWrites: (frameId: string, allow: boolean) => void;
  /** Per-frame, per-step-index run state (status + failure error) while a robot runs. */
  runStatus: Record<string, Record<number, RunStepState>>;
  /** True when the Canvex browser extension is installed → enables "run in my browser". */
  extAvailable?: boolean;
  /** Run the robot in the user's OWN browser via the extension (real IP + login state).
   *  Sends the current steps directly to the extension. */
  onRunInBrowser?: (frameId: string) => void;
  /** Pick/re-pick a step's target element in the user's REAL browser (via the extension).
   *  stepIndex < 0 appends a new click step. source: "url" opens the robot's start URL first;
   *  "current" picks the page the user was last on. Only shown when the extension is present. */
  onPickTarget?: (frameId: string, stepIndex: number, source: "url" | "current") => void;
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

/** Actions whose target is a picked rich locator → eligible for the "🎯 pick element" flow. */
const TARGETED_ACTIONS = new Set(["click", "type", "scroll", "hover", "select", "wait_for"]);

/**
 * Editable step-cards panels anchored to the scene's robot-steps frames — the DSL of
 * the robot being authored, as clickable cards. Each pick appends a step; here the user
 * can rename the robot, add / reorder / duplicate / delete steps, change a step's action,
 * edit type-text (+ mark it to submit with Enter), and Save the list as a named robot and
 * Run it (per-step status + failure reason stream back onto the cards).
 */
export function RobotStepsOverlay({
  excalidrawApiRef,
  tick,
  liveSteps,
  onEditSteps,
  onEditTitle,
  onSave,
  onToggleAllowWrites,
  runStatus,
  extAvailable,
  onRunInBrowser,
  onPickTarget,
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
          onEditTitle={onEditTitle}
          onSave={onSave}
          onToggleAllowWrites={onToggleAllowWrites}
          status={runStatus?.[frame.id] ?? EMPTY_STATUS}
          extAvailable={extAvailable}
          onRunInBrowser={onRunInBrowser}
          onPickTarget={onPickTarget}
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
  onEditTitle,
  onSave,
  onToggleAllowWrites,
  status,
  extAvailable,
  onRunInBrowser,
  onPickTarget,
}: {
  frame: ExcalidrawElement;
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  live?: RobotStepsLive;
  onEditSteps: (frameId: string, steps: RobotStep[]) => void;
  onEditTitle: (frameId: string, title: string) => void;
  onSave: (frameId: string) => void;
  onToggleAllowWrites: (frameId: string, allow: boolean) => void;
  status: Record<number, RunStepState>;
  extAvailable?: boolean;
  onRunInBrowser?: (frameId: string) => void;
  onPickTarget?: (frameId: string, stepIndex: number, source: "url" | "current") => void;
}) {
  const { t } = useTranslation("canvasUi");
  // Which step's "pick element" chooser is open (-1 = the footer "pick to add"); null = none.
  const [pickFor, setPickFor] = useState<number | null>(null);
  // Parse the frame's customData once per frame change. Used both for allow_writes
  // (persisted-only, never in live authoring state) and as the post-reload fallback for
  // title/steps — reading it through this memo avoids a JSON.parse on every render tick
  // during live authoring (when `persisted` below is null).
  const frameData = useMemo(() => getRobotStepsFrameData(frame), [frame]);
  const persisted = live ? null : frameData;
  const title = live?.title || persisted?.title || "";
  const steps = live?.steps ?? persisted?.steps ?? EMPTY_STEPS;
  const allowWrites = frameData.allowWrites;

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
  // Swap step i with its neighbour (dir -1 up / +1 down); no-op at the ends.
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const next = steps.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onEditSteps(frame.id, next);
  };
  // Insert a copy of step i right after it (keeps its target/text/submit).
  const duplicate = (i: number) =>
    onEditSteps(frame.id, [
      ...steps.slice(0, i + 1),
      { ...steps[i] },
      ...steps.slice(i + 1),
    ]);
  // Append a blank navigate step — the one action fully hand-authorable (just a URL);
  // click / type targets come from picks (a rich locator can't be typed by hand).
  const addStep = () => onEditSteps(frame.id, [...steps, { action: "navigate", url: "" }]);
  // Append an (empty) loop block; the user moves steps into it with ↑/↓ (indented display).
  const addLoop = () =>
    onEditSteps(frame.id, [...steps, { action: "loop_start", count: 2 }, { action: "loop_end" }]);

  if (!rect) return null;

  const iconBtn =
    "shrink-0 rounded px-2 py-1 text-[26px] leading-none text-white/40 enabled:hover:text-white/80 disabled:opacity-25";

  // The ↑ / ↓ / ⧉ / × cluster — shared by normal and loop-marker cards.
  const controls = (i: number) => (
    <div className="flex shrink-0 items-center">
      <button type="button" onClick={() => move(i, -1)} disabled={i === 0} title={t("browseLog.stepMoveUp")} className={iconBtn}>↑</button>
      <button type="button" onClick={() => move(i, 1)} disabled={i === steps.length - 1} title={t("browseLog.stepMoveDown")} className={iconBtn}>↓</button>
      <button type="button" onClick={() => duplicate(i)} title={t("browseLog.stepDuplicate")} className={iconBtn}>⧉</button>
      <button type="button" onClick={() => remove(i)} title={t("browseLog.stepDelete")} className={iconBtn + " text-[32px] hover:!text-red-400"}>×</button>
    </div>
  );

  // "🎯 pick element": the robot targets a page in the user's real browser, not the Canvas,
  // so binding a click/type/… target means clicking the actual element over there. The button
  // is shown only when the extension is present; it opens a chooser (below) for where to pick.
  const canPick = !!(extAvailable && onPickTarget);
  const hasStartUrl = steps.some((s) => s.action === "navigate" && !!s.url);
  const pickBtn = (i: number, action: string) =>
    canPick && TARGETED_ACTIONS.has(action) ? (
      <button
        type="button"
        onClick={() => setPickFor(pickFor === i ? null : i)}
        title={t("browseLog.pickBtn")}
        className={iconBtn + (pickFor === i ? " !text-emerald-300" : "")}
      >
        🎯
      </button>
    ) : null;
  // The where-to-pick chooser (honors the "两者都要 / ask first" choice): open the robot's
  // start URL in a fresh tab, or pick on the page the user is already on.
  const chooserRow = (i: number) =>
    pickFor === i ? (
      <div className="flex flex-wrap items-center gap-2">
        {hasStartUrl && (
          <button
            type="button"
            onClick={() => { setPickFor(null); onPickTarget?.(frame.id, i, "url"); }}
            className="rounded bg-emerald-500/15 px-3 py-2 text-[24px] text-emerald-200 hover:bg-emerald-500/25"
          >
            {t("browseLog.pickFromUrl")}
          </button>
        )}
        <button
          type="button"
          onClick={() => { setPickFor(null); onPickTarget?.(frame.id, i, "current"); }}
          className="rounded bg-emerald-500/15 px-3 py-2 text-[24px] text-emerald-200 hover:bg-emerald-500/25"
        >
          {t("browseLog.pickFromCurrent")}
        </button>
        <button
          type="button"
          onClick={() => setPickFor(null)}
          className="rounded px-3 py-2 text-[24px] text-white/40 hover:text-white/70"
        >
          {t("browseLog.pickCancel")}
        </button>
      </div>
    ) : null;

  // The action-specific field(s) shown in a normal step card's flexible middle column.
  const field = "min-w-0 flex-1 rounded bg-black/40 px-3 py-2 text-[26px] text-white placeholder:text-white/30";
  const fieldSm = "w-[180px] shrink-0 rounded bg-black/40 px-3 py-2 text-[26px] text-white placeholder:text-white/30";
  const label = (s: RobotStep) => (
    <span className="min-w-0 flex-1 truncate text-[28px] text-white/85">{targetLabel(s)}</span>
  );
  const primaryField = (step: RobotStep, i: number) => {
    switch (step.action) {
      case "navigate":
        return <input value={step.url ?? ""} placeholder={t("browseLog.stepNavigateUrl")} onChange={(e) => edit(i, { url: e.target.value })} className={field} />;
      case "wait":
        return <input type="number" min={0} value={step.ms ?? 1000} placeholder={t("browseLog.stepWaitMs")} onChange={(e) => edit(i, { ms: Number(e.target.value) })} className={fieldSm} />;
      case "key":
        return <input value={step.key ?? ""} placeholder={t("browseLog.stepKeyName")} onChange={(e) => edit(i, { key: e.target.value })} className={fieldSm} />;
      case "type":
        return (
          <>
            {label(step)}
            <input value={step.text ?? ""} placeholder={t("browseLog.stepTypeText")} onChange={(e) => edit(i, { text: e.target.value })} className="w-[220px] shrink-0 rounded bg-black/40 px-3 py-2 text-[26px] text-white placeholder:text-white/30" />
            <label title={t("browseLog.stepSubmitHint")} className={"flex shrink-0 cursor-pointer items-center gap-1 rounded px-2 py-2 text-[24px] " + (step.submit ? "text-emerald-300" : "text-white/40")}>
              <input type="checkbox" checked={!!step.submit} onChange={(e) => edit(i, { submit: e.target.checked })} className="h-4 w-4 accent-emerald-500" />
              {t("browseLog.stepSubmit")}
            </label>
          </>
        );
      case "wait_for":
        return (
          <>
            {label(step)}
            <input type="number" min={0} value={step.ms ?? 10000} placeholder={t("browseLog.stepWaitTimeout")} onChange={(e) => edit(i, { ms: Number(e.target.value) })} className={fieldSm} />
          </>
        );
      case "select":
        return (
          <>
            {label(step)}
            <input value={step.value ?? ""} placeholder={t("browseLog.stepSelectValue")} onChange={(e) => edit(i, { value: e.target.value })} className={fieldSm} />
          </>
        );
      default: // click / scroll / hover — target label only
        return label(step);
    }
  };

  // Indent each step by its loop nesting depth (visual only): depth rises after a
  // loop_start and falls at a loop_end.
  const depths: number[] = [];
  let depth = 0;
  for (const s of steps) {
    if (s.action === "loop_end") depth = Math.max(0, depth - 1);
    depths.push(depth);
    if (s.action === "loop_start") depth += 1;
  }

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
          {/* Editable robot name — persisted to customData, sent as the robot name on Save. */}
          <input
            value={title}
            placeholder={t("browseLog.robotName")}
            onChange={(e) => onEditTitle(frame.id, e.target.value)}
            className="mt-1 w-full truncate rounded bg-transparent px-1 text-[34px] leading-snug text-white/90 placeholder:text-white/25 hover:bg-black/20 focus:bg-black/30 focus:outline-none"
          />
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
        {extAvailable && onRunInBrowser && (
          <button
            type="button"
            title={t("browseLog.runInBrowserHint")}
            onClick={(e) => {
              e.stopPropagation();
              onRunInBrowser(frame.id);
            }}
            className="rounded bg-sky-500 px-5 py-2 text-[26px] font-medium text-black hover:bg-sky-400"
          >
            {t("browseLog.runInBrowser")}
          </button>
        )}
      </div>

      <div className="flex flex-col gap-3 p-6">
        {steps.length === 0 && (
          <p className="text-[28px] leading-relaxed text-white/40">
            {t("browseLog.robotEmpty")}
          </p>
        )}
        {steps.map((step, i) => {
          const st = status[i];
          const dot = (
            <span className={"h-4 w-4 shrink-0 rounded-full " + (st ? STATUS_DOT[st.status] : "bg-white/15")} />
          );
          const num = (
            <span className="min-w-[40px] text-[30px] font-semibold text-emerald-400/80">{i + 1}</span>
          );
          const indent = { paddingLeft: depths[i] * 32 } as const;

          // Loop markers render as distinct sky-tinted cards (no action dropdown): loop_start
          // carries an editable repeat count; loop_end just marks the block's end.
          if (step.action === "loop_start" || step.action === "loop_end") {
            return (
              <div
                key={i}
                style={indent}
                className="flex items-center gap-3 rounded-md border border-sky-400/25 bg-sky-400/5 px-4 py-3"
              >
                {dot}
                {num}
                {step.action === "loop_start" ? (
                  <div className="flex min-w-0 flex-1 items-center gap-2 text-[28px] text-sky-200/90">
                    🔁 {t("browseLog.stepLoop")}
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={step.count ?? 2}
                      onChange={(e) => edit(i, { count: Number(e.target.value) })}
                      className="w-[110px] rounded bg-black/40 px-3 py-2 text-[26px] text-white"
                    />
                    {t("browseLog.stepLoopTimes")}
                  </div>
                ) : (
                  <span className="min-w-0 flex-1 text-[28px] text-sky-200/60">
                    🔁 {t("browseLog.stepLoopEnd")}
                  </span>
                )}
                {controls(i)}
              </div>
            );
          }

          return (
            <div
              key={i}
              style={indent}
              className="flex flex-col gap-2 rounded-md border border-white/10 bg-white/5 px-4 py-3"
            >
              <div className="flex items-center gap-3">
                {dot}
                {num}
                <select
                  value={step.action}
                  onChange={(e) => edit(i, { action: e.target.value as RobotStep["action"] })}
                  className="shrink-0 rounded bg-black/40 px-3 py-2 text-[26px] text-white"
                >
                  <option value="click">{t("browseLog.stepClick")}</option>
                  <option value="type">{t("browseLog.stepType")}</option>
                  <option value="navigate">{t("browseLog.stepNavigate")}</option>
                  <option value="wait">{t("browseLog.stepWait")}</option>
                  <option value="wait_for">{t("browseLog.stepWaitFor")}</option>
                  <option value="key">{t("browseLog.stepKey")}</option>
                  <option value="scroll">{t("browseLog.stepScroll")}</option>
                  <option value="hover">{t("browseLog.stepHover")}</option>
                  <option value="select">{t("browseLog.stepSelect")}</option>
                </select>

                <div className="flex min-w-0 flex-1 items-center gap-2">{primaryField(step, i)}</div>

                {step.provenance && (
                  <span className="shrink-0 rounded bg-emerald-500/20 px-3 py-1 text-[22px] uppercase tracking-wide text-emerald-300/80">
                    {step.provenance}
                  </span>
                )}
                {pickBtn(i, step.action)}
                {controls(i)}
              </div>

              {/* Where-to-pick chooser (only while this step's 🎯 is toggled open). */}
              {chooserRow(i)}

              {/* Failure reason from the last run — surfaced instead of just a red dot. */}
              {st?.status === "failed" && st.error && (
                <div className="pl-[68px] text-[22px] leading-snug text-red-300/90">
                  {st.error}
                </div>
              )}
            </div>
          );
        })}

        <div className="mt-1 flex gap-3">
          {/* Add a step manually (a navigate step; switch its action after). */}
          <button
            type="button"
            onClick={addStep}
            className="flex-1 rounded-md border border-dashed border-white/20 px-4 py-3 text-[26px] text-white/50 hover:border-white/40 hover:text-white/80"
          >
            ＋ {t("browseLog.stepAdd")}
          </button>
          {/* Add an empty loop block; move steps into it with ↑ / ↓. */}
          <button
            type="button"
            onClick={addLoop}
            className="flex-1 rounded-md border border-dashed border-sky-400/30 px-4 py-3 text-[26px] text-sky-200/60 hover:border-sky-400/50 hover:text-sky-200/90"
          >
            🔁 {t("browseLog.stepAddLoop")}
          </button>
          {/* Pick a real element in the browser and append it as a new click step. */}
          {canPick && (
            <button
              type="button"
              onClick={() => setPickFor(pickFor === -1 ? null : -1)}
              className={
                "flex-1 rounded-md border border-dashed px-4 py-3 text-[26px] " +
                (pickFor === -1
                  ? "border-emerald-400/60 text-emerald-200"
                  : "border-emerald-400/30 text-emerald-200/60 hover:border-emerald-400/50 hover:text-emerald-200/90")
              }
            >
              🎯 {t("browseLog.pickAdd")}
            </button>
          )}
        </div>
        {chooserRow(-1)}
      </div>
    </div>
  );
}
