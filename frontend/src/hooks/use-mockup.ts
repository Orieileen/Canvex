import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { convertToExcalidrawElements, newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, BinaryFileData } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  FileId,
} from "@excalidraw/excalidraw/element/types";

import {
  DEFAULT_MOCKUP_MASK_THRESHOLD,
  DEFAULT_MOCKUP_ROTATION,
  DEFAULT_MOCKUP_SCALE,
  DEFAULT_MOCKUP_STRENGTH,
  MOCKUP_SOURCE_FOR_KEY,
  getMockupBinding,
  withMockupBinding,
  withoutMockupBinding,
  withoutMockupSourceFor,
  type Mockup3dBinding,
} from "@/lib/canvas-mockup";
import { imageDimensionsFromDataURL } from "@/hooks/use-canvas-pinning";
import { soleSelectionAppState } from "@/lib/excalidraw-selection";
import { computeDepthMap } from "@/lib/depth-estimation";
import { computeForegroundMask } from "@/lib/segmentation";

/**
 * 3D Mockup state machine for the Canvas workspace.
 *
 * 状态比 2D 复杂: 进入 receiving 时要先跑 depth (异步, 长达 10s),
 * depth 算完才能 bind. 所以 receivingBaseId 解耦成 receiving + depth status.
 */

export type DepthStatus = "idle" | "loading" | "ready" | "error";

interface UseMockupParams {
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
}

export interface UseMockup {
  receivingBaseId: string | null;
  /** Per-base depth processing status — loading shows spinner in panel,
   *  ready unlocks the drop interaction. */
  depthStatusFor: (baseId: string) => DepthStatus;
  enterReceiving: (baseId: string) => Promise<void>;
  exitReceiving: () => void;
  removeMockup: (baseId: string) => void;
  /** Inverse of bindDesignToBase — revive the soft-deleted design element
   *  at the given world position and clear the base's mockup binding. The
   *  design becomes a normal canvas image again. No-op if the binding has
   *  no matching soft-deleted source (older bindings, or design already
   *  hard-deleted by undo). */
  detachDesign: (params: { baseId: string; worldX: number; worldY: number }) => Promise<void>;
  /** Called from drop detection in CanvasWorkspacePage when user drops
   *  another image onto a base in receiving mode (with depth ready).
   *  Anchor is the UV [0..1]² of the drop point on the base. */
  bindDesignToBase: (params: {
    baseId: string;
    designId: string;
    designFileId: FileId;
    anchor: readonly [number, number];
  }) => void;
  updateAnchor: (baseId: string, anchor: readonly [number, number]) => void;
  updateScale: (baseId: string, scale: number) => void;
  updateScaleY: (baseId: string, scaleY: number) => void;
  updateRotation: (baseId: string, rotation: number) => void;
  updateStrength: (baseId: string, strength: number) => void;
  updateMaskThreshold: (baseId: string, threshold: number) => void;
  updateOpacity: (baseId: string, opacity: number) => void;
}

/** Clamp a 0..1 number, optionally with a higher floor. */
function clampScale(v: number, min = 0.05): number {
  return Math.max(min, Math.min(1, v));
}
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Build a stable depth file id from the base's image file id. Cache hit
 *  across page reloads as long as the base's fileId stays the same. */
function depthFileIdFor(baseFileId: FileId): FileId {
  return `depth-${baseFileId}` as FileId;
}

/** Same convention for the segmentation mask. */
function maskFileIdFor(baseFileId: FileId): FileId {
  return `mask-${baseFileId}` as FileId;
}

/** Build a BinaryFileData record for Excalidraw addFiles. Local-only depth
 *  blob (no remote URL). */
function makeFileRecord(id: FileId, dataURL: string, mimeType: string): BinaryFileData {
  const now = Date.now();
  return {
    id,
    dataURL: dataURL as BinaryFileData["dataURL"],
    mimeType: mimeType as BinaryFileData["mimeType"],
    created: now,
    lastRetrieved: now,
  };
}

export function useMockup({ excalidrawApiRef }: UseMockupParams): UseMockup {
  const [receivingBaseId, setReceivingBaseId] = useState<string | null>(null);
  // Per-base depth status. Independent of receivingBaseId because:
  // - Once depth is computed for a base, it stays ready (cached as a file).
  // - Multiple bases can be in different states.
  const [depthStatuses, setDepthStatuses] = useState<Map<string, DepthStatus>>(new Map());

  const setDepthStatus = useCallback((baseId: string, status: DepthStatus) => {
    setDepthStatuses((prev) => {
      if (prev.get(baseId) === status) return prev;
      const next = new Map(prev);
      next.set(baseId, status);
      return next;
    });
  }, []);

  const depthStatusFor = useCallback(
    (baseId: string): DepthStatus => depthStatuses.get(baseId) ?? "idle",
    [depthStatuses],
  );

  const enterReceiving = useCallback(
    async (baseId: string) => {
      setReceivingBaseId(baseId);
      const api = excalidrawApiRef.current;
      if (!api) return;
      const elements = api.getSceneElements();
      const base = elements.find((el) => el.id === baseId);
      if (!base || base.type !== "image" || !("fileId" in base) || !base.fileId) return;
      // If already bound, depth file already exists in scene — nothing to do.
      const existing = getMockupBinding(base);
      if (existing) {
        setDepthStatus(baseId, "ready");
        return;
      }
      const baseFileId = base.fileId as FileId;
      const depthId = depthFileIdFor(baseFileId);
      const maskId = maskFileIdFor(baseFileId);
      const files = api.getFiles();
      // Cache hit: both depth + mask already cached.
      if (files[depthId] && files[maskId]) {
        setDepthStatus(baseId, "ready");
        return;
      }
      // Cache miss on either: kick off both inferences in parallel. The
      // status flips to ready only when BOTH succeed; UI then unlocks drop.
      setDepthStatus(baseId, "loading");
      const baseDataURL = files[baseFileId]?.dataURL;
      if (!baseDataURL) {
        setDepthStatus(baseId, "error");
        return;
      }
      try {
        const [depthDataURL, maskDataURL] = await Promise.all([
          files[depthId]?.dataURL ?? computeDepthMap(baseDataURL),
          files[maskId]?.dataURL ?? computeForegroundMask(baseDataURL),
        ]);
        const apiNow = excalidrawApiRef.current;
        if (!apiNow) return; // unmounted mid-inference
        const toAdd: BinaryFileData[] = [];
        if (!apiNow.getFiles()[depthId]) toAdd.push(makeFileRecord(depthId, depthDataURL, "image/png"));
        if (!apiNow.getFiles()[maskId]) toAdd.push(makeFileRecord(maskId, maskDataURL, "image/png"));
        if (toAdd.length) apiNow.addFiles(toAdd);
        setDepthStatus(baseId, "ready");
      } catch (err) {
        console.warn("[useMockup] depth/mask inference failed", err);
        setDepthStatus(baseId, "error");
      }
    },
    [excalidrawApiRef, setDepthStatus],
  );

  const exitReceiving = useCallback(() => {
    setReceivingBaseId(null);
  }, []);

  const removeMockup = useCallback(
    (baseId: string) => {
      const api = excalidrawApiRef.current;
      if (!api) return;
      const elements = api.getSceneElements();
      const target = elements.find((el) => el.id === baseId);
      if (!target || !getMockupBinding(target)) return;
      const updated = newElementWith(target, {
        customData: withoutMockupBinding(target.customData),
      });
      const next: ExcalidrawElement[] = elements.map((el) =>
        el.id === baseId ? updated : el,
      );
      api.updateScene({ elements: next });
    },
    [excalidrawApiRef],
  );

  const detachDesign = useCallback(
    async ({ baseId, worldX, worldY }: { baseId: string; worldX: number; worldY: number }) => {
      const api = excalidrawApiRef.current;
      if (!api) return;
      // IncludingDeleted — the soft-deleted source design we want to revive
      // is filtered out of the default getSceneElements().
      const elements = api.getSceneElementsIncludingDeleted();
      const base = elements.find((el) => el.id === baseId);
      if (!base) return;
      const binding = getMockupBinding(base);
      if (!binding) return;

      // Resolve the design element that will end up on canvas — either the
      // soft-deleted source revived in place, or a fresh element synthesized
      // from binding.designFileId when the source was lost (legacy bindings,
      // hard-deleted by undo). The fallback is async because Image() decode is.
      const source = elements.find((el) =>
        el.isDeleted && el.type === "image" &&
        (el.customData as Record<string, unknown> | undefined)?.[MOCKUP_SOURCE_FOR_KEY] === baseId,
      );
      let designEl: ExcalidrawElement | null;
      if (source) {
        designEl = newElementWith(source, {
          isDeleted: false,
          x: worldX - source.width / 2,
          y: worldY - source.height / 2,
          customData: withoutMockupSourceFor(source.customData),
        });
      } else {
        const file = api.getFiles()[binding.designFileId];
        if (!file?.dataURL) { removeMockup(baseId); return; }
        let dims: { width: number; height: number };
        try {
          dims = await imageDimensionsFromDataURL(file.dataURL);
        } catch {
          removeMockup(baseId);
          return;
        }
        const [created] = convertToExcalidrawElements([{
          type: "image",
          x: worldX - dims.width / 2,
          y: worldY - dims.height / 2,
          width: dims.width,
          height: dims.height,
          fileId: binding.designFileId,
          status: "saved",
        }]);
        designEl = created ?? null;
      }
      if (!designEl) { removeMockup(baseId); return; }

      const apiNow = excalidrawApiRef.current;
      if (!apiNow) return;
      const liveElements = apiNow.getSceneElementsIncludingDeleted();
      const baseUpdated = newElementWith(base, {
        customData: withoutMockupBinding(base.customData),
      });
      const designId = designEl.id;
      const replaced = source !== undefined;
      const next: ExcalidrawElement[] = liveElements.map((el) => {
        if (el.id === baseId) return baseUpdated;
        if (replaced && el.id === source.id) return designEl;
        return el;
      });
      if (!replaced) next.push(designEl);
      apiNow.updateScene({
        elements: next,
        appState: soleSelectionAppState(designId),
      });
    },
    [excalidrawApiRef, removeMockup],
  );

  const bindDesignToBase = useCallback(
    ({ baseId, designId, designFileId, anchor }: {
      baseId: string;
      designId: string;
      designFileId: FileId;
      anchor: readonly [number, number];
    }) => {
      const api = excalidrawApiRef.current;
      if (!api) return;
      const elements = api.getSceneElements();
      const base = elements.find((el) => el.id === baseId);
      const design = elements.find((el) => el.id === designId);
      if (!base || base.type !== "image" || !("fileId" in base) || !base.fileId) return;
      if (!design) return;
      const depthId = depthFileIdFor(base.fileId as FileId);
      const maskId = maskFileIdFor(base.fileId as FileId);
      const files = api.getFiles();
      if (!files[depthId]) {
        // Defensive — bind shouldn't be called before depth is ready, but if
        // somehow it is, treat as no-op so user retries.
        return;
      }
      const binding: Mockup3dBinding = {
        designFileId,
        depthFileId: depthId,
        maskFileId: files[maskId] ? maskId : undefined,
        anchor,
        scale: DEFAULT_MOCKUP_SCALE,
        rotation: DEFAULT_MOCKUP_ROTATION,
        strength: DEFAULT_MOCKUP_STRENGTH,
        maskThreshold: DEFAULT_MOCKUP_MASK_THRESHOLD,
      };
      const baseUpdated = newElementWith(base, {
        customData: withMockupBinding(base.customData, binding),
      });
      const designUpdated = newElementWith(design, {
        isDeleted: true,
        customData: {
          ...((design.customData as Record<string, unknown> | undefined) ?? {}),
          [MOCKUP_SOURCE_FOR_KEY]: baseId,
        },
      });
      const next: ExcalidrawElement[] = elements.map((el) => {
        if (el.id === baseId) return baseUpdated;
        if (el.id === designId) return designUpdated;
        return el;
      });
      api.updateScene({
        elements: next,
        appState: soleSelectionAppState(baseId),
      });
      setReceivingBaseId(null);
    },
    [excalidrawApiRef],
  );

  // Generic patch helper for the three scalar binding fields.
  const patchBinding = useCallback(
    (baseId: string, patch: Partial<Mockup3dBinding>) => {
      const api = excalidrawApiRef.current;
      if (!api) return;
      const elements = api.getSceneElements();
      const target = elements.find((el) => el.id === baseId);
      if (!target) return;
      const binding = getMockupBinding(target);
      if (!binding) return;
      // Skip the scene update when the patch is a no-op — pointermove drag
      // ratio briefly equals 1 (no movement), and Redux/Excalidraw treats
      // every updateScene as a real mutation, kicking a full render cycle.
      let changed = false;
      for (const k of Object.keys(patch) as (keyof Mockup3dBinding)[]) {
        if (binding[k] !== patch[k]) { changed = true; break; }
      }
      if (!changed) return;
      const merged: Mockup3dBinding = { ...binding, ...patch };
      const updated = newElementWith(target, {
        customData: withMockupBinding(target.customData, merged),
      });
      const next: ExcalidrawElement[] = elements.map((el) =>
        el.id === baseId ? updated : el,
      );
      api.updateScene({ elements: next });
    },
    [excalidrawApiRef],
  );

  const updateAnchor = useCallback(
    (baseId: string, anchor: readonly [number, number]) =>
      patchBinding(baseId, { anchor }),
    [patchBinding],
  );
  const updateScale = useCallback(
    (baseId: string, scale: number) => patchBinding(baseId, { scale: clampScale(scale) }),
    [patchBinding],
  );
  const updateScaleY = useCallback(
    (baseId: string, scaleY: number) => patchBinding(baseId, { scaleY: clampScale(scaleY) }),
    [patchBinding],
  );
  const updateRotation = useCallback(
    (baseId: string, rotation: number) => patchBinding(baseId, { rotation }),
    [patchBinding],
  );
  const updateStrength = useCallback(
    (baseId: string, strength: number) => patchBinding(baseId, { strength: clamp01(strength) }),
    [patchBinding],
  );
  const updateMaskThreshold = useCallback(
    (baseId: string, maskThreshold: number) =>
      patchBinding(baseId, { maskThreshold: clamp01(maskThreshold) }),
    [patchBinding],
  );
  const updateOpacity = useCallback(
    (baseId: string, opacity: number) => patchBinding(baseId, { opacity: clamp01(opacity) }),
    [patchBinding],
  );

  // Auto-clean: if receivingBaseId points at a deleted/missing element,
  // drop the receiving state so UI doesn't reference ghosts.
  useEffect(() => {
    if (!receivingBaseId) return;
    const api = excalidrawApiRef.current;
    if (!api) return;
    const stillExists = api
      .getSceneElements()
      .some((el) => el.id === receivingBaseId && !el.isDeleted);
    if (!stillExists) setReceivingBaseId(null);
  }, [receivingBaseId, excalidrawApiRef]);

  // Stable identity so consumers can list this hook's output in effect deps
  // without re-attaching listeners every parent render.
  return useMemo<UseMockup>(() => ({
    receivingBaseId,
    depthStatusFor,
    enterReceiving,
    exitReceiving,
    removeMockup,
    detachDesign,
    bindDesignToBase,
    updateAnchor,
    updateScale,
    updateScaleY,
    updateRotation,
    updateStrength,
    updateMaskThreshold,
    updateOpacity,
  }), [
    receivingBaseId, depthStatusFor, enterReceiving, exitReceiving, removeMockup,
    detachDesign, bindDesignToBase, updateAnchor, updateScale, updateScaleY,
    updateRotation, updateStrength, updateMaskThreshold, updateOpacity,
  ]);
}
