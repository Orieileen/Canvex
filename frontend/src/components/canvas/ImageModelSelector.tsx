import { useTranslation } from "react-i18next";
import { Check, ImageIcon, Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { CanvasImageModelChoice } from "@/types/canvex";

/**
 * 工具栏的生图模型选择器。
 *
 * 存在的理由: 模型以前只能写在后端 env 里, 一个部署固定一个。用户想这张图用 Google、
 * 下张用豆包就做不到。现在供应商配置进了库, 这里就是每次生成前选用哪个。
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
}

export function ImageModelSelector({
  models,
  value,
  onChange,
  onOpenSettings,
  buttonDisabled,
}: ImageModelSelectorProps) {
  const { t } = useTranslation("canvasUi");
  const selected = models.find((m) => m.id === value);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={buttonDisabled}
          aria-label={t("imageModels.pick")}
          title={selected ? `${selected.provider_label} · ${selected.label}` : t("imageModels.pick")}
          className="relative size-8 rounded-lg text-muted-foreground hover:text-foreground"
        >
          <ImageIcon className="size-4" strokeWidth={2} />
          {/* 选了非默认模型才点亮 —— 没配过的人看不出这里有东西 */}
          {selected && (
            <span className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="border-b border-border px-3 py-2">
          <div className="text-[13px] font-medium">{t("imageModels.title")}</div>
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
