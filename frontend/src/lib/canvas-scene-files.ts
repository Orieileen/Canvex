import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
  FileId,
} from "@excalidraw/excalidraw/element/types";

import { buildBinaryFile, fetchAsDataURL } from "@/hooks/use-canvas-pinning";
import { getMockupBinding } from "@/lib/canvas-mockup";
import { getAiChatImageUrl } from "@/lib/excalidraw-custom-data";
import type { CanvasSceneData } from "@/types/canvex";

/**
 * Chat/toolbar-pinned images carry their canonical URL on
 * `customData.aiChatImageUrl`; the dataURL in `files` is a regenerable render
 * cache. Stripping it on save + re-fetching on load shrinks scene payloads
 * from tens of MB to kilobytes.
 */

interface UrlBackedImage {
  fileId: FileId;
  url: string;
}

function urlBackedImages(elements: readonly ExcalidrawElement[]): UrlBackedImage[] {
  const out: UrlBackedImage[] = [];
  for (const el of elements) {
    if (el.type !== "image") continue;
    const img = el as ExcalidrawImageElement;
    if (!img.fileId) continue;
    const url = getAiChatImageUrl(el);
    if (!url) continue;
    out.push({ fileId: img.fileId, url });
  }
  return out;
}

/** Drop `files` entries that are either URL-backed (hydratable on load) or
 *  orphan (fileId not referenced by any element — Excalidraw leaves these
 *  behind after element delete; nothing points at them, safe to drop). */
export function stripHydratableFiles(data: CanvasSceneData): CanvasSceneData {
  const elements = data.elements as readonly ExcalidrawElement[] | undefined;
  const files = data.files as BinaryFiles | undefined;
  if (!elements || !files) return data;

  const referencedIds = new Set<FileId>();
  const hydratableIds = new Set<FileId>();
  for (const el of elements) {
    if (el.type !== "image") continue;
    const img = el as ExcalidrawImageElement;
    if (img.fileId) {
      referencedIds.add(img.fileId);
      if (getAiChatImageUrl(el)) hydratableIds.add(img.fileId);
    }
    // Mockup binding holds a designFileId + depthFileId that point to files
    // no longer owned by any image element (the original design was removed
    // when bound; depth was generated from base, not part of any element).
    // Without this, the files get dropped and the 3D mockup overlay loses
    // its textures on reload.
    const mockup = getMockupBinding(el);
    if (mockup) {
      referencedIds.add(mockup.designFileId);
      referencedIds.add(mockup.depthFileId);
      if (mockup.maskFileId) referencedIds.add(mockup.maskFileId);
    }
  }

  const kept: BinaryFiles = {};
  let dropped = false;
  for (const [fileId, file] of Object.entries(files)) {
    const id = fileId as FileId;
    if (!referencedIds.has(id) || hydratableIds.has(id)) {
      dropped = true;
      continue;
    }
    kept[fileId] = file;
  }
  return dropped ? { ...data, files: kept } : data;
}

/** Fetch URL-backed images whose fileId is missing from `files`, in parallel. */
export async function hydrateUrlBackedFiles(data: CanvasSceneData): Promise<CanvasSceneData> {
  const elements = data.elements as readonly ExcalidrawElement[] | undefined;
  if (!elements) return data;

  const existingFiles = (data.files as BinaryFiles | undefined) ?? {};
  // Dedupe on fileId: a single pinned image copy-pasted N times yields N
  // identical {fileId, url} pairs. Without this, N parallel fetches race for
  // the same slot (last-write-wins), burning HTTP budget for nothing.
  const seen = new Set<FileId>();
  const toFetch: UrlBackedImage[] = [];
  for (const pair of urlBackedImages(elements)) {
    if (existingFiles[pair.fileId]) continue;
    if (seen.has(pair.fileId)) continue;
    seen.add(pair.fileId);
    toFetch.push(pair);
  }
  if (toFetch.length === 0) return data;

  const fetched = await Promise.all(
    toFetch.map(async ({ fileId, url }) => {
      try {
        const { dataURL, mimeType } = await fetchAsDataURL(url);
        return buildBinaryFile(fileId, dataURL, mimeType);
      } catch (err) {
        // Best-effort: a broken thumbnail beats a blocked scene load. Warn so
        // dev sees 401/403/CORS in console instead of it being truly silent.
        console.warn("[canvas] hydrate fetch failed", url, err);
        return null;
      }
    }),
  );

  const merged: BinaryFiles = { ...existingFiles };
  for (const file of fetched) {
    if (file) merged[file.id] = file;
  }
  return { ...data, files: merged };
}
