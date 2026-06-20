/** 把 Blob 触发为浏览器下载. 同源直接 a[download] 也行, 但跨域 blob 会被
 *  忽略 download 属性 (浏览器走预览), 所以统一 createObjectURL → click,
 *  1s 后 revoke 给 click 的同步阶段留时间. */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 从 Content-Disposition 头解析文件名: filename*=UTF-8'' 优先 (含百分号编码),
 *  退回普通 filename="...". 都拿不到返回 null, 调用方自备兜底名。 */
export function filenameFromContentDisposition(
  header?: string | null,
): string | null {
  if (!header) return null;
  const star = header.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^["']|["']$/g, ""));
    } catch {
      // 编码异常时退回普通 filename
    }
  }
  const plain = header.match(/filename=["']?([^"';]+)["']?/i);
  return plain ? plain[1].trim().replace(/^["']|["']$/g, "") : null;
}

/** 从 blob.type / URL 推断图像扩展名 (不含点). blob.type 优先 (服务器返的
 *  真实 mime), 没有再扫 URL trailing extension, 都拿不到时走 fallback. */
export function pickImageExt(
  blob: Blob,
  url?: string | null,
  fallback = "png",
): string {
  const m = blob.type?.match(/^image\/([\w+-]+)/);
  if (m) return m[1] === "jpeg" ? "jpg" : m[1];
  if (url) {
    const u = url.match(/\.([a-z0-9]{3,4})(?:$|\?)/i);
    if (u) return u[1].toLowerCase();
  }
  return fallback;
}
