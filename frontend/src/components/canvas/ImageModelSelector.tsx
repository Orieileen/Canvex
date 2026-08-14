import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ImageIcon, Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { CanvasImageModelChoice } from "@/types/canvex";

/**
 * 生图模型选择器。
 *
 * 存在的理由: 模型以前只能写在后端 env 里, 一个部署固定一个。用户想这张图用 Google、
 * 下张用豆包就做不到。现在供应商配置进了库, 这里就是每次生成前选用哪个。
 *
 * 出现在两处 —— 聊天栏 (ChatOverlay) 和编辑栏的 Image / Split 面板 (ImageEditBar)。
 * 两处**共用同一份画布级 state**, 改哪边都一样; 刻意不做两套独立选择, 否则用户搞不清
 * 哪个生效。编辑栏里只挂在真正走生图通道的 tab 上 —— Angle 走 fal.run、Video 是另一套
 * 配置、Merge/Mockup 根本不调 API, 摆上去就是骗人。
 *
 * UX 约定:
 * - **选择是粘的**(存 localStorage), 不是 per-message。画布是连续多轮的, 每次重选很烦;
 *   这跟旁边的 SkillSelector 刚好相反 —— 那个是刻意 per-message 的。
 * - 不选 = 用后端默认通道(env 里配的那条), 按钮不显徽标, 没配过供应商的人完全不会
 *   注意到这个功能存在。
 * - 一个模型都没配时, popover 直接引导去配置页, 而不是显示一个空列表。
 */

interface ImageModelSelectorProps {
  /** GET /image-models/ 的结果。空 = 还没配过任何供应商。 */
  models: CanvasImageModelChoice[];
  /** 当前选中的 ImageModel.id;空 = 用后端默认通道。 */
  value: string;
  onChange: (modelId: string) => void;
  /** 打开供应商配置面板。 */
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
            // 刻意抄 ImageEditBar 的 selectClass —— 它跟 Auto / 2K / ×1 是同一行同一
            // 类东西, 长得不一样就会被当成动作按钮。
            className={cn(
              "h-10 gap-1 rounded-none px-2 text-xs font-normal text-muted-foreground",
              "hover:bg-transparent hover:text-foreground",
              className,
            )}
          >
            <span className="max-w-[120px] truncate">
              {selected ? selected.label : t("imageModels.defaultShort")}
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
            {/* 选了非默认模型才点亮 —— 没配过的人看不出这里有东西 */}
            {selected && (
              <span className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" />
            )}
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="border-b border-border px-3 py-2">
          <div className="text-[13px] font-medium">{title ?? t("imageModels.title")}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {t("imageModels.subtitle")}
          </div>
        </div>

        {models.length === 0 ? (
          <div className="px-3 py-6 text-center">
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              {t("imageModels.empty")}
            </p>
          </div>
        ) : (
          <div className="max-h-72 overflow-y-auto py-1">
            {/* 「默认」这一项不是装饰: 它是"回到 env 通道"的唯一入口, 用户选了别的之后
                得能退回来。 */}
            <ModelRow
              label={t("imageModels.default")}
              hint={t("imageModels.defaultHint")}
              active={!value}
              onClick={() => onChange("")}
            />
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

        <button
          type="button"
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-[12px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          <Settings2 className="size-3.5" strokeWidth={2} />
          {t("imageModels.configure")}
        </button>
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
