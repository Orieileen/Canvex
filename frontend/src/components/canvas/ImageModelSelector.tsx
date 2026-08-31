import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ImageIcon, Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { toolbarSelectClass } from "@/lib/canvas-toolbar-styles";
import type { CanvasImageModelChoice } from "@/types/canvex";

/**
 * 生图模型选择器。
 *
 * 存在的理由: 模型以前只能写在后端 env 里, 一个部署固定一个。用户想这张图用 Google、
 * 下张用豆包就做不到。现在通道配置进了库, 这里就是每次生成前选用哪个。
 *
 * 出现在两处 —— 聊天栏 (ChatOverlay) 和编辑栏的 Image / Split 面板 (ImageEditBar)。
 * 两处**共用同一份画布级 state**, 改哪边都一样; 刻意不做两套独立选择, 否则用户搞不清
 * 哪个生效。编辑栏里只挂在真正走生图通道的 tab 上 —— Angle 走 fal.run、Video 是另一套
 * 配置、Merge/Mockup 根本不调 API, 摆上去就是骗人。
 *
 * UX 约定:
 * - **选择是粘的**(存 localStorage), 不是 per-message。画布是连续多轮的, 每次重选很烦;
 *   这跟旁边的 SkillSelector 刚好相反 —— 那个是刻意 per-message 的。
 * - **总是落在一个具体模型上**: useStickyModelChoice 会把没选过 / 已失效的选择自动
 *   落到列表第一项。所以 value 为空只可能是"一个通道都没配"。
 * - 那种情况下 popover 直接引导去配置页, 而不是显示一个空列表。
 */

interface ImageModelSelectorProps {
  /** GET /image-models/ 的结果。空 = 一条通道都还没配过。 */
  models: CanvasImageModelChoice[];
  /** 当前选中的 ImageModel.id;空只可能是 models 为空(一个都没配)。 */
  value: string;
  onChange: (modelId: string) => void;
  /** 打开「通道配置」面板。 */
  onOpenSettings: () => void;
  buttonDisabled?: boolean;
  /** 触发按钮长什么样, 取决于它站在哪一行:
   *  - `icon` (默认) 聊天栏 —— 那一行全是图标按钮(技能、发送), 文字反而突兀。
   *  - `text` 编辑栏 —— 那一行是 Auto / 2K / ×1 三个文字下拉。做成图标的话它既
   *    跟邻居不一致, 又跟右边的 ✂ / 🪄 两个动作按钮混在一起, 用户根本认不出这是
   *    "当前选的是什么"。文字版还顺带把选中的模型名写在脸上, 不用点开才知道。 */
  variant?: "icon" | "text";
  /** 触发按钮的额外 class —— 宿主工具栏的间距规则不同。 */
  className?: string;
  /** popover 抬头。Angle 面板要说"视角模型"—— 那里列的根本不是生图通道, 顶着
   *  "Image model" 会让人以为选错了地方。省略即生图。 */
  title?: string;
}

export function ImageModelSelector({
  models,
  value,
  onChange,
  onOpenSettings,
  buttonDisabled,
  variant = "icon",
  className,
  title,
}: ImageModelSelectorProps) {
  const { t } = useTranslation("canvasUi");
  const selected = models.find((m) => m.id === value);
  // 两种形态共用: 悬停提示要说全 (供应商 · 模型), 因为文字版会截断、图标版根本不显示。
  const hoverTitle = selected
    ? `${selected.provider_label} · ${selected.label}`
    : t("imageModels.pick");

  return (
    <Popover>
      <PopoverTrigger asChild>
        {variant === "text" ? (
          <Button
            type="button"
            variant="ghost"
            disabled={buttonDisabled}
            aria-label={t("imageModels.pick")}
            title={hoverTitle}
            // 跟同一行的 Auto / 2K / ×1 共用一份样式 —— 长得不一样就会被当成动作按钮。
            // hover:bg-transparent / font-normal / rounded-none 是压掉 Button 自带的。
            className={cn(
              toolbarSelectClass,
              "gap-1 rounded-none font-normal hover:bg-transparent",
              className,
            )}
          >
            <span className="max-w-[120px] truncate">
              {selected ? selected.label : t("imageModels.none")}
            </span>
            <ChevronDown className="size-3 shrink-0 opacity-60" strokeWidth={2} />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={buttonDisabled}
            aria-label={t("imageModels.pick")}
            title={hoverTitle}
            className={cn(
              "relative size-8 rounded-lg text-muted-foreground hover:text-foreground",
              className,
            )}
          >
            <ImageIcon className="size-4" strokeWidth={2} />
            {/* 有通道可用时点亮 —— 图标版不显示模型名, 这个点是"这里已经选中了某个
                模型"的唯一提示。一个都没配时不点, 免得空按钮看起来像已经配好了。
                (useStickyModelChoice 总会落到第一项, 所以 selected 等价于"列表非空"。) */}
            {selected && (
              <span className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" />
            )}
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 p-0"
        // 在列表里滚动**只滚列表**。这个弹层是 portal 到 body 的, 但 React 的合成事件
        // 沿**组件树**冒泡而不是 DOM 树 —— 所以滚轮会一路冒到工具栏根节点的
        // `onWheel={forwardWheelToCanvas}`, 那个 handler 会把滚轮**重新派发到
        // excalidraw 的 canvas 上**, 画布跟着平移, 看起来就是"整个页面在动"。
        // (同一个文件里的调整面板早就这么修过, 见 AdjustPanel 的 onWheel。)
        onWheel={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-3 py-2">
          <div className="text-[13px] font-medium">{title ?? t("imageModels.title")}</div>
        </div>

        {models.length === 0 ? (
          // 一个都没配时保留入口: 常驻的那行已经移到侧栏了, 但这正是用户第一次点开
          // 这里的时刻 —— 只写一句"去配置"而不给按钮就是死路。
          <div className="px-3 py-5 text-center">
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              {t("imageModels.empty")}
            </p>
            <button
              type="button"
              onClick={onOpenSettings}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] text-foreground transition-colors hover:bg-foreground/5"
            >
              <Settings2 className="size-3.5" strokeWidth={2} />
              {t("imageModels.configure")}
            </button>
          </div>
        ) : (
          // overscroll-contain: 滚到头之后别把回弹传给外面。画布上其它几个可滚面板
          // (ChatFrameOverlay / CanvasSidebar / 生成详情) 都加了这个类。
          // **真正让页面动的不是它**, 是上面 PopoverContent 那个 stopPropagation。
          <div className="max-h-72 overflow-y-auto overscroll-contain py-1">
            {models.map((m) => (
              <ModelRow
                key={m.id}
                label={m.label}
                hint={m.provider_label}
                active={m.id === value}
                onClick={() => onChange(m.id)}
              />
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function ModelRow({
  label,
  hint,
  active,
  onClick,
}: {
  label: string;
  hint: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-foreground/5",
        active && "bg-foreground/5",
      )}
    >
      <Check
        className={cn("mt-0.5 size-3.5 shrink-0", active ? "text-primary" : "opacity-0")}
        strokeWidth={2.5}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-foreground">{label}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}
