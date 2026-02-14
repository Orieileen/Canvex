import * as React from "react";

export function RingIcon({
  size = 24,
  color = "currentColor",
  strokeWidth = 2,
  // 仅在鼠标悬停时触发动画；如需始终动画，将其设为 false 并在外部传入 className 覆盖
  hoverOnly = true,
  spinDuration = 0.75, // 秒（此属性对旧的旋转保留，当前用于控制动画节奏）
  // 沿 Y 轴镜像（水平翻转）。不影响旋转动画；默认开启。
  mirrorY = true,
  className,
  ...props
}: React.SVGProps<SVGSVGElement> & {
  size?: number;
  color?: string;
  strokeWidth?: number;
  hoverOnly?: boolean;
  spinDuration?: number; // seconds
  mirrorY?: boolean;
}) {
  // 针对 viewBox 0 0 24 24，围绕 x=12 做 Y 轴镜像：T(12,0) · S(-1,1) · T(-12,0)
  const mirrorTransform = mirrorY ? 'translate(12 0) scale(-1 1) translate(-12 0)' : undefined;
  // 新动画使用到的路径与长度（归一化方便 dash 动画）
  const d = "M10.72,19.9a8,8,0,0,1-6.5-9.79A7.77,7.77,0,0,1,10.4,4.16a8,8,0,0,1,9.49,6.52A1.54,1.54,0,0,0,21.38,12h.13a1.37,1.37,0,0,0,1.38-1.54,11,11,0,1,0-12.7,12.39A1.54,1.54,0,0,0,12,21.34h0A1.47,1.47,0,0,0,10.72,19.9Z";
  const pathLength = 100; // 归一化长度，便于 dash 动画
  const triggerClass = hoverOnly ? undefined : 'animate-once';
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      // 使用 CSS 动画替代 SMIL；hoverOnly 时在 :hover 触发，否则初渲染即触发一次
      className={[
        'origin-center transition-transform duration-300 hover:scale-105',
        triggerClass,
        className,
      ].filter(Boolean).join(' ')}
      style={{ ['--dur' as any]: `${spinDuration}s`, ...(props.style || {}) }}
      {...props}
    >
      {/* 一次性“收缩为小点 → 重绘为完整环”的动画样式 */}
      <style>{`
        /* 0%→20%：群组快速缩成小点；随后恢复到原始大小 */
        @keyframes ring-collapse { 0% { transform: scale(1); } 20% { transform: scale(.06); } 100% { transform: scale(1); } }
        /* 20%→100%：从“无描边”到“完整描边”，重绘一次 */
        @keyframes ring-redraw { 0% { stroke-dasharray: 0 ${pathLength}; } 100% { stroke-dasharray: ${pathLength} 0; } }

        /* 触发条件：hover 或初次渲染（非 hoverOnly） */
        svg.animate-once .group, svg:hover .group { animation: ring-collapse var(--dur) ease-in-out 1 forwards; transform-origin: 12px 12px; }
        svg.animate-once .ring,  svg:hover .ring  { animation: ring-redraw calc(var(--dur) * .8) ease-out 1 calc(var(--dur) * .2) forwards; }
      `}</style>
      <g transform={mirrorTransform}>
        {/* 群组用于整体缩放为小点 */}
        <g className="group">
          {/* 默认显示完整环；hover 时短暂置空并重绘 */}
          <path
            className="ring"
            d={d}
            pathLength={pathLength}
            stroke={color}
            strokeWidth={strokeWidth}
            fill="none"
            style={{ strokeDasharray: `${pathLength} 0`, strokeDashoffset: 0 }}
          />
        </g>
      </g>
    </svg>
  );
}
