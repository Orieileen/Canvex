import { useState, type FormEvent, type KeyboardEvent } from "react";
import { Check, Image as ImageIcon, Loader2, SendHorizontal, Sparkles, Wrench, X } from "lucide-react";

import { SmartImage } from "@/components/SmartImage";
import { Button } from "@/components/ui/button";
import { cn, clearIfNonEmpty } from "@/lib/utils";
import type { CanvasSkill, ChatAttachment } from "@/types/canvex";

import { SkillSelector } from "./SkillSelector";

/**
 * Floating chat overlay — canvex-style bottom-center input.
 *
 * 布局:
 *   `pointer-events-none` 的全宽底部容器 + `pointer-events-auto` 的 max-w-xl
 *   表单 —— 外层点击穿到画布, 只有表单本体拦事件
 *
 * Textarea 固定单行高, resize-none;Enter 发送, Shift+Enter 换行。
 * 流式中 disabled —— 简化版不支持中途打断 (canvex 有 stopMessage, meired 先不加,
 * AbortController 整条链路都要 plumb)。
 *
 * Skill 选择: 当 `skills` 非空时, textarea 左侧渲染 SkillSelector — 用户
 * 能 per-message 关掉某些 skill (发送后状态自动复位, "per-message ephemeral")。
 */

export type ChatStatusVariant = "loading" | "success" | "error";

export interface ChatOverlayStatus {
  label: string;
  variant: ChatStatusVariant;
}

interface ChatOverlayProps {
  onSubmit: (
    content: string,
    disabledSkills: string[],
    attachments: ChatAttachment[],
  ) => void;
  isStreaming: boolean;
  status: ChatOverlayStatus | null;
  toolBadge: string | null;
  /** Skills the agent loaded this turn (via SkillsMiddleware progressive
   *  disclosure — sniffed from `read_file` of `/skills/<slug>/SKILL.md`).
   *  Cleared together with `toolBadge` when the agent's reply settles. */
  skillBadges?: string[];
  placeholder?: string;
  /** All skills the agent has loaded. Empty / undefined = hide selector. */
  skills?: CanvasSkill[];
  /** Canvas attachments queued for this message (added via ImageEditBar's
   *  "Send to chat"). Parent owns the list because it's seeded from canvas
   *  events; this component just renders chips + supports remove. */
  attachments?: ChatAttachment[];
  onRemoveAttachment?: (url: string) => void;
}

export function ChatOverlay({
  onSubmit,
  isStreaming,
  status,
  toolBadge,
  skillBadges,
  placeholder,
  skills,
  attachments,
  onRemoveAttachment,
}: ChatOverlayProps) {
  const [input, setInput] = useState("");
  // disabledSkills 状态留在 ChatOverlay 内 (不上提到 page) — 它本质就是
  // 输入框的一部分, 跟 input text 一起每条 message 提交后复位。
  // attachments 由 page 管 (来源是 canvas event → page state), 这里只渲染。
  const [disabledSkills, setDisabledSkills] = useState<string[]>([]);
  const trimmed = input.trim();
  const canSend = !isStreaming && trimmed.length > 0;

  function submit() {
    if (!canSend) return;
    onSubmit(trimmed, disabledSkills, attachments ?? []);
    setInput("");
    // Per-message ephemeral: drop disabledSkills after every send.
    setDisabledSkills(clearIfNonEmpty);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    submit();
  }

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  const showStatusBar = isStreaming || !!status;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-4">
      <form
        onSubmit={handleSubmit}
        className="pointer-events-auto w-full max-w-xl"
      >
        {showStatusBar && (
          <div
            className={cn(
              "mb-2 flex items-center gap-1.5 text-xs transition-all duration-300",
              isStreaming && "text-muted-foreground",
              status?.variant === "loading" && "text-muted-foreground",
              status?.variant === "success" && "text-primary",
              status?.variant === "error" && "text-destructive",
            )}
          >
            {isStreaming || status?.variant === "loading" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : status?.variant === "success" ? (
              <Check className="size-3" />
            ) : (
              <X className="size-3" />
            )}
            <span>{isStreaming ? "Thinking…" : (status?.label ?? "")}</span>
            {skillBadges?.map((slug) => {
              const meta = skills?.find((s) => s.name === slug);
              return (
                <span
                  key={slug}
                  title={meta?.description}
                  className="ml-2 inline-flex items-center gap-1 rounded-md bg-ember/10 px-1.5 py-0.5 text-[11px] text-ember"
                >
                  <Sparkles className="size-3" />
                  {slug}
                </span>
              );
            })}
            {toolBadge && (
              <span className="ml-2 inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-foreground/80">
                <Wrench className="size-3" />
                {toolBadge}
              </span>
            )}
          </div>
        )}
        {attachments && attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((a) => (
              <div
                key={a.url}
                className="flex items-center gap-1.5 rounded-lg border bg-frost py-1 pl-1 pr-1.5 shadow-sm backdrop-blur"
              >
                <SmartImage
                  src={a.url}
                  alt=""
                  containerClassName="relative size-8 overflow-hidden rounded"
                  className="size-8 object-cover"
                />
                <span className="text-[11px] text-muted-foreground">
                  <ImageIcon className="mr-0.5 inline size-3" />
                  {a.width}×{a.height}
                </span>
                {onRemoveAttachment && (
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(a.url)}
                    disabled={isStreaming}
                    className={cn(
                      "ml-0.5 flex size-4 items-center justify-center rounded text-muted-foreground",
                      "hover:bg-muted hover:text-foreground disabled:opacity-40",
                    )}
                    aria-label="Remove attachment"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="relative flex items-center">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder={placeholder ?? "Describe what you want on the canvas…"}
            rows={1}
            disabled={isStreaming}
            className={cn(
              // pl-11 reserves room for SkillSelector when skills are present;
              // when absent, the icon doesn't render so the gap is just dead
              // space but visually it looks the same as the right padding.
              "min-h-[42px] w-full resize-none rounded-xl border bg-frost py-2.5 pl-11 pr-11 text-sm shadow-lg ring-1 ring-black/8 backdrop-blur-xl outline-none",
              "transition-all duration-200 placeholder:text-muted-foreground/60",
              "hover:border-border focus:border-ember/40",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          />
          {skills && skills.length > 0 && (
            <SkillSelector
              skills={skills}
              disabledSkills={disabledSkills}
              onChange={setDisabledSkills}
              buttonDisabled={isStreaming}
              className="absolute left-1.5 top-1/2 -translate-y-1/2"
            />
          )}
          <Button
            type="submit"
            size="icon"
            variant={canSend ? "default" : "ghost"}
            className="absolute right-1.5 top-1/2 size-8 -translate-y-1/2 rounded-lg transition-all duration-150"
            disabled={!canSend}
            aria-label="Send"
          >
            {isStreaming ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <SendHorizontal className="size-4" />
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}
