import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ImageOff, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

const MAX_RETRIES = 2;

interface SmartImageProps {
  src: string;
  alt: string;
  /** 应用到 <img> 的 className */
  className?: string;
  /**
   * 应用到外层容器。调用方必须提供:
   * - `relative` (否则 loading/error overlay 无法 absolute 对齐)
   * - 固定宽高 (如 `size-28` / `aspect-square`, 否则空 src 分支内容塌缩为 0 像素)
   */
  containerClassName?: string;
  onClick?: () => void;
  /** src 为空时展示的占位节点 */
  placeholder?: ReactNode;
}

/**
 * 带加载动画 + 自动重试 + 手动重试的图片组件。
 *
 * 场景:
 * - 开发时 ngrok tunnel rotate 或 S3 signed URL 偶发失败
 * - 生图 / 合成任务完成后 URL 立即下发但 CDN 还在传播
 *
 * 自动重试: onError 后按 1s/2s 递增延迟最多重试 MAX_RETRIES 次
 * 缓存绕过: 重试时给 URL 附加 `_r=N` 查询参数防命中浏览器缓存
 *
 * 调用方约定: containerClassName 需要含 `relative`, 否则 overlay 无法 absolute 对齐容器
 */
export function SmartImage({
  src,
  alt,
  className,
  containerClassName,
  onClick,
  placeholder,
}: SmartImageProps) {
  const { t } = useTranslation("canvasUi");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const retryTimerRef = useRef<number | null>(null);

  // src 变化时重置状态, 并在切换/卸载时清理待执行的 retry 定时器
  // 避免 "Can't perform a React state update on an unmounted component"
  useEffect(() => {
    if (src) {
      setLoading(true);
      setError(false);
      setRetryCount(0);
    }
    return () => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [src]);

  const handleLoad = useCallback(() => {
    setLoading(false);
    setError(false);
  }, []);

  const handleError = useCallback(() => {
    setLoading(false);
    if (retryCount < MAX_RETRIES) {
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        setRetryCount((prev) => prev + 1);
        setLoading(true);
        setError(false);
      }, 1000 * (retryCount + 1));
    } else {
      setError(true);
    }
  }, [retryCount]);

  const handleRetry = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    setRetryCount(0);
    setLoading(true);
    setError(false);
  }, []);

  if (!src) {
    return (
      <div className={containerClassName} onClick={onClick}>
        <div className="flex h-full w-full items-center justify-center">
          {placeholder}
        </div>
      </div>
    );
  }

  // 重试时附加 _r 查询参数绕过浏览器缓存, 原本带 query 的 URL 用 & 拼接
  const imgSrc =
    retryCount > 0
      ? `${src}${src.includes("?") ? "&" : "?"}_r=${retryCount}`
      : src;

  return (
    <div className={containerClassName} onClick={onClick}>
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-muted">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}
      {error && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 bg-muted">
          <ImageOff className="size-6 text-muted-foreground/40" />
          <button
            type="button"
            onClick={handleRetry}
            className="flex items-center gap-1 rounded border bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className="size-2.5" />
            {t("image.retry")}
          </button>
        </div>
      )}
      <img
        src={imgSrc}
        alt={alt}
        className={cn(className, (loading || error) && "opacity-0")}
        loading="lazy"
        onLoad={handleLoad}
        onError={handleError}
      />
    </div>
  );
}
