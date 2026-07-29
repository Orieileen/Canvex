import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { findChatFrame } from "@/lib/canvas-chat-frame";
import { useFrameAnchoredPanel } from "@/hooks/use-frame-anchored-panel";
import { cn } from "@/lib/utils";
import type { CanvasChatMessage } from "@/types/canvex";

interface ChatFrameOverlayProps {
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  /** Bumped every Excalidraw onChange tick — re-projects the panel on
   *  pan / zoom / frame move (mirrors the sibling overlays). */
  tick: number;
  messages: CanvasChatMessage[];
  /** A reply is streaming — show a typing indicator at the bottom. */
  streaming: boolean;
  /** Live assistant text accumulated from token deltas; rendered as a typing
   *  bubble until the persisted message replaces it. */
  streamingText?: string;
  /** True once the persisted reply arrived — the typewriter finishes dripping
   *  the remaining text, then calls onStreamSettled. */
  streamFinalizing?: boolean;
  /** Fired when the typewriter has revealed the full text and is finalizing. */
  onStreamSettled?: () => void;
}

/**
 * The scrollable chat transcript, anchored to the scene's native Excalidraw
 * chat frame. Native frames can't scroll their contents, so the messages live
 * in this HTML panel (not as canvas elements); it tracks the frame's live
 * screen rect every tick, so it moves/zooms with the frame and stays pinned
 * inside it. `pointer-events-auto` so the user can scroll/select; the frame is
 * still draggable via its name label (drawn by Excalidraw above the frame).
 * Generated images/videos still land on the canvas as native elements.
 */
export function ChatFrameOverlay({
  excalidrawApiRef,
  tick,
  messages,
  streaming,
  streamingText = "",
  streamFinalizing = false,
  onStreamSettled,
}: ChatFrameOverlayProps) {
  const { t } = useTranslation("canvasUi");
  void tick; // re-render trigger; live state read fresh below
  const api = excalidrawApiRef.current;
  const frame = api ? findChatFrame(api.getSceneElements()) : null;

  // Projection + wheel routing + stick-to-bottom live in the shared hook (see
  // useFrameAnchoredPanel — same shell as BrowseLogOverlay). The panel renders
  // content at the frame's world width/height then transform: scale(zoom), so
  // text scales like an image instead of reflowing. Stick key: a new message id
  // or a streaming-state flip (StreamingBubble pins itself while typing, so the
  // live token text isn't part of the key).
  const lastId = messages.length ? messages[messages.length - 1].id : "";
  const { scrollRef, rect, zoom, width, height } = useFrameAnchoredPanel(
    frame,
    excalidrawApiRef,
    `${lastId}:${streaming ? 1 : 0}`,
  );
  if (!rect) return null;

  return (
    <div
      ref={scrollRef}
      className="absolute z-30 overflow-y-auto overflow-x-hidden overscroll-contain rounded-sm bg-dune/95 shadow-sm backdrop-blur-sm"
      style={{
        left: rect.left,
        top: rect.top,
        width,
        height,
        transform: `scale(${zoom})`,
        transformOrigin: "top left",
      }}
      // Clicking/selecting inside the panel shouldn't disturb the canvas selection.
      // (Wheel zoom/pan is handled by the native listener above, which forwards to the canvas.)
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex flex-col gap-4 p-6">
        {messages.length === 0 && !streaming ? (
          <p className="px-1 py-8 text-center text-2xl text-muted-foreground/70">
            {t("chatFrame.emptyState")}
          </p>
        ) : (
          messages.map((m) => (
            <MessageBubble key={m.id} role={m.role} content={m.content} />
          ))
        )}
        {/* Live assistant reply, typed out at a constant rate (smooths the
            batched flushes the dev server delivers). */}
        {streamingText && (
          <StreamingBubble
            target={streamingText}
            finalizing={streamFinalizing}
            onSettled={onStreamSettled}
            scrollRef={scrollRef}
          />
        )}
        {/* Thinking spinner (icon only) until the first token lands. */}
        {streaming && !streamingText && (
          <div className="flex items-center px-1 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
          </div>
        )}
      </div>
    </div>
  );
}

function MessageBubble({
  role,
  content,
  typing = false,
}: {
  role: CanvasChatMessage["role"];
  content: string;
  /** Append a blinking caret — used by the live streaming bubble. */
  typing?: boolean;
}) {
  const isUser = role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-6 py-4 text-[64px] leading-relaxed",
          isUser ? "bg-ember text-white" : "bg-card text-foreground",
        )}
      >
        {content}
        {typing && <span className="ml-1 animate-pulse text-muted-foreground">▍</span>}
      </div>
    </div>
  );
}

/**
 * Live assistant reply typed out at a constant rate ("匀速吐字"). `target` may
 * jump in batches (the dev server / proxies buffer the SSE stream), but the
 * revealed text advances at a steady chars/sec so it reads as smooth typing.
 * Owning the per-frame state here (not in the parent) keeps the rest of the
 * canvas off the 60fps render path. Once the full target is revealed AND the
 * reply is finalizing, calls onSettled so the parent swaps in the identical
 * persisted bubble with no visible jump.
 */
function StreamingBubble({
  target,
  finalizing,
  onSettled,
  scrollRef,
}: {
  target: string;
  finalizing: boolean;
  onSettled?: () => void;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const [displayed, setDisplayed] = useState("");
  const lenRef = useRef(0);
  const settledRef = useRef(false);

  // Constant-rate reveal toward `target`. The loop runs ONLY while there's
  // backlog and re-arms whenever `target` grows (effect dep), so it never spins
  // idle between batches or after catching up. CPS = typing speed; MAX_LAG caps
  // how far behind a huge batch we fall so very long replies still finish
  // promptly without sacrificing the steady feel on normal ones.
  useEffect(() => {
    // Caught up — or `target` shrank/was replaced (e.g. persisted content shorter
    // than the accumulated deltas): sync the visible text to it exactly so we
    // never leave stale extra characters on screen for a frame.
    if (lenRef.current >= target.length) {
      lenRef.current = target.length;
      setDisplayed(target);
      return;
    }
    const CPS = 70;
    const MAX_LAG = 160;
    let raf = 0;
    let last = 0;
    const step = (ts: number) => {
      if (!last) last = ts;
      const dt = ts - last;
      last = ts;
      const backlog = target.length - lenRef.current;
      let reveal = Math.max(1, Math.round((CPS * dt) / 1000));
      if (backlog > MAX_LAG) reveal = Math.max(reveal, backlog - MAX_LAG);
      const next = Math.min(target.length, lenRef.current + reveal);
      lenRef.current = next;
      setDisplayed(target.slice(0, next));
      if (next < target.length) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  // Keep pinned to the bottom as text types in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [displayed, scrollRef]);

  // Caught up + finalizing → hand off to the persisted bubble (once).
  useEffect(() => {
    if (finalizing && target && displayed.length >= target.length && !settledRef.current) {
      settledRef.current = true;
      onSettled?.();
    }
  }, [finalizing, displayed, target, onSettled]);

  return <MessageBubble role="assistant" content={displayed} typing />;
}
