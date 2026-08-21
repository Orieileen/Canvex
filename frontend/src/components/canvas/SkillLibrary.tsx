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
}

export function SkillLibrary({ open, onOpenChange, onChanged }: SkillLibraryProps) {
  const { t } = useTranslation("canvasUi");
  const [rows, setRows] = useState<CanvasSkillRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  /** 正在编辑的那一行的正文。null = 只是展开查看, 没在改。 */
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  /** 「直接写一个」/「复制为我的」共用的新建编辑器。null = 没打开。 */
  const [composing, setComposing] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
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
    if (open) void reload();
  }, [open, reload]);

  /** 每一次改动之后都要做的两件事: 重拉自己的列表, 通知 popover 重拉 agent 视角的。
   *  漏掉后者的表现是"面板里删掉了, popover 里还在", 而两者就挨着。 */
  const afterChange = useCallback(async () => {
    await reload();
    onChanged();
  }, [reload, onChanged]);

  /** 装一篇。重名时后端回 400 + conflict_id, 我们把它变成一句「要覆盖吗」而不是报错 ——
   *  重装/更新自己的 SOP 是最高频的操作, 让用户先去删一遍太蠢。 */
  const install = useCallback(
    async (content: string): Promise<boolean> => {
      setBusy(true);
      try {
        const { data } = await canvasService.skillLibrary.create({ content });
        toast.success(t("skills.installed_toast", { name: data.name }));
        await afterChange();
        return true;
      } catch (err) {
        const { fields, summary } = parseApiErrors(err, "install failed");
        if (fields.conflict_id && fields.conflict_name) {
          setConflict({ id: fields.conflict_id, name: fields.conflict_name, content });
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
      for (const file of Array.from(files)) {
        if (!/\.(md|markdown)$/i.test(file.name)) {
          toast.error(t("skills.notMarkdown", { file: file.name }));
          continue;
        }
        // 串行而不是 Promise.all: 装第二篇时可能弹重名确认框, 并行的话几个确认框会
        // 互相覆盖, 用户只看得见最后一个。
        await install(await file.text());
      }
    },
    [install, t],
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
            onDragLeave={() => setDragging(false)}
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
            <span className="text-[11px]">{t("skills.dropHint")}</span>
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
              <textarea
                value={composing}
                onChange={(e) => setComposing(e.target.value)}
                rows={12}
                placeholder={t("skills.newPlaceholder")}
                className="w-full resize-y rounded-md border border-border bg-background p-2 font-mono text-[11px] outline-none focus:border-foreground/30"
              />
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={busy || !composing.trim()}
                  onClick={() => {
                    void install(composing).then((ok) => {
                      if (ok) setComposing(null);
                    });
                  }}
                  className="rounded-md bg-foreground px-3 py-1.5 text-[12px] font-medium text-background disabled:opacity-40"
                >
                  {busy ? t("skills.saving") : t("skills.save")}
                </button>
                <button
                  type="button"
                  onClick={() => setComposing(null)}
                  className="rounded-md px-3 py-1.5 text-[12px] text-muted-foreground hover:text-foreground"
                >
                  {t("skills.cancel")}
                </button>
              </div>
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
              editing={editing?.id === row.id ? editing.content : null}
              onToggleExpand={() => {
                setExpanded(expanded === row.id ? null : row.id);
                setEditing(null);
              }}
              onStartEdit={() => setEditing({ id: row.id, content: row.content })}
              onEditChange={(content) => setEditing({ id: row.id, content })}
              onCancelEdit={() => setEditing(null)}
              onSaveEdit={(content) => {
                void patch(row.id, { content }, t("skills.updated", { name: row.name })).then(
                  (ok) => {
                    if (ok) setEditing(null);
                  },
                );
              }}
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
      <AlertDialog open={!!conflict} onOpenChange={(next) => { if (!next) setConflict(null); }}>
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
            <AlertDialogCancel>{t("skills.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!conflict) return;
                const { id, name, content } = conflict;
                setConflict(null);
                void patch(id, { content }, t("skills.updated", { name })).then((ok) => {
                  if (ok) setComposing(null);
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
            <AlertDialogCancel disabled={busy}>{t("skills.cancel")}</AlertDialogCancel>
            <AlertDialogAction
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
  /** 非 null = 这一行正在编辑, 值是编辑器里的正文。 */
  editing: string | null;
  onToggleExpand: () => void;
  onStartEdit: () => void;
  onEditChange: (content: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (content: string) => void;
  onToggleEnabled: () => void;
  onCopy: () => void;
  onDelete: () => void;
}

function SkillCard({
  row, busy, expanded, editing,
  onToggleExpand, onStartEdit, onEditChange, onCancelEdit, onSaveEdit,
  onToggleEnabled, onCopy, onDelete,
}: SkillCardProps) {
  const { t } = useTranslation("canvasUi");
  const isBuiltin = row.source === "builtin";

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
          {editing === null ? (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-2 font-mono text-[11px] leading-relaxed">
              {row.content}
            </pre>
          ) : (
            <textarea
              value={editing}
              onChange={(e) => onEditChange(e.target.value)}
              rows={16}
              className="w-full resize-y rounded-md border border-border bg-background p-2 font-mono text-[11px] outline-none focus:border-foreground/30"
            />
          )}

          <div className="mt-2 flex flex-wrap items-center gap-2">
            {editing !== null ? (
              <>
                <button
                  type="button"
                  disabled={busy || !editing.trim()}
                  onClick={() => onSaveEdit(editing)}
                  className="rounded-md bg-foreground px-3 py-1.5 text-[12px] font-medium text-background disabled:opacity-40"
                >
                  {busy ? t("skills.saving") : t("skills.save")}
                </button>
                <button
                  type="button"
                  onClick={onCancelEdit}
                  className="rounded-md px-3 py-1.5 text-[12px] text-muted-foreground hover:text-foreground"
                >
                  {t("skills.cancel")}
                </button>
              </>
            ) : isBuiltin ? (
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
                  onClick={onStartEdit}
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
        </div>
      )}
    </div>
  );
}
