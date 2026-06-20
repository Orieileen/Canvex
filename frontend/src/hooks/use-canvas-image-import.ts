import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { canvasService } from "@/services/canvas.service";
import { extractApiError } from "@/services/errors";
import { MAX_UPLOAD_IMAGE_BYTES } from "@/lib/upload-limits";
import { screenPointToWorld } from "@/lib/excalidraw-bounds";
import type { UseCanvasPinning } from "@/hooks/use-canvas-pinning";

/**
 * Full-resolution image import for the canvas — uploads the ORIGINAL file to the
 * backend (→ Qiniu CDN) and pins the returned URL at native pixel size.
 *
 * Why: Excalidraw runs every native import (drop, paste, AND the toolbar image
 * tool) through `resizeImageFile`, which downscales to ≤1440px and re-encodes —
 * below Amazon's main-image spec (≥1600px) and fatal to the pixel precision this
 * canvas exists to provide. We intercept all three entry points *before*
 * Excalidraw and route them through the same `uploadAttachment` → `pinImage`
 * path the chat/agent images use, so a 2048² lands as a true 2048², URL-backed
 * (so it never bloats the saved scene as a giant dataURL).
 *
 * Placement (matches Excalidraw's native per-entry behavior):
 *   - drop → lands at the drop point immediately.
 *   - toolbar image tool / "9" / paste → enters *placement mode*: a
 *     cursor-follow ghost preview at real on-canvas size, click to drop it, Esc
 *     / right-click to cancel. The upload runs in parallel during positioning so
 *     the file is usually on the CDN by the time the user clicks.
 *
 * Interception (verified against Excalidraw 0.18.1 source):
 *   - drop / paste — `paste` is bound on `document` (bubble); `drop` on
 *     Excalidraw's container + React's root (both bubble). A `document`
 *     capture-phase listener fires first; `stopPropagation()` keeps the event
 *     from ever reaching Excalidraw. (`onPaste` is unusable: Excalidraw
 *     short-circuits clipboard image files and `return`s before invoking it.)
 *   - toolbar image tool + "9" — both call `setActiveTool({type:"image"})` →
 *     `onImageAction`, which opens the OS file dialog *synchronously* in the
 *     gesture stack (so `onChange` detection is too late). We intercept the
 *     button click and the "9" keydown in the capture phase, before
 *     `setActiveTool`, and open our own picker.
 *
 * Non-image payloads (text, copied elements, `.excalidraw` files, SVG) and every
 * other tool/shortcut fall through untouched. If Excalidraw renames the
 * image-tool testid, the button interceptor matches nothing → no-op, native
 * (resized) flow stays.
 */

const SVG_MIME = "image/svg+xml";
const MAX_UPLOAD_IMAGE_MB = Math.round(MAX_UPLOAD_IMAGE_BYTES / (1024 * 1024));

// Excalidraw 0.18.1: the image tool radio carries `data-testid="toolbar-image"`
// (rendered as `toolbar-${value}`) and its only key trigger is numericKey "9"
// (letter key is null). Both route through the resize-on-import dialog.
const IMAGE_TOOL_TESTID = "toolbar-image";
const IMAGE_TOOL_KEY = "9";
const FILE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif,image/x-icon";
// Clicking a <label> synthesizes a second click on its radio input; ignore a
// re-trigger within this window so one user click opens exactly one picker.
const REOPEN_GUARD_MS = 700;

function isRasterImage(type: string): boolean {
  // SVG excluded: no intrinsic pixel size (decode → 0×0) and irrelevant to
  // pixel-precise Amazon work — let Excalidraw handle it.
  return type.startsWith("image/") && type !== SVG_MIME;
}

function filterRasterImages(files: ArrayLike<File>): File[] {
  return Array.from(files).filter((f) => isRasterImage(f.type));
}

/** Pull raster image `File`s out of a drop/paste `DataTransfer`. Non-image
 *  payloads yield `[]` so the caller leaves the event for Excalidraw. Reads
 *  `.files` first (reliable for drops + Chromium pastes); falls back to
 *  `.items` (some browsers only expose pasted images there). */
export function rasterImageFilesFromTransfer(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  const fromFiles = filterRasterImages(dt.files);
  if (fromFiles.length) return fromFiles;
  const fromItems: File[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind === "file" && isRasterImage(item.type)) {
      const file = item.getAsFile();
      if (file) fromItems.push(file);
    }
  }
  return fromItems;
}

/** Is this element a writable field where keystrokes are text input, not a
 *  canvas shortcut? Mirrors Excalidraw's own shortcut guard. */
function isWritableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    !!target.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')
  );
}

/** Decode an image src (object URL) to its natural pixel size. Local copy so
 *  this module never imports `@excalidraw/excalidraw` at runtime (keeps it
 *  vitest-loadable without the open-color JSON-import workaround). */
function imageNaturalSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = src;
  });
}

/** Each pending upload resolves to a result object (never rejects) so a slow/
 *  failed upload sitting between begin and place never trips an unhandled
 *  rejection. */
type UploadResult = { ok: true; url: string } | { ok: false; err: unknown };

interface PlacementJob {
  previewUrl: string;
  uploads: Promise<UploadResult>[];
  total: number;
}

/** Active cursor-follow placement (drives the ghost overlay). Null when idle. */
export interface CanvasImagePlacement {
  /** Object URL of the first picked file — the ghost preview source. */
  previewUrl: string;
  naturalWidth: number;
  naturalHeight: number;
}

interface UseCanvasImageImportOptions {
  /** The canvas pane wrapper; events outside it are ignored. */
  paneRef: RefObject<HTMLDivElement | null>;
  /** Live Excalidraw API — used to convert pointer coords to world coords. */
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  /** Active scene id; uploads are scoped to it. Null disables the importer. */
  sceneId: string | null;
  /** Full-res URL-backed pin (native placement + auto-frame). */
  pinImage: UseCanvasPinning["pinImage"];
}

export interface UseCanvasImageImport {
  /** Non-null while an import awaits click placement (drives the ghost overlay). */
  placement: CanvasImagePlacement | null;
  /** Finalize: pin the pending upload(s) with top-left at `anchor` (world). */
  placeAt: (anchor: { x: number; y: number }) => void;
  /** Discard the pending placement (Esc / right-click / scene switch). */
  cancelPlacement: () => void;
}

export function useCanvasImageImport({
  paneRef,
  excalidrawApiRef,
  sceneId,
  pinImage,
}: UseCanvasImageImportOptions): UseCanvasImageImport {
  const jobRef = useRef<PlacementJob | null>(null);
  // Bumped on every cancel / replace; beginPlacement captures it before its async
  // decode and discards itself if it changed (a newer import started, or the
  // scene/effect tore down) — so a late resolve can't install a stale ghost.
  const placementGenRef = useRef(0);
  const [placement, setPlacement] = useState<CanvasImagePlacement | null>(null);

  /** Filter out files over the size limit, toasting once if any were dropped. */
  const acceptBySize = useCallback(
    (files: File[]): File[] => {
      const accepted = files.filter((f) => f.size <= MAX_UPLOAD_IMAGE_BYTES);
      if (accepted.length < files.length) {
        toast.error(`Some images exceed the ${MAX_UPLOAD_IMAGE_MB} MB limit and were skipped.`);
      }
      return accepted;
    },
    [],
  );

  /** Fire all uploads at once (parallel), each resolving to a result — never
   *  rejecting, so they can sit pending until awaited without unhandled-rejection. */
  const startUploads = useCallback(
    (sid: string, files: File[]): Promise<UploadResult>[] =>
      files.map((file) =>
        canvasService
          .uploadAttachment(sid, file)
          .then((r): UploadResult => ({ ok: true, url: r.data.url }))
          .catch((err: unknown): UploadResult => ({ ok: false, err })),
      ),
    [],
  );

  /** Await the (parallel) uploads in order and pin each — sequential pinning so
   *  every pin sees the prior one and the collision search lays a multi-file
   *  batch out without overlap. Shared by the drop and placement paths. */
  const pinUploads = useCallback(
    async (uploads: Promise<UploadResult>[], total: number, startAt: { x: number; y: number } | undefined) => {
      const toastId = toast.loading("Importing image…");
      let ok = 0;
      let lastError: unknown = null;
      for (const upload of uploads) {
        const res = await upload;
        if (!res.ok) {
          lastError = res.err;
          continue;
        }
        try {
          await pinImage({ url: res.url, dedupKey: res.url, startAt });
          ok += 1;
        } catch (err) {
          lastError = err;
        }
      }
      if (ok === total) {
        toast.success("Image imported", { id: toastId });
      } else if (ok === 0) {
        toast.error(extractApiError(lastError, "Image import failed"), { id: toastId });
      } else {
        toast.error(`Imported ${ok}, ${total - ok} failed`, { id: toastId });
      }
    },
    [pinImage],
  );

  const cancelPlacement = useCallback(() => {
    placementGenRef.current += 1; // invalidate any in-flight beginPlacement
    const job = jobRef.current;
    if (job) {
      URL.revokeObjectURL(job.previewUrl);
      jobRef.current = null;
    }
    setPlacement(null);
  }, []);

  const placeAt = useCallback(
    (anchor: { x: number; y: number }) => {
      const job = jobRef.current;
      if (!job) return; // already placed / cancelled (ref nulled synchronously)
      jobRef.current = null;
      URL.revokeObjectURL(job.previewUrl);
      setPlacement(null);
      void pinUploads(job.uploads, job.total, anchor);
    },
    [pinUploads],
  );

  // Drop path — immediate pin at the drop point (no placement mode).
  const importAt = useCallback(
    async (files: File[], startAt: { x: number; y: number } | undefined): Promise<void> => {
      if (!sceneId) return;
      const accepted = acceptBySize(files);
      if (!accepted.length) return;
      await pinUploads(startUploads(sceneId, accepted), accepted.length, startAt);
    },
    [sceneId, acceptBySize, startUploads, pinUploads],
  );

  // Toolbar / "9" / paste path — start the upload(s) and enter placement mode.
  const beginPlacement = useCallback(
    async (files: File[]): Promise<void> => {
      if (!sceneId) return;
      const accepted = acceptBySize(files);
      if (!accepted.length) return;
      cancelPlacement(); // replace any in-flight placement (bumps the generation)
      const gen = placementGenRef.current;

      const previewUrl = URL.createObjectURL(accepted[0]);
      const uploads = startUploads(sceneId, accepted);
      let size: { width: number; height: number };
      try {
        size = await imageNaturalSize(previewUrl);
      } catch {
        size = { width: 0, height: 0 };
      }
      // A newer import started, or the placement was cancelled / torn down during
      // the decode → discard this stale one silently (revoke so it doesn't leak)
      // instead of clobbering the current job / setting state after teardown.
      if (gen !== placementGenRef.current) {
        URL.revokeObjectURL(previewUrl);
        return;
      }
      // Decode failed or reported no intrinsic size (broken / 0×0 raster): a
      // 0-size ghost is invisible and would pin a 0×0, unselectable element.
      if (!size.width || !size.height) {
        URL.revokeObjectURL(previewUrl);
        toast.error("Image import failed");
        return;
      }
      jobRef.current = { previewUrl, uploads, total: accepted.length };
      setPlacement({ previewUrl, naturalWidth: size.width, naturalHeight: size.height });
    },
    [sceneId, acceptBySize, startUploads, cancelPlacement],
  );

  useEffect(() => {
    if (!sceneId) return;

    const targetInPane = (target: EventTarget | null): boolean =>
      target instanceof Node && !!paneRef.current?.contains(target);

    // Programmatic file picker — replaces Excalidraw's toolbar image tool.
    let lastPickerAt = 0;
    const openFilePicker = () => {
      const now = Date.now();
      if (now - lastPickerAt < REOPEN_GUARD_MS) return;
      lastPickerAt = now;
      const input = document.createElement("input");
      input.type = "file";
      input.accept = FILE_ACCEPT;
      input.multiple = true;
      input.addEventListener(
        "change",
        () => {
          const files = filterRasterImages(input.files ?? []);
          if (files.length) void beginPlacement(files);
        },
        { once: true },
      );
      input.click();
    };

    const onDragOver = (e: DragEvent) => {
      if (!targetInPane(e.target)) return;
      if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
      // Mark the pane a valid drop target so the browser fires `drop`.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };

    const onDrop = (e: DragEvent) => {
      if (!targetInPane(e.target)) return;
      const files = rasterImageFilesFromTransfer(e.dataTransfer);
      if (!files.length) return; // non-image drop → Excalidraw handles it
      e.preventDefault();
      e.stopPropagation();
      const pane = paneRef.current;
      const api = excalidrawApiRef.current;
      let startAt: { x: number; y: number } | undefined;
      if (pane && api) {
        const app = api.getAppState();
        startAt = screenPointToWorld(
          { clientX: e.clientX, clientY: e.clientY },
          pane.getBoundingClientRect(),
          { zoom: app.zoom?.value ?? 1, scrollX: app.scrollX ?? 0, scrollY: app.scrollY ?? 0 },
        );
      }
      void importAt(files, startAt);
    };

    const onPaste = (e: ClipboardEvent) => {
      if (!targetInPane(e.target)) return;
      const files = rasterImageFilesFromTransfer(e.clipboardData);
      if (!files.length) return; // text / copied elements → leave it alone
      e.preventDefault();
      e.stopPropagation();
      void beginPlacement(files); // paste → cursor-follow placement
    };

    // Toolbar image tool: the radio carries the testid and sits in a <label>
    // alongside its icon, so a click may land on the input, the icon, or the
    // label. Match either directly or via the enclosing label (kept local to the
    // clicked element so duplicate/responsive toolbars resolve independently).
    const onClickCapture = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (!el) return;
      const sel = `input[data-testid="${IMAGE_TOOL_TESTID}"]`;
      if (!el.matches(sel) && !el.closest("label")?.querySelector(sel)) return;
      e.preventDefault();
      e.stopPropagation();
      openFilePicker();
    };

    // "9" numeric shortcut — only when the canvas (not a text field) is focused.
    const onKeyDownCapture = (e: KeyboardEvent) => {
      if (e.key !== IMAGE_TOOL_KEY) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isWritableTarget(e.target)) return;
      if (!targetInPane(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      openFilePicker();
    };

    // Capture phase: beats Excalidraw's bubble-phase document/container/root
    // listeners and React's delegated handlers.
    document.addEventListener("dragover", onDragOver, true);
    document.addEventListener("drop", onDrop, true);
    document.addEventListener("paste", onPaste, true);
    document.addEventListener("click", onClickCapture, true);
    document.addEventListener("keydown", onKeyDownCapture, true);
    return () => {
      document.removeEventListener("dragover", onDragOver, true);
      document.removeEventListener("drop", onDrop, true);
      document.removeEventListener("paste", onPaste, true);
      document.removeEventListener("click", onClickCapture, true);
      document.removeEventListener("keydown", onKeyDownCapture, true);
      cancelPlacement(); // drop any pending ghost on scene switch / unmount
    };
  }, [sceneId, paneRef, excalidrawApiRef, importAt, beginPlacement, cancelPlacement]);

  return { placement, placeAt, cancelPlacement };
}
