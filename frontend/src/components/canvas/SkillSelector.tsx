import { Check, Sliders } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { CanvasSkill } from "@/types/canvex";

/**
 * Per-message skill opt-out selector for ChatOverlay.
 *
 * UX contract:
 * - Default: all skills enabled (empty `disabledSkills`). Button shows no
 *   badge. Alice never notices this feature exists.
 * - User clicks → popover lists skills with checkbox + description. Unchecking
 *   adds the name to `disabledSkills`, sent in the next chat POST body.
 * - State is per-message ephemeral. ChatOverlay resets `disabledSkills=[]`
 *   after send, so disabling something only affects ONE turn (matches
 *   "per-message scope" product decision — persistent toggles would need
 *   a per-scene Field + admin UI).
 */

interface SkillSelectorProps {
  /** All skills the agent has loaded — from GET /api/v1/canvas/skills/. */
  skills: CanvasSkill[];
  /** Names currently OPTED OUT for the next message. */
  disabledSkills: string[];
  onChange: (next: string[]) => void;
  /** 打开技能库面板。省略即不渲染底部那条 —— 组件在别处复用时不该硬绑一个入口。 */
  onManage?: () => void;
  /** Disable trigger button while streaming so user can't toggle mid-flight. */
  buttonDisabled?: boolean;
  /** Outer wrapper className for caller-controlled positioning. */
  className?: string;
}

export function SkillSelector({
  skills,
  // Default to [] so a transient prop-shape mismatch during Vite HMR
  // (e.g. parent passes the old `disabled` prop name from a stale build)
  // doesn't crash the component with `undefined.length`. Empty array is
  // semantically "nothing disabled" which matches the default UX anyway.
  disabledSkills = [],
  onChange,
  onManage,
  buttonDisabled = false,
  className,
}: SkillSelectorProps) {
  const { t } = useTranslation("canvasUi");

  // No skills loaded yet (empty registry or fetch failed) — render nothing
  // rather than an empty popover. Frontend stays out of the user's way.
  if (skills.length === 0) return null;

  function toggle(name: string) {
    if (disabledSkills.includes(name)) {
      onChange(disabledSkills.filter((n) => n !== name));
    } else {
      onChange([...disabledSkills, name]);
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={cn("relative size-8 rounded-lg", className)}
          disabled={buttonDisabled}
          aria-label={t("skills.configureAriaLabel")}
        >
          <Sliders className="size-4" />
          {disabledSkills.length > 0 && (
            <span
              // Brick dot top-right indicating non-default state — same affordance
              // as Gmail's "unread" / Slack's "new" dots.
              className="absolute right-1 top-1 size-1.5 rounded-full bg-primary"
              aria-hidden
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80 p-2">
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
          {t("skills.header")}
        </div>
        {/* 同 ImageModelSelector: 滚到头别把回弹传给整页。 */}
        <div className="max-h-64 overflow-y-auto overscroll-contain">
          {skills.map((skill) => {
            const isOn = !disabledSkills.includes(skill.name);
            return (
              <button
                key={skill.name}
                type="button"
                role="menuitemcheckbox"
                aria-checked={isOn}
                onClick={() => toggle(skill.name)}
                className={cn(
                  "flex w-full items-start gap-2 rounded-md p-2 text-left",
                  "hover:bg-accent hover:text-accent-foreground",
                  "focus-visible:bg-accent focus-visible:outline-none",
                )}
              >
                <div
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border",
                    isOn ? "border-primary bg-primary" : "border-input",
                  )}
                  aria-hidden
                >
                  {isOn && <Check className="size-3 text-primary-foreground" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{skill.name}</div>
                  <div className="mt-0.5 line-clamp-3 text-xs text-muted-foreground">
                    {skill.description}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
        <div className="mt-1 border-t px-2 pb-1 pt-2 text-[11px] text-muted-foreground">
          {t("skills.hint")}
        </div>
        {onManage && (
          // PopoverClose 而不是自己拿 state 受控: 点它会打开一个 modal Sheet, 而这次
          // 点击落在 popover **内部**, Radix 的"点外面才关"不会触发 —— 不显式关掉的话
          // popover 会一直挂在 Sheet 底下, 关掉 Sheet 之后还赫然开着。
          <PopoverClose asChild>
            <button
              type="button"
              onClick={onManage}
              className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              {t("skills.manage")}
            </button>
          </PopoverClose>
        )}
      </PopoverContent>
    </Popover>
  );
}
