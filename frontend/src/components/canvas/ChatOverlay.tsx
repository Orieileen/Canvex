import { useState, type FormEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Check, Image as ImageIcon, Loader2, SendHorizontal, Sparkles, Square, Wrench, X } from "lucide-react";

import { SmartImage } from "@/components/SmartImage";
import { Button } from "@/components/ui/button";
import { cn, clearIfNonEmpty } from "@/lib/utils";
import type { CanvasImageModelChoice, CanvasSkill, ChatAttachment } from "@/types/canvex";

import { SkillSelector } from "./SkillSelector";
import { ImageModelSelector } from "./ImageModelSelector";

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
  /** Abort the in-flight reply — wired to the send button while streaming. */
  onStop: () => void;
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
  /** 可选的生图模型。空数组仍然渲染选择器 —— popover 里会引导去配置页, 这比
   *  "按钮根本不出现"更容易被发现。 */
  imageModels?: CanvasImageModelChoice[];
  /** 当前选中的模型 id;空 = 后端默认通道。**粘性**, 由 page 持有并持久化。 */
  selectedImageModelId?: string;
  onSelectImageModel?: (id: string) => void;
  onOpenImageSettings?: () => void;
  /** Canvas attachments queued for this message (added via ImageEditBar's
   *  "Send to chat"). Parent owns the list because it's seeded from canvas
   *  events; this component just renders chips + supports remove. */
  attachments?: ChatAttachment[];
  onRemoveAttachment?: (url: string) => void;
}

export function ChatOverlay({
  onSubmit,
  onStop,
  isStreaming,
  status,
  toolBadge,
  skillBadges,
  placeholder,
  skills,
  imageModels,
  selectedImageModelId = "",
  onSelectImageModel,
  onOpenImageSettings,
  attachments,
  onRemoveAttachment,
}: ChatOverlayProps) {
  const { t } = useTranslation("canvasUi");
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
            <span>{isStreaming ? t("chat.thinking") : (status?.label ?? "")}</span>
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
                    aria-label={t("chat.removeAttachment")}
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <div
          className={cn(
            // rounded-xl matches the textarea so the streaming glow ring (a ::before
            // that inherits this radius) hugs the input border.
            "relative flex items-center rounded-xl",
            isStreaming && "thinking-glow",
          )}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder={placeholder ?? t("chat.placeholder")}
            rows={1}
            disabled={isStreaming}
            className={cn(
              // pl-[76px] 给左侧那组按钮留位 (SkillSelector + 生图模型选择器);
              // when absent, the icon doesn't render so the gap is just dead
              // space but visually it looks the same as the right padding.
              "min-h-[42px] w-full resize-none rounded-xl border bg-frost py-2.5 pl-[76px] pr-11 text-sm shadow-lg ring-1 ring-black/8 backdrop-blur-xl outline-none",
              "transition-all duration-200 placeholder:text-muted-foreground/60",
              "hover:border-border focus:border-ember/40",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          />
          <div className="absolute left-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
            {skills && skills.length > 0 && (
              <SkillSelector
                skills={skills}
                disabledSkills={disabledSkills}
                onChange={setDisabledSkills}
                buttonDisabled={isStreaming}
              />
            )}
            {onSelectImageModel && onOpenImageSettings && (
              <ImageModelSelector
                models={imageModels ?? []}
                value={selectedImageModelId}
                onChange={onSelectImageModel}
                onOpenSettings={onOpenImageSettings}
                buttonDisabled={isStreaming}
              />
            )}
          </div>
          <Button
            // While streaming, the button becomes a Stop control: type=button +
            // onClick aborts the reply (instead of submitting a new one).
            type={isStreaming ? "button" : "submit"}
            size="icon"
            // Always ghost — no orange fill in any state. When there's text to
            // send, the send arrow's strokes turn orange (text-primary) to signal
            // it's active; empty = muted (disabled); streaming = neutral stop glyph.
            variant="ghost"
            onClick={isStreaming ? onStop : undefined}
            className="absolute right-1.5 top-1/2 size-8 -translate-y-1/2 rounded-lg transition-all duration-150"
            disabled={isStreaming ? false : !canSend}
            aria-label={isStreaming ? t("chat.stop") : t("chat.send")}
          >
            {isStreaming ? (
              <Square className="size-4" />
            ) : (
              <SendHorizontal className={cn("size-4", canSend && "text-primary")} />
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}
