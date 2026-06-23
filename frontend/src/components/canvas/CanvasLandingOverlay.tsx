import { useEffect, useRef, useState, type RefObject } from "react";
import gsap from "gsap";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { elementScreenRect, type ScreenRect } from "@/lib/excalidraw-bounds";
import { getAiChatImageUrl } from "@/lib/excalidraw-custom-data";

interface CanvasLandingOverlayProps {
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  /** Bumped every Excalidraw onChange tick — drives detection + re-projection. */
  tick: number;
}

/** A freshly-landed generated image awaiting its entrance: its element id + the
 *  bitmap to show in the ghost. Position is re-projected live from the element. */
interface Ghost {
  id: string;
  src: string;
}

/**
 * Signature "landing" entrance for AI-generated images (GSAP).
 *
 * Generated images live INSIDE Excalidraw's <canvas>, which can't be animated
 * directly. So when a result lands, this DOM overlay plays a ghost <img> of it
 * over the element's live screen rect: an opaque white base (matching the forced
 * white canvas bg) masks the real element while the ghost materializes — scale +
 * fade + drop with an ember glow bloom — then the card is removed to reveal the
 * identical real element underneath. The real element is never touched, so the
 * worst-case failure is "no animation", never an invisible/broken image.
 *
 * Detection is a mount-seeded diff: every image id present at mount is marked
 * "seen"; any later image that carries `aiChatImageUrl` (i.e. a generated/pinned
 * result, not a user drag-drop) animates exactly once. CanvasArea remounts per
 * scene (key=sceneId), so the seed re-runs on scene switch — no stale carryover,
 * and existing images never animate on load/reload.
 */
export function CanvasLandingOverlay({ excalidrawApiRef, tick }: CanvasLandingOverlayProps) {
  const seededRef = useRef(false);
  const seenRef = useRef<Set<string>>(new Set());
  const [ghosts, setGhosts] = useState<Ghost[]>([]);

  // Detect fresh landings on every onChange tick. We scan by element identity
  // (not by a count delta) so a landing can't be masked by a same-tick add that
  // nets the total back to its prior value (e.g. pinAssetResultRows mixing a
  // placeholder-replace -1 with a fresh pin +1). The scan is cheap (Set lookups,
  // matching the sibling CanvasGeneratingOverlay), and setGhosts returns the same
  // reference when nothing changed, so steady-state pan/zoom ticks don't re-render.
  useEffect(() => {
    const api = excalidrawApiRef.current;
    if (!api) return;
    const elements = api.getSceneElements();

    // First pass seeds everything already on the canvas so only post-mount
    // arrivals animate (no entrance for existing images on load/scene switch).
    const seeding = !seededRef.current;
    seededRef.current = true;
    const files = api.getFiles();
    const ids = new Set<string>();
    const fresh: Ghost[] = [];
    for (const el of elements) {
      ids.add(el.id);
      if (el.type !== "image" || seenRef.current.has(el.id)) continue;
      seenRef.current.add(el.id);
      if (seeding) continue;
      // Only generated/pinned results (carry aiChatImageUrl) — skip user imports.
      if (!getAiChatImageUrl(el)) continue;
      const fileId = (el as { fileId?: string }).fileId;
      const src = fileId ? files[fileId]?.dataURL : undefined;
      if (src) fresh.push({ id: el.id, src });
    }
    // Add fresh ghosts; drop any whose element vanished (e.g. undo mid-entrance).
    setGhosts((g) => {
      const kept = g.filter((x) => ids.has(x.id));
      return fresh.length || kept.length !== g.length ? [...kept, ...fresh] : g;
    });
  }, [tick, excalidrawApiRef]);

  const api = excalidrawApiRef.current;
  if (!api || ghosts.length === 0) return null;

  const appState = api.getAppState();
  const viewport = {
    zoom: appState.zoom?.value ?? 1,
    scrollX: appState.scrollX ?? 0,
    scrollY: appState.scrollY ?? 0,
  };
  // Look up each ghost's live element by id (one pass) so cards track pan/zoom.
  const byId = new Map(api.getSceneElements().map((e) => [e.id, e]));
  const removeGhost = (id: string) => setGhosts((g) => g.filter((x) => x.id !== id));

  return (
    <>
      {ghosts.map((ghost) => {
        const el = byId.get(ghost.id);
        if (!el) return null; // element gone — pruned by the effect on next change
        return (
          <LandingGhost
            key={ghost.id}
            src={ghost.src}
            rect={elementScreenRect(el, viewport)}
            onDone={() => removeGhost(ghost.id)}
          />
        );
      })}
    </>
  );
}

/** A single materializing card: opaque white base masks the real element while
 *  the ghost <img> + ember glow play the GSAP entrance, then it self-removes. */
function LandingGhost({ src, rect, onDone }: { src: string; rect: ScreenRect; onDone: () => void }) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const glowRef = useRef<HTMLDivElement | null>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    const img = imgRef.current;
    const glow = glowRef.current;
    if (!img) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      doneRef.current();
      return;
    }

    const tl = gsap.timeline({ onComplete: () => doneRef.current() });
    tl.fromTo(
      img,
      { opacity: 0, scale: 0.9, y: 10 },
      { opacity: 1, scale: 1, y: 0, duration: 0.55, ease: "power3.out" },
    );
    if (glow) {
      tl.fromTo(
        glow,
        { opacity: 0.55 },
        { opacity: 0, duration: 0.75, ease: "power2.out" },
        0, // start with the image
      );
    }
    return () => {
      tl.kill();
    };
  }, []);

  return (
    <div
      data-landing-ghost
      className="pointer-events-none absolute z-[2] overflow-hidden"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    >
      {/* Opaque base masks the (identical) real element so the fade/scale reads. */}
      <div className="absolute inset-0 bg-white" />
      {/* Ember glow bloom. */}
      <div
        ref={glowRef}
        className="absolute inset-0 rounded-sm ring-2 ring-inset ring-ember/50"
        style={{ boxShadow: "0 0 28px 2px rgba(255,104,37,0.45)", opacity: 0 }}
      />
      <img
        ref={imgRef}
        src={src}
        alt=""
        className="absolute inset-0 h-full w-full object-cover will-change-transform"
        style={{ transformOrigin: "center center", opacity: 0 }}
      />
    </div>
  );
}
