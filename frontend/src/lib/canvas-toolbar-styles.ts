import { cn } from "@/lib/utils";

/**
 * 编辑栏参数行里那一排控件的样式。
 *
 * 单独成文件是因为它有两个使用方: ImageEditBar 里的原生 `<select>` (Auto / 2K / ×1),
 * 和 ImageModelSelector 的文字形态触发按钮 —— 后者是个 Popover, 不是 select, 但它就站在
 * 那三个的旁边, 长得不一样就会被当成动作按钮而不是"当前选的是什么"。ImageEditBar 已经
 * import 了 ImageModelSelector, 所以常量不能住在 ImageEditBar 里(会成环)。
 *
 * 抄一份的下场已经发生过一次: 抄的那份继承了 Button 的 `disabled:opacity-50`, 于是提交
 * 中它跟同排的邻居褪色深浅不一样。
 */
export const toolbarSelectClass = cn(
  "h-10 cursor-pointer border-none bg-transparent px-2 text-xs text-muted-foreground",
  "outline-none hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60",
);
