import { useEffect, useRef, useState, type RefObject, type PointerEvent as ReactPointerEvent } from "react";
import { getCommonBounds, getVisibleSceneBounds } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

/**
 * 画布缩略图 —— 240×180 面板, 元素缩放成小矩形 + 视口框覆盖在上面.
 *
 * 同步: 订阅 Excalidraw 的 onChange (元素增删/属性变) + onScrollChange (pan/zoom),
 * 不轮询. 两个回调都会触发 recompute, 用快照签名 dedup 避开同一帧重复 setState.
 *
 * 交互: 点击/拖动面板 → 视口中心跳到对应世界坐标. 走 updateScene 改 scrollX/Y
 * (不带动画, 跟手); 拖动用 rAF 节流, 60fps 的 pointermove 不会塞满 updateScene.
 */

const MINIMAP_WIDTH = 240;
const MINIMAP_HEIGHT = 180;
const MINIMAP_PADDING = 10;
const MIN_BOUNDS_DIM = 200;

interface MinimapProps {
  apiRef: RefObject<ExcalidrawImperativeAPI | null>;
  /** 父级在 Excalidraw 写入新 api 时 bump 这个数 —— Minimap 据此重订阅.
   *  替代掉对 mount 时序的猜测 (Excalidraw 在 scene 切换时会多次 re-construct,
   *  apiRef.current 反复换, 单纯轮询窗口长度难以覆盖). */
  apiVersion: number;
}

interface Snapshot {
  rects: Array<{ x: number; y: number; w: number; h: number; isImage: boolean }>;
  viewport: { x: number; y: number; w: number; h: number };
  /** Letterbox 投影参数 —— pan handler 直接复用, 避免重算. */
  scale: number;
  offsetX: number;
  offsetY: number;
  worldX: number;
  worldY: number;
}

function computeSnapshot(api: ExcalidrawImperativeAPI): Snapshot {
  const live = api.getSceneElements().filter((e: ExcalidrawElement) => !e.isDeleted);
  const appState = api.getAppState();
  const vp = getVisibleSceneBounds(appState);
  const vpX = vp[0], vpY = vp[1], vpW = vp[2] - vp[0], vpH = vp[3] - vp[1];

  // 元素 ∪ 视口, 视口框始终可见
  let minX: number, minY: number, maxX: number, maxY: number;
  if (live.length > 0) {
    const eb = getCommonBounds(live);
    minX = Math.min(eb[0], vpX);
    minY = Math.min(eb[1], vpY);
    maxX = Math.max(eb[2], vpX + vpW);
    maxY = Math.max(eb[3], vpY + vpH);
  } else {
    minX = vpX; minY = vpY; maxX = vpX + vpW; maxY = vpY + vpH;
  }

  const worldW = Math.max(maxX - minX, MIN_BOUNDS_DIM);
  const worldH = Math.max(maxY - minY, MIN_BOUNDS_DIM);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const worldX = cx - worldW / 2;
  const worldY = cy - worldH / 2;

  const innerW = MINIMAP_WIDTH - MINIMAP_PADDING * 2;
  const innerH = MINIMAP_HEIGHT - MINIMAP_PADDING * 2;
  const scale = Math.min(innerW / worldW, innerH / worldH);
  const offsetX = MINIMAP_PADDING + (innerW - worldW * scale) / 2;
  const offsetY = MINIMAP_PADDING + (innerH - worldH * scale) / 2;

  const toMini = (x: number, y: number) => ({
    x: offsetX + (x - worldX) * scale,
    y: offsetY + (y - worldY) * scale,
  });

  const rects = live.map((e: ExcalidrawElement) => {
    const tl = toMini(e.x, e.y);
    return {
      x: tl.x,
      y: tl.y,
      w: Math.max(2, e.width * scale),
      h: Math.max(2, e.height * scale),
      isImage: e.type === "image",
    };
  });

  const vpTL = toMini(vpX, vpY);
  return {
    rects,
    viewport: { x: vpTL.x, y: vpTL.y, w: vpW * scale, h: vpH * scale },
    scale, offsetX, offsetY, worldX, worldY,
  };
}

function snapshotSignature(snap: Snapshot): string {
  // worldX/scale 抓 rescale (元素增删/远端 pan); viewport 抓 pan/zoom; rects.length 抓增删
  return `${snap.worldX.toFixed(0)}:${snap.worldY.toFixed(0)}:${snap.scale.toFixed(3)}:${snap.rects.length}:${snap.viewport.x.toFixed(1)}:${snap.viewport.y.toFixed(1)}:${snap.viewport.w.toFixed(1)}:${snap.viewport.h.toFixed(1)}`;
}

export function Minimap({ apiRef, apiVersion }: MinimapProps) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const sigRef = useRef<string>("");
  const draggingRef = useRef(false);
  const moveRafRef = useRef<number | null>(null);
  const pendingMoveRef = useRef<{ mx: number; my: number } | null>(null);

  // apiVersion 变就重跑: 父级换 api 时 bump, 这里跟着重订阅.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const sync = () => {
      const next = computeSnapshot(api);
      const sig = snapshotSignature(next);
      if (sig !== sigRef.current) {
        sigRef.current = sig;
        setSnap(next);
      }
    };
    sync();
    const offChange = api.onChange(sync);
    const offScroll = api.onScrollChange(sync);
    // 兜底: Excalidraw 异步 hydrate initialData 期间不 emit onChange (isLoading
    // 时 source dist/dev/index.js:30536 直接 skip), 这段时间靠订阅看不到元素,
    // 必须自己轮询. 30 帧 ≈ 500ms, 远超典型 hydrate (~100ms 量级) 的安全余量;
    // 签名 dedup 确保只有内容变化才 setState.
    let frame = 0;
    let raf = requestAnimationFrame(function poll() {
      sync();
      if (++frame < 30) raf = requestAnimationFrame(poll);
    });
    return () => {
      offChange();
      offScroll();
      cancelAnimationFrame(raf);
    };
  }, [apiRef, apiVersion]);

  const panTo = (mx: number, my: number) => {
    const api = apiRef.current;
    const s = snap;
    if (!api || !s) return;
    const worldClickX = (mx - s.offsetX) / s.scale + s.worldX;
    const worldClickY = (my - s.offsetY) / s.scale + s.worldY;
    const { width, height, zoom } = api.getAppState();
    const z = zoom.value;
    api.updateScene({
      appState: {
        scrollX: -worldClickX + width / z / 2,
        scrollY: -worldClickY + height / z / 2,
      },
    });
  };

  const handlePointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    panTo(e.clientX - rect.left, e.clientY - rect.top);
  };
  const handlePointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!draggingRef.current) return;
    // rAF 节流 —— pointermove 60+/s, updateScene 一次相当于一次完整重渲, 不能裸打
    const rect = e.currentTarget.getBoundingClientRect();
    pendingMoveRef.current = { mx: e.clientX - rect.left, my: e.clientY - rect.top };
    if (moveRafRef.current !== null) return;
    moveRafRef.current = requestAnimationFrame(() => {
      moveRafRef.current = null;
      const p = pendingMoveRef.current;
      if (p) panTo(p.mx, p.my);
    });
  };
  const handlePointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    draggingRef.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (moveRafRef.current !== null) {
      cancelAnimationFrame(moveRafRef.current);
      moveRafRef.current = null;
    }
  };

  return (
    <div
      className="rounded-xl border bg-background/95 shadow-lg backdrop-blur overflow-hidden"
      style={{ width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT }}
    >
      <svg
        width={MINIMAP_WIDTH}
        height={MINIMAP_HEIGHT}
        className="cursor-crosshair touch-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {snap?.rects.map((r, i) => (
          <rect
            key={i}
            x={r.x}
            y={r.y}
            width={r.w}
            height={r.h}
            className={
              r.isImage
                ? "fill-muted-foreground/40"
                : "fill-none stroke-muted-foreground/50"
            }
            strokeWidth={r.isImage ? 0 : 1}
          />
        ))}
        {snap && (
          <rect
            x={snap.viewport.x}
            y={snap.viewport.y}
            width={snap.viewport.w}
            height={snap.viewport.h}
            className="fill-primary/5 stroke-primary/70 pointer-events-none"
            strokeWidth={1.5}
          />
        )}
      </svg>
    </div>
  );
}
