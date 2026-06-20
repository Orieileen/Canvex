import { useEffect, useRef, type RefObject } from "react";
import * as THREE from "three";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawImageElement } from "@excalidraw/excalidraw/element/types";

import {
  ADJUST_FRAGMENT_SHADER,
  ADJUST_VERTEX_SHADER,
  COLOR_BANDS,
  COLOR_BAND_META,
  isColorMixActive,
  type ColorMix,
  type ImageAdjustments,
} from "@/lib/image-adjustments";
import {
  getAdjustBinding,
  isAdjustNeutral,
  type AdjustBinding,
} from "@/lib/canvas-adjust";
import { elementScreenRect } from "@/lib/excalidraw-bounds";

/**
 * 调色 live-preview overlay — a Three.js WebGL canvas laid exactly over the
 * selected base image in Excalidraw screen-space, running the adjustment shader
 * as one full-image quad pass. Mirrors `Mockup3dOverlay`'s positioning / capture
 * / registry machinery but is far simpler (orthographic, single quad, no
 * depth / decal / gizmo). Always-on: renders a layer over every image carrying a
 * non-neutral `customData.adjust` binding (not just the selected one), so the
 * adjustment persists in place whether or not the Adjust panel is showing.
 */

interface AdjustGLState {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  material: THREE.ShaderMaterial;
  texture: THREE.Texture | null;
  mounted: boolean;
}

/** baseId → GLState. The download path looks an adjusted base up here (hasAdjust /
 *  captureAdjustAtSize) to re-render at the source's native resolution. */
const adjustStateRegistry = new Map<string, AdjustGLState>();

// HMR guard: clear stale GLState if Vite swaps this module without remounting
// the renderer (mirrors Mockup3dOverlay's registry guard).
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    adjustStateRegistry.clear();
  });
}

// 1×1 transparent placeholder for `uImage` before the real source texture loads:
// a render in that window samples (0,0,0,0) → the overlay quad is transparent and
// the base shows through, instead of a black flash from sampling a null sampler.
// Shared + never disposed (negligible cost).
const TRANSPARENT_TEXTURE = (() => {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
})();

function buildUniforms(): Record<string, { value: number | number[] | THREE.Texture | null }> {
  return {
    uImage: { value: TRANSPARENT_TEXTURE },
    uLight: { value: 0 },
    uExposure: { value: 0 },
    uContrast: { value: 0 },
    uHighlights: { value: 0 },
    uShadows: { value: 0 },
    uWhites: { value: 0 },
    uBlacks: { value: 0 },
    uVibrance: { value: 0 },
    uSaturation: { value: 0 },
    uTemperature: { value: 0 },
    uTint: { value: 0 },
    uSharpen: { value: 0 },
    uClarity: { value: 0 },
    uGrain: { value: 0 },
    uVignette: { value: 0 },
    uSoft: { value: 0 },
    uGlow: { value: 0 },
    uBandHue: { value: COLOR_BANDS.map((b) => COLOR_BAND_META[b].center) },
    uMixHue: { value: COLOR_BANDS.map(() => 0) },
    uMixSat: { value: COLOR_BANDS.map(() => 0) },
    uMixLum: { value: COLOR_BANDS.map(() => 0) },
    uColorMixActive: { value: 0 },
  };
}

function initAdjustScene(container: HTMLDivElement): AdjustGLState {
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    premultipliedAlpha: true,
    // 必须 true: 不开的话 WebGL swap 后清空 backing buffer, 离屏 capture
    // (Apply 时 drawImage(renderer.domElement)) 会拿到空帧. 见 Mockup3dOverlay.
    preserveDrawingBuffer: true,
  });
  renderer.setClearColor(0x000000, 0);
  container.appendChild(renderer.domElement);
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  renderer.domElement.style.display = "block";

  const scene = new THREE.Scene();
  // Orthographic camera + a unit plane filling the [-1,1] frustum: a flat 2D
  // image pass, no perspective. The plane always fills the viewport, so the
  // image takes the base element's on-screen box (matching how Excalidraw shows it).
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 1;

  const material = new THREE.ShaderMaterial({
    uniforms: buildUniforms(),
    vertexShader: ADJUST_VERTEX_SHADER,
    fragmentShader: ADJUST_FRAGMENT_SHADER,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

  return { renderer, scene, camera, material, texture: null, mounted: true };
}

function loadImageTexture(dataURL: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(
      dataURL,
      (texture) => {
        // NoColorSpace: skip the sRGB->linear hardware decode so sampled bytes
        // equal the source sRGB bytes and the at-zero shader is exact passthrough.
        texture.colorSpace = THREE.NoColorSpace;
        // Base-level linear sampling (no mipmaps): the blur/sharpen taps want the
        // full-res image, and it avoids NPOT mipmap-generation cost.
        texture.minFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        resolve(texture);
      },
      undefined,
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
}

/** Re-render an adjusted base at native pixel size into an offscreen 2D canvas
 *  and return it (used by the download composite). setSize 第三参 false 只改 backing
 *  buffer; finally 还原 + 重渲, 屏幕上看不见中间状态 (照抄 captureMockupAtSize). */
export function captureAdjustAtSize(
  baseId: string,
  width: number,
  height: number,
): HTMLCanvasElement | null {
  const state = adjustStateRegistry.get(baseId);
  // No texture yet (download raced the async load) → bail so we never bake a
  // black frame; the caller falls back to the original image.
  if (!state || !state.texture) return null;

  const oldSize = new THREE.Vector2();
  state.renderer.getSize(oldSize);
  const oldDpr = state.renderer.getPixelRatio();

  try {
    state.renderer.setPixelRatio(1);
    state.renderer.setSize(width, height, false);
    state.renderer.render(state.scene, state.camera);

    const out = document.createElement("canvas");
    out.width = width;
    out.height = height;
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(state.renderer.domElement, 0, 0);
    return out;
  } finally {
    state.renderer.setPixelRatio(oldDpr);
    state.renderer.setSize(oldSize.x, oldSize.y, false);
    state.renderer.render(state.scene, state.camera);
  }
}

/** Whether an image currently has a live adjust overlay (non-neutral binding) —
 *  cheap gate for the download path to decide whether to composite. */
export function hasAdjust(baseId: string): boolean {
  return adjustStateRegistry.has(baseId);
}

interface AdjustRendererProps {
  baseId: string;
  dataURL: string;
  width: number;
  height: number;
  adjustments: ImageAdjustments;
  colorMix: ColorMix;
}

function AdjustRenderer({ baseId, dataURL, width, height, adjustments, colorMix }: AdjustRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<AdjustGLState | null>(null);

  // Mount Three once per renderer lifetime (per open base).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const state = initAdjustScene(container);
    stateRef.current = state;
    adjustStateRegistry.set(baseId, state);
    return () => {
      adjustStateRegistry.delete(baseId);
      state.mounted = false;
      state.texture?.dispose();
      state.material.dispose();
      state.scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) obj.geometry.dispose();
      });
      state.renderer.dispose();
      state.renderer.domElement.remove();
      stateRef.current = null;
    };
  }, [baseId]);

  // (Re)load the source texture when the image data changes.
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    let cancelled = false;
    void loadImageTexture(dataURL)
      .then((texture) => {
        if (cancelled || !state.mounted) {
          texture.dispose();
          return;
        }
        state.texture?.dispose();
        state.texture = texture;
        state.material.uniforms.uImage.value = texture;
        state.renderer.render(state.scene, state.camera);
      })
      .catch(() => {
        /* texture load failed — overlay stays transparent, base shows through */
      });
    return () => { cancelled = true; };
  }, [dataURL]);

  // Resize the backing buffer to the on-screen rect (DPR-aware).
  useEffect(() => {
    const state = stateRef.current;
    if (!state || width === 0 || height === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    state.renderer.setPixelRatio(dpr);
    state.renderer.setSize(width, height, true);
    state.renderer.render(state.scene, state.camera);
  }, [width, height]);

  // Push slider values → uniforms and re-render. -100..100 → shader units;
  // exposure in EV stops (±2), the rest ±1. All-zero = passthrough identity.
  const { light, exposure, contrast, highlights, shadows, whites, blacks } = adjustments;
  const { vibrance, saturation, temperature, tint } = adjustments;
  const { sharpen, clarity, grain, vignette, soft, glow } = adjustments;
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    const u = state.material.uniforms;
    u.uLight.value = light / 100;
    u.uExposure.value = exposure / 50;
    u.uContrast.value = contrast / 100;
    u.uHighlights.value = highlights / 100;
    u.uShadows.value = shadows / 100;
    u.uWhites.value = whites / 100;
    u.uBlacks.value = blacks / 100;
    u.uVibrance.value = vibrance / 100;
    u.uSaturation.value = saturation / 100;
    u.uTemperature.value = temperature / 100;
    u.uTint.value = tint / 100;
    u.uSharpen.value = sharpen / 100;
    u.uClarity.value = clarity / 100;
    u.uGrain.value = grain / 100;
    u.uVignette.value = vignette / 100;
    u.uSoft.value = soft / 100;
    u.uGlow.value = glow / 100;
    state.renderer.render(state.scene, state.camera);
  }, [light, exposure, contrast, highlights, shadows, whites, blacks, vibrance, saturation, temperature, tint, sharpen, clarity, grain, vignette, soft, glow]);

  // Per-color HSL mixer uniforms (8-band arrays). Dep on a content key, not the
  // object: getAdjustBinding builds a fresh colorMix every tick, so a plain
  // [colorMix] dep would re-upload unchanged arrays on every pan frame.
  const colorMixKey = COLOR_BANDS.map((b) => `${colorMix[b].h},${colorMix[b].s},${colorMix[b].l}`).join("|");
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    const u = state.material.uniforms;
    u.uMixHue.value = COLOR_BANDS.map((b) => colorMix[b].h / 100);
    u.uMixSat.value = COLOR_BANDS.map((b) => colorMix[b].s / 100);
    u.uMixLum.value = COLOR_BANDS.map((b) => colorMix[b].l / 100);
    u.uColorMixActive.value = isColorMixActive(colorMix) ? 1 : 0;
    state.renderer.render(state.scene, state.camera);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorMixKey]);

  return <div ref={containerRef} className="size-full" />;
}

interface ImageAdjustOverlayProps {
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  /** Bump to force a re-render on pan/zoom/move + binding change so overlays track. */
  tick: number;
}

/** Always-on: renders an adjusted layer over every image carrying a non-neutral
 *  `customData.adjust` binding — so the adjustment is in-place and persists
 *  whether or not the Adjust panel is open (mirrors Mockup3dOverlay). */
export function ImageAdjustOverlay({ excalidrawApiRef, tick }: ImageAdjustOverlayProps) {
  void tick; // re-render trigger; viewport + bindings read fresh below
  const api = excalidrawApiRef.current;
  if (!api) return null;

  const appState = api.getAppState();
  const zoom = appState.zoom?.value ?? 1;
  const scrollX = appState.scrollX ?? 0;
  const scrollY = appState.scrollY ?? 0;
  const files = api.getFiles();

  const renders: {
    baseId: string;
    dataURL: string;
    binding: AdjustBinding;
    rect: { left: number; top: number; width: number; height: number };
  }[] = [];
  for (const el of api.getSceneElements()) {
    if (el.isDeleted || el.type !== "image") continue;
    const binding = getAdjustBinding(el);
    if (!binding || isAdjustNeutral(binding)) continue;
    const img = el as ExcalidrawImageElement;
    if (!img.fileId) continue;
    const dataURL = files[img.fileId]?.dataURL;
    if (!dataURL) continue;
    renders.push({
      baseId: img.id,
      dataURL,
      binding,
      rect: elementScreenRect(img, { zoom, scrollX, scrollY }),
    });
  }
  if (renders.length === 0) return null;

  // zIndex 1 = Excalidraw's static-canvas (image) depth: the adjusted quad sits
  // right on the base image it overlays, but below the interactive canvas
  // (selection handles, zIndex 2) and the UI chrome (toolbars/panels, zIndex 4),
  // so a live adjustment never paints over Excalidraw's controls.
  return (
    <div className="pointer-events-none absolute inset-0 z-[1] overflow-hidden">
      {renders.map((r) => (
        <div key={r.baseId} className="pointer-events-none absolute" style={r.rect}>
          <AdjustRenderer
            baseId={r.baseId}
            dataURL={r.dataURL}
            width={r.rect.width}
            height={r.rect.height}
            adjustments={r.binding.values}
            colorMix={r.binding.colorMix}
          />
        </div>
      ))}
    </div>
  );
}
