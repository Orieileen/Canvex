// 后端 serializer 故意返回相对 `/media/...` URL (见 backend serializers.py:
// Vite proxy changeOrigin 会把 Host 改成 docker 内网, 浏览器解析不了)。前端展示
// (<img>/<video> src) 时必须补上 api base, 否则根相对会按前端源 (:5173) 解析成 404。
// 与 use-canvas-pinning 的 MEDIA_API_BASE / fetchAsBlob 同一套规则, 单独抽出供
// 纯展示路径复用 (不想为了拿 base 去 import 那个重 hook)。
export const MEDIA_API_BASE =
  import.meta.env.VITE_API_URL ||
  (import.meta.env.DEV ? "http://localhost:8000" : "");

/** 相对 `/media/...` → 绝对; data:/blob:/http(s): 原样透传。 */
export function absoluteMediaUrl(url: string): string {
  return url.startsWith("/") ? `${MEDIA_API_BASE}${url}` : url;
}
