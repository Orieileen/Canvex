import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Copy, FileText, Loader2, Trash2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { MAX_SKILL_BYTES } from "@/lib/upload-limits";
import { cn } from "@/lib/utils";
import { canvasService } from "@/services/canvas.service";
import { extractApiError, parseApiErrors } from "@/services/errors";
import type { CanvasSkillRow } from "@/types/canvex";

/**
 * 装 / 卸 SKILL.md 的面板。
 *
 * ## 为什么上传和粘贴是同一条路
 *
 * SKILL.md 是纯文本, 所以「传文件」在前端就是 `await file.text()` —— 拿到字符串之后
 * 跟手打的没有任何区别, 走同一个 JSON 端点。不走 multipart 意味着后端不需要临时文件、
 * 不需要清理、也不需要一套只为这一个入口存在的解析路径。拖拽、点选、直接写, 三个入口
 * 一个实现。
 *
 * ## frontmatter 一律不在前端解析
 *
 * 这个组件从头到尾没有一行正则去抠 `name:`。skill 叫什么、合不合格、跟谁重名, 全部由
 * 后端解析后告诉我们 (重名时它连 `conflict_id` 一起回, 见下面的 install)。理由跟通道
 * 配置那次一样: 前端抄一份规则, 抄的那份会**抢先**生效, 后端改了等于没改, 而且不报错。
 */

interface SkillLibraryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 装/卸/停用之后调 —— 让 SkillSelector popover 重新拉 agent 视角的列表。 */
  onChanged: () => void;
}

/** 后端在重名时回的那两个字段。DRF 会把 ValidationError 的值统一包成数组,
 *  `parseApiErrors` 已经帮我们取了第一条, 所以这里拿到的是字符串。 */
interface Conflict {
  id: string;
  name: string;
  content: string;
  /** 这篇正文是不是编辑器里那份。只有它为 true 时, 覆盖成功后才该清空编辑器 ——
   *  一次拖了三个文件的话, 清掉的会是用户另外写到一半的东西。 */
  fromComposer: boolean;
}

export function SkillLibrary({ open, onOpenChange, onChanged }: SkillLibraryProps) {
  const { t } = useTranslation("canvasUi");
  const [rows, setRows] = useState<CanvasSkillRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  /** 「直接写一个」/「复制为我的」共用的新建编辑器。null = 没打开。 */
  const [composing, setComposing] = useState<string | null>(null);
  /** 待确认的重名, **队列**而不是单个。一次拖进来的几个文件可能个个重名, 而 `install`
   *  是"弹框之后立刻返回"的 —— 存单个的话第二个会把第一个顶掉, 用户只看得见最后一个,
   *  前面几个既没装上也没有任何提示。排队逐个问。 */
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const conflict = conflicts[0] ?? null;
  /** 关掉当前这条(取消 / 已处理), 露出队列里的下一条。 */
  const shiftConflict = useCallback(() => setConflicts((prev) => prev.slice(1)), []);
  const [deleteTarget, setDeleteTarget] = useState<CanvasSkillRow | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await canvasService.skillLibrary.list();
      setRows(data);
    } catch (err) {
      toast.error(extractApiError(err, "load skills failed"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    // 跟某一行绑定的状态每次打开都清掉。**编辑中的正文不在这里** —— 它归 SkillCard 自己,
    // 而 SkillCard 挂在 SheetContent (Radix 的 portal, 没有 forceMount) 里面, 关面板就
    // 卸载, 草稿跟着没, 不需要在这儿补一刀。`composing` 刻意不清: 它是一篇跟任何行都无关
    // 的草稿, 手滑关掉面板不该丢。
    setExpanded(null);
    setDeleteTarget(null);
    void reload();
  }, [open, reload]);

  /** 每一次改动之后都要做的两件事: 重拉自己的列表, 通知 popover 重拉 agent 视角的。
   *  漏掉后者的表现是"面板里删掉了, popover 里还在", 而两者就挨着。 */
  const afterChange = useCallback(async () => {
    // 两个请求互不读对方的结果, 排队跑等于白等一个来回。await 只挂在 reload 上, 因为
    // `busy` 要跟着列表刷新走。
    const listed = reload();
    onChanged();
    await listed;
  }, [reload, onChanged]);

  /** 装一篇。重名时后端回 400 + conflict_id, 我们把它变成一句「要覆盖吗」而不是报错 ——
   *  重装/更新自己的 SOP 是最高频的操作, 让用户先去删一遍太蠢。 */
  const install = useCallback(
    async (
      content: string,
      { fromComposer, refresh = true }: { fromComposer: boolean; refresh?: boolean },
    ): Promise<boolean> => {
      setBusy(true);
      try {
        const { data } = await canvasService.skillLibrary.create({ content });
        toast.success(t("skills.installed_toast", { name: data.name }));
        // `refresh: false` 是给批量拖入用的: 一次拖 5 个文件就是 5 次全量重拉 (每次都带
        // 全部 SKILL.md 正文), 而前 4 次的结果下一秒就被作废。循环跑完再拉一次。
        if (refresh) await afterChange();
        return true;
      } catch (err) {
        const { fields, summary } = parseApiErrors(err, "install failed");
        if (fields.conflict_id && fields.conflict_name) {
          setConflicts((prev) => [
            ...prev,
            { id: fields.conflict_id, name: fields.conflict_name, content, fromComposer },
          ]);
          return false;
        }
        toast.error(summary);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [afterChange, t],
  );

  /** 只吃 id 而不是整行 —— 重名覆盖那条路径上我们手里只有后端回的 conflict_id,
   *  没有那一行的其余字段。收一个假的 CanvasSkillRow 进来才是真会出事的写法。 */
  const patch = useCallback(
    async (id: string, body: Parameters<typeof canvasService.skillLibrary.update>[1],
           message: string) => {
      setBusy(true);
      try {
        await canvasService.skillLibrary.update(id, body);
        toast.success(message);
        await afterChange();
        return true;
      } catch (err) {
        toast.error(extractApiError(err, "save failed"));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [afterChange],
  );

  const readFiles = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return;
      let installed = false;
      for (const file of Array.from(files)) {
        if (!/\.(md|markdown)$/i.test(file.name)) {
          toast.error(t("skills.notMarkdown", { file: file.name }));
          continue;
        }
        if (file.size > MAX_SKILL_BYTES) {
          // 粗筛, 见 MAX_SKILL_BYTES: 太大的连后端那句具体报错都换不来。
          toast.error(t("skills.tooBig", { file: file.name, limit: MAX_SKILL_BYTES / 1024 }));
          continue;
        }
        let content: string;
        try {
          // `install` 自己把所有网络错误都收了, 但读文件在它外面 —— 不接住的话
          // (`readFiles` 是 `void` 调的) 就是一条没人看得见的 unhandled rejection,
          // 用户那边表现为"拖进去了, 什么都没发生"。
          content = await file.text();
        } catch {
          toast.error(t("skills.readFailed", { file: file.name }));
          continue;
        }
        // 串行而不是 Promise.all: 重名确认框排队逐个弹 (见 `conflicts`), 并行的话
        // 连"哪个文件对应哪个框"都说不清。刷新推迟到循环外。
        installed = (await install(content, { fromComposer: false, refresh: false })) || installed;
      }
      if (installed) await afterChange();
    },
    [install, afterChange, t],
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto bg-dune p-0 sm:max-w-xl">
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle className="text-[15px]">{t("skills.libraryTitle")}</SheetTitle>
          <SheetDescription className="text-[12px]">
            {t("skills.librarySubtitle")}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-3 p-4">
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.markdown,text/markdown"
            multiple
            className="hidden"
            onChange={(e) => {
              void readFiles(e.target.files);
              // 清空, 否则连着传同一个文件两次第二次不触发 change。
              e.target.value = "";
            }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            // 只有真的离开了整个投放区才熄灭。dragleave 在光标从按钮移到它自己的图标 /
            // 文字上时也会触发 (那是子元素的 enter), 不判 relatedTarget 的话高亮会在
            // 用户还悬在上面时一闪一闪。
            onDragLeave={(e) => {
              const next = e.relatedTarget;
              if (next instanceof Node && e.currentTarget.contains(next)) return;
              setDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void readFiles(e.dataTransfer.files);
            }}
            className={cn(
              "flex flex-col items-center gap-1 rounded-md border border-dashed px-3 py-6 transition-colors",
              "disabled:opacity-40",
              dragging
                ? "border-foreground/50 bg-foreground/5 text-foreground"
                : "border-border text-muted-foreground hover:border-foreground/30 hover:bg-foreground/5 hover:text-foreground",
            )}
          >
            <Upload className="size-5" strokeWidth={2} />
            <span className="text-[13px] font-medium">
              {dragging ? t("skills.dropActive") : t("skills.dropTitle")}
            </span>
            <span className="text-[11px]">
              {t("skills.dropHint", { limit: MAX_SKILL_BYTES / 1024 })}
            </span>
          </button>

          {composing === null ? (
            <button
              type="button"
              onClick={() => setComposing("")}
              className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border px-3 py-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-foreground/5 hover:text-foreground"
            >
              <FileText className="size-4" strokeWidth={2} />
              {t("skills.newSkill")}
            </button>
          ) : (
            <div className="rounded-md border border-border p-3">
              <SkillEditor
                value={composing}
                onChange={setComposing}
                rows={12}
                busy={busy}
                placeholder={t("skills.newPlaceholder")}
                onSave={() => {
                  void install(composing, { fromComposer: true }).then((ok) => {
                    if (ok) setComposing(null);
                  });
                }}
                onCancel={() => setComposing(null)}
              />
            </div>
          )}

          {loading && (
            <div className="flex justify-center py-8 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          )}

          {!loading && rows.length === 0 && (
            <p className="px-1 py-6 text-center text-[13px] leading-relaxed text-muted-foreground">
              {t("skills.empty")}
            </p>
          )}

          {rows.map((row) => (
            <SkillCard
              key={row.id}
              row={row}
              busy={busy}
              expanded={expanded === row.id}
              onToggleExpand={() => setExpanded(expanded === row.id ? null : row.id)}
              onSave={(content) =>
                patch(row.id, { content }, t("skills.updated", { name: row.name }))
              }
              onToggleEnabled={() => {
                void patch(
                  row.id,
                  { enabled: !row.enabled },
                  row.enabled
                    ? t("skills.disabledToast", { name: row.name })
                    : t("skills.enabledToast", { name: row.name }),
                );
              }}
              onCopy={() => {
                setComposing(row.content);
                setExpanded(null);
                toast.info(t("skills.copyHint"), { duration: 10000 });
              }}
              onDelete={() => setDeleteTarget(row)}
            />
          ))}
        </div>
      </SheetContent>

      {/* 重名确认。后端已经查过了并回了要覆盖哪一条的 id —— 前端只负责问一句。 */}
      <AlertDialog open={!!conflict} onOpenChange={(next) => { if (!next) shiftConflict(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("skills.overwriteTitle", { name: conflict?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("skills.overwriteBody", { name: conflict?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("sidebar.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!conflict) return;
                const { id, name, content, fromComposer } = conflict;
                // **不在这里出队**: AlertDialogAction 本身就是一个 Close, 点完 Radix
                // 会走上面那个 onOpenChange(false), 队列在那里出队。两处都出队会把
                // 下一条重名连带吞掉 —— 那正是这个队列要修的毛病。
                void patch(id, { content }, t("skills.updated", { name })).then((ok) => {
                  // 只有这篇正文本来就来自编辑器时才清它 —— 拖文件撞的名, 清掉的会是
                  // 用户另外写到一半的草稿。
                  if (ok && fromComposer) setComposing(null);
                });
              }}
            >
              {t("skills.overwrite")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(next) => { if (!next && !busy) setDeleteTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("skills.deleteTitle", { name: deleteTarget?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("skills.deleteBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("sidebar.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                const target = deleteTarget;
                if (!target) return;
                setBusy(true);
                try {
                  await canvasService.skillLibrary.remove(target.id);
                  toast.success(t("skills.removed", { name: target.name }));
                  setDeleteTarget(null);
                  await afterChange();
                } catch (err) {
                  toast.error(extractApiError(err, "delete failed"));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? t("skills.saving") : t("skills.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}

interface SkillCardProps {
  row: CanvasSkillRow;
  busy: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  /** 存这一行的新正文。resolve 成 true = 存住了, 卡片自己把草稿清掉。 */
  onSave: (content: string) => Promise<boolean>;
  onToggleEnabled: () => void;
  onCopy: () => void;
  onDelete: () => void;
}

function SkillCard({
  row, busy, expanded, onToggleExpand, onSave, onToggleEnabled, onCopy, onDelete,
}: SkillCardProps) {
  const { t } = useTranslation("canvasUi");
  const isBuiltin = row.source === "builtin";
  /** 编辑中的正文。**归卡片自己**, 不上提到面板 —— 上提的话"这份草稿属于哪一行"就成了
   *  一条要手工维护的不变量 (父组件得按 id 存、按 id 取、在若干处按 id 清), 而它天然就
   *  是这一行的局部状态。同目录的 ProviderCard / ModelRow 也是这么放的。
   *
   *  卡片挂在 SheetContent (Radix portal, 没 forceMount) 里, 关面板即卸载, 草稿自然丢弃;
   *  折叠只是不渲染下半部分, 卡片还在, 所以收起来再展开草稿还在。 */
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <div className={cn("rounded-md border border-border", !row.enabled && "opacity-60")}>
      <div className="flex items-start gap-2 p-3">
        <button
          type="button"
          onClick={onToggleExpand}
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
        >
          <ChevronDown
            className={cn("mt-0.5 size-4 shrink-0 transition-transform", expanded && "rotate-180")}
            strokeWidth={2}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-[13px] font-medium">{row.name}</span>
              <span className="shrink-0 rounded border border-border px-1.5 py-px text-[10px] text-muted-foreground">
                {isBuiltin ? t("skills.builtin") : t("skills.installed")}
              </span>
              {!row.enabled && (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {t("skills.disabled")}
                </span>
              )}
            </div>
            <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">
              {row.description}
            </p>
          </div>
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onToggleEnabled}
          className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
        >
          {row.enabled ? t("skills.disable") : t("skills.enable")}
        </button>
      </div>

      {expanded && (
        <div className="border-t border-border p-3">
          {draft === null ? (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-2 font-mono text-[11px] leading-relaxed">
              {row.content}
            </pre>
          ) : (
            <SkillEditor
              value={draft}
              onChange={setDraft}
              rows={16}
              busy={busy}
              onSave={() => {
                void onSave(draft).then((ok) => {
                  if (ok) setDraft(null);
                });
              }}
              onCancel={() => setDraft(null)}
            />
          )}

          {/* 编辑中时整排按钮都不出现 —— SkillEditor 自带 保存 / 取消。 */}
          {draft === null && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {isBuiltin ? (
              // 内置的正文是只读的 —— 出厂那份在镜像里, 改坏了没有回退路径。
              // 想改就复制一份成自己的。
              <button
                type="button"
                onClick={onCopy}
                className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12px] text-muted-foreground hover:text-foreground"
              >
                <Copy className="size-3.5" strokeWidth={2} />
                {t("skills.copyAsMine")}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setDraft(row.content)}
                  className="rounded-md border border-border px-3 py-1.5 text-[12px] text-muted-foreground hover:text-foreground"
                >
                  {t("skills.edit")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={onDelete}
                  className="ml-auto flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] text-destructive hover:bg-destructive/10 disabled:opacity-40"
                >
                  <Trash2 className="size-3.5" strokeWidth={2} />
                  {t("skills.delete")}
                </button>
              </>
            )}
          </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 「直接写一个」和卡片的编辑态共用的编辑器: mono 文本域 + 保存 / 取消。
 *
 *  抽出来是因为这两处一模一样 —— 同一串 class、同一条 `busy || 空白` 禁用规则、同一个
 *  「保存中…」文案。抄两份的下场同目录已经写过一次 (canvas-toolbar-styles.ts 的注释):
 *  抄的那份会独自漂移, 变成同一件事的两种长相。 */
function SkillEditor({
  value, onChange, onSave, onCancel, busy, rows, placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
  rows: number;
  placeholder?: string;
}) {
  const { t } = useTranslation("canvasUi");
  return (
    <>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="w-full resize-y rounded-md border border-border bg-background p-2 font-mono text-[11px] outline-none focus:border-foreground/30"
      />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={busy || !value.trim()}
          onClick={onSave}
          className="rounded-md bg-foreground px-3 py-1.5 text-[12px] font-medium text-background disabled:opacity-40"
        >
          {busy ? t("skills.saving") : t("skills.save")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-[12px] text-muted-foreground hover:text-foreground"
        >
          {t("sidebar.cancel")}
        </button>
      </div>
    </>
  );
}
