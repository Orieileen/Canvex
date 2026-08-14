import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  Trash2,
  Wand2,
  Zap,
} from "lucide-react";

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
import { canvasService } from "@/services/canvas.service";
import { extractApiError } from "@/services/errors";
import { cn } from "@/lib/utils";
import type {
  CanvasImageModel,
  CanvasImageProvider,
  CanvasImageProviderKind,
} from "@/types/canvex";

/**
 * 生图供应商配置面板 —— 把「用哪个模型、怎么跟它说话」从后端 env 搬到这里。
 *
 * 两层结构对应后端两张表: 一个供应商(一把 key + 一个 base_url + 一套请求参数默认值),
 * 下面挂若干模型(各自的模型字符串 + 可覆盖任意参数)。两层是必要的 —— 同一把聚合商 key
 * 下面挂豆包和 Google 时, 前者要 size_mode=pixel 而后者不要。
 *
 * 关于那 16 个参数: 它们是 Canvex 适配器的词汇, 不是供应商的词汇 —— 文档会写
 * 「image 传 URL 数组」, 不会告诉你 image_as_single 该开还是关。所以这里不做内置预设
 * (维护负担且永远追不上), 而是:
 *   1. 「从 curl 导入」—— 粘供应商文档里的示例, 从请求体形状把这几个字段推出来
 *   2. 每个字段带一句从实战里长出来的提示(见 image_client.py 的字段注释)
 *   3. 「测试」按钮真发一次最小生成, 把供应商的原始错误原样显示
 * 第 3 条尤其重要: 没有预设之后, 它是用户唯一的反馈回路。
 */

/** 一个可调参数的描述。`kind` 决定渲染成什么控件。 */
interface Tunable {
  key: string;
  kind: "text" | "bool" | "number";
  /** bool 的空选项文案键; 省略即 "unset"。watermark 用 "dontSend"。 */
  emptyKey?: "unset" | "dontSend";
  placeholder?: string;
}

// 顺序 = 表单里的顺序: 先是最常需要改的请求形状, 再是异步轮询。
const TUNABLES: Tunable[] = [
  { key: "image_field", kind: "text", placeholder: "image" },
  { key: "image_as_single", kind: "bool" },
  { key: "response_format", kind: "text", placeholder: "b64_json" },
  { key: "quality", kind: "text" },
  { key: "watermark", kind: "bool", emptyKey: "dontSend" },
  { key: "inline_image", kind: "bool" },
  { key: "size_mode", kind: "text", placeholder: "pixel" },
  { key: "timeout", kind: "number", placeholder: "300" },
  { key: "poll_enabled", kind: "bool" },
  { key: "poll_url", kind: "text" },
  { key: "poll_max_attempts", kind: "number", placeholder: "60" },
  { key: "poll_interval", kind: "number", placeholder: "5" },
  { key: "poll_timeout", kind: "number", placeholder: "30" },
];

// Angle 通道能调的只有超时 —— 它的"参数"是相机坐标, 由画布上那个立方体在控, 不是这里
// 填的东西。把另外 12 项摆给用户看只会让人以为填了会生效。
const ANGLE_TUNABLE_KEYS = new Set(["timeout"]);

const tunablesFor = (kind: CanvasImageProviderKind): Tunable[] =>
  kind === "angle" ? TUNABLES.filter((f) => ANGLE_TUNABLE_KEYS.has(f.key)) : TUNABLES;

type Values = Record<string, unknown>;

const inputCls =
  "w-full rounded-md border border-border bg-background px-2 py-1 text-[12px] outline-none focus:border-foreground/30";

/** 空草稿 —— 「新建供应商」和 curl 导入都从它开始。 */
const emptyProvider = (): CanvasImageProvider => ({
  id: "",
  label: "",
  kind: "image",
  base_url: "",
  api_key: "",
  defaults: {},
  models: [],
  created_at: "",
  updated_at: "",
});

/** 只取会被 PUT 上去的部分。既是请求体, 也是"改过没有"的比较基准。
 *
 *  不能拿 updated_at 比: draft 是 saved 的深拷贝, 本地怎么改它都一模一样, 那样的
 *  「有未保存的改动」提示永远不会亮。 */
const providerPayload = (p: CanvasImageProvider) => ({
  label: p.label,
  kind: p.kind,
  base_url: p.base_url,
  api_key: p.api_key,
  defaults: p.defaults,
  models: p.models.map((m) => ({
    // 本地新建的模型行没有后端 id, 不要把假 id 发过去
    ...(m.id.startsWith("new-") ? {} : { id: m.id }),
    label: m.label,
    model: m.model,
    overrides: m.overrides,
    enabled: m.enabled,
    sort_order: m.sort_order,
  })),
});

const isDirty = (draft: CanvasImageProvider, saved: CanvasImageProvider) =>
  JSON.stringify(providerPayload(draft)) !== JSON.stringify(providerPayload(saved));

interface ImageProviderSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 配置变了(增删改) → 让工具栏选择器重新拉列表。 */
  onChanged: () => void;
}

export function ImageProviderSettings({
  open,
  onOpenChange,
  onChanged,
}: ImageProviderSettingsProps) {
  const { t } = useTranslation("canvasUi");
  const [providers, setProviders] = useState<CanvasImageProvider[]>([]);
  const [loading, setLoading] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, CanvasImageProvider>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await canvasService.listImageProviders();
      setProviders(data);
      // 不能直接整个换掉 —— 保存 A 会 reload, 而 B 可能才填了一半 (甚至是一整张还没
      // 保存的新卡片), 整个换掉等于把用户刚敲的东西悄悄扔了。所以: 本地新建的留着,
      // 改过还没保存的留着, 其余用服务端版本(拿到真实 id / updated_at)。
      setDrafts((prev) => {
        const next: Record<string, CanvasImageProvider> = {};
        for (const [id, draft] of Object.entries(prev)) {
          if (id.startsWith("new-")) next[id] = draft;
        }
        for (const p of data) {
          const local = prev[p.id];
          next[p.id] = local && isDirty(local, p) ? local : structuredClone(p);
        }
        return next;
      });
    } catch (err) {
      toast.error(extractApiError(err, "load providers failed"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  const patchDraft = (id: string, patch: Partial<CanvasImageProvider>) =>
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const addDraft = (seed?: Partial<CanvasImageProvider>) => {
    // 本地临时 id: 后端还没有这条记录, 保存时走 create。
    const id = `new-${Date.now()}`;
    setDrafts((prev) => ({ ...prev, [id]: { ...emptyProvider(), ...seed, id } }));
    setExpanded(id);
  };

  const save = async (id: string) => {
    const draft = drafts[id];
    if (!draft.label.trim() || !draft.base_url.trim()) {
      toast.error(t("imageProviders.needLabelAndUrl"));
      return;
    }
    try {
      const body = providerPayload(draft);
      if (id.startsWith("new-")) {
        await canvasService.createImageProvider(body);
        // 这条草稿已经落库, reload 会带回它的真身 —— 临时行留着会变成两张一样的卡片
        setDrafts((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      } else {
        await canvasService.updateImageProvider(id, body);
      }
      toast.success(t("imageProviders.saved"));
      await reload();
      onChanged();
    } catch (err) {
      toast.error(extractApiError(err, "save provider failed"));
    }
  };

  const remove = async (id: string) => {
    if (id.startsWith("new-")) {
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    // 删供应商会连它下面所有模型一起删掉, 历史任务的关联也被 SET_NULL —— 不可撤销,
    // 而这个按钮就在展开箭头旁边。用 AlertDialog 而不是 window.confirm: 后者不认主题、
    // 显示不了处理中状态, 而且浏览器的"阻止此页面再创建对话框"会让它直接返回 false ——
    // 那种情况下删除就**静默执行**了。侧栏删画布用的也是这个组件。
    setDeleteTarget(id);
  };

  const confirmDelete = async () => {
    const id = deleteTarget;
    if (!id) return;
    setDeleting(true);
    try {
      await canvasService.deleteImageProvider(id);
      toast.success(t("imageProviders.deleted"));
      await reload();
      onChanged();
      setDeleteTarget(null);
    } catch (err) {
      toast.error(extractApiError(err, "delete provider failed"));
    } finally {
      setDeleting(false);
    }
  };

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const ids = Object.keys(drafts).sort((a, b) =>
    a.startsWith("new-") === b.startsWith("new-") ? 0 : a.startsWith("new-") ? 1 : -1,
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto bg-dune p-0 sm:max-w-xl">
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle className="text-[15px]">{t("imageProviders.title")}</SheetTitle>
          <SheetDescription className="text-[12px]">
            {t("imageProviders.subtitle")}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-3 p-4">
          <CurlImport onImported={(seed) => addDraft(seed)} />

          {loading && (
            <div className="flex justify-center py-8 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          )}

          {!loading && ids.length === 0 && (
            <p className="px-1 py-6 text-center text-[13px] leading-relaxed text-muted-foreground">
              {t("imageProviders.empty")}
            </p>
          )}

          {ids.map((id) => (
            <ProviderCard
              key={id}
              draft={drafts[id]}
              saved={providers.find((p) => p.id === id)}
              expanded={expanded === id}
              onToggle={() => setExpanded(expanded === id ? null : id)}
              onPatch={(patch) => patchDraft(id, patch)}
              onSave={() => void save(id)}
              onDelete={() => void remove(id)}
            />
          ))}

          <button
            type="button"
            onClick={() => addDraft()}
            className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border px-3 py-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-foreground/5 hover:text-foreground"
          >
            <Plus className="size-4" strokeWidth={2} />
            {t("imageProviders.add")}
          </button>
        </div>
      </SheetContent>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(next) => {
          if (!next && !deleting) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("imageProviders.confirmDeleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("imageProviders.confirmDelete")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t("sidebar.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
            >
              {t("imageProviders.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}

/** 「从 curl 导入」—— 替代内置预设的那块。 */
function CurlImport({ onImported }: { onImported: (seed: Partial<CanvasImageProvider>) => void }) {
  const { t } = useTranslation("canvasUi");
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const { data } = await canvasService.importImageProviderCurl(text);
      const { base_url, api_key, model, _unrecognized, ...tunables } = data;
      onImported({
        base_url: base_url ?? "",
        api_key: api_key ?? "",
        defaults: tunables as Values,
        models: model
          ? [{
              id: `new-${Date.now()}`, label: model, model,
              overrides: {}, enabled: true, sort_order: 0,
            }]
          : [],
      });
      // 示例里出现但我们不认识的键要说出来, 否则用户以为已经完整导入了
      if (_unrecognized?.length) {
        toast.warning(t("imageProviders.curlUnknown", { keys: _unrecognized.join(", ") }));
      } else {
        toast.success(t("imageProviders.curlOk"));
      }
      setOpen(false);
      setText("");
    } catch (err) {
      toast.error(extractApiError(err, "curl import failed"));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border px-3 py-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-foreground/5 hover:text-foreground"
      >
        <Wand2 className="size-4" strokeWidth={2} />
        {t("imageProviders.curlImport")}
      </button>
    );
  }

  return (
    <div className="rounded-md border border-border p-3">
      <p className="mb-2 text-[12px] leading-relaxed text-muted-foreground">
        {t("imageProviders.curlHint")}
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder={"curl https://api.example.com/v1/images/generations \\\n  -H 'Authorization: Bearer …' \\\n  -d '{\"model\":\"…\",\"image\":\"…\"}'"}
        className="w-full resize-y rounded-md border border-border bg-background p-2 font-mono text-[11px] outline-none focus:border-foreground/30"
      />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={busy || !text.trim()}
          onClick={() => void run()}
          className="rounded-md bg-foreground px-3 py-1.5 text-[12px] font-medium text-background disabled:opacity-40"
        >
          {busy ? t("imageProviders.parsing") : t("imageProviders.parse")}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md px-3 py-1.5 text-[12px] text-muted-foreground hover:text-foreground"
        >
          {t("sidebar.cancel")}
        </button>
      </div>
    </div>
  );
}

function ProviderCard({
  draft,
  saved,
  expanded,
  onToggle,
  onPatch,
  onSave,
  onDelete,
}: {
  draft: CanvasImageProvider;
  saved?: CanvasImageProvider;
  expanded: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<CanvasImageProvider>) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("canvasUi");
  const [testing, setTesting] = useState("");
  const isNew = draft.id.startsWith("new-");

  const test = async (model: CanvasImageModel) => {
    // 供应商没保存、或这一行模型还没保存, 后端都拿不到可查的记录 —— 模型行的本地临时
    // id ("new-1723…") 不是 UUID, 发过去只会换来一个 500。
    if (isNew || model.id.startsWith("new-")) {
      toast.info(t("imageProviders.saveBeforeTest"));
      return;
    }
    setTesting(model.id);
    try {
      const { data } = await canvasService.testImageProvider(draft.id, model.id);
      if (data.ok) toast.success(t("imageProviders.testOk", { s: data.elapsed }));
      // 原始错误直接显示 —— 用户拿着它对着供应商文档就能改。这是没有预设之后
      // 唯一的反馈回路, 所以不做美化、不截断成"请求失败"。
      else toast.error(data.error || t("imageProviders.testFailed"), { duration: 15000 });
    } catch (err) {
      toast.error(extractApiError(err, "test failed"));
    } finally {
      setTesting("");
    }
  };

  const patchModel = (idx: number, patch: Partial<CanvasImageModel>) =>
    onPatch({ models: draft.models.map((m, i) => (i === idx ? { ...m, ...patch } : m)) });

  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button type="button" onClick={onToggle} className="text-muted-foreground">
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
        <input
          value={draft.label}
          onChange={(e) => onPatch({ label: e.target.value })}
          placeholder={t("imageProviders.labelPlaceholder")}
          className="min-w-0 flex-1 bg-transparent text-[13px] font-medium outline-none"
        />
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {t("imageProviders.modelCount", { n: draft.models.length })}
        </span>
        <button
          type="button"
          onClick={onDelete}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          aria-label={t("imageProviders.delete")}
        >
          <Trash2 className="size-3.5" strokeWidth={2} />
        </button>
      </div>

      {expanded && (
        <div className="flex flex-col gap-3 border-t border-border p-3">
          {/* kind 放在最前面: 它决定下面显示哪些字段, 以及这条通道会出现在哪个选择器里。 */}
          <Field label={t("imageProviders.kind")} hint={t(`imageProviders.kindHint.${draft.kind}`)}>
            <select
              value={draft.kind}
              onChange={(e) => onPatch({ kind: e.target.value as CanvasImageProviderKind })}
              className={inputCls}
            >
              <option value="image">{t("imageProviders.kindImage")}</option>
              <option value="angle">{t("imageProviders.kindAngle")}</option>
            </select>
          </Field>
          <Field
            label={t("imageProviders.baseUrl")}
            hint={t(`imageProviders.baseUrlHint.${draft.kind}`)}
          >
            <input
              value={draft.base_url}
              onChange={(e) => onPatch({ base_url: e.target.value })}
              placeholder={draft.kind === "angle" ? "https://fal.run" : "https://api.example.com/v1"}
              className={inputCls}
            />
          </Field>
          <Field label={t("imageProviders.apiKey")} hint={t("imageProviders.apiKeyHint")}>
            <input
              value={draft.api_key}
              onChange={(e) => onPatch({ api_key: e.target.value })}
              placeholder="sk-…"
              className={cn(inputCls, "font-mono")}
            />
          </Field>

          {/* 模型行 */}
          <div>
            <div className="mb-1 text-[12px] font-medium">{t("imageProviders.models")}</div>
            <div className="flex flex-col gap-2">
              {draft.models.map((m, i) => (
                <ModelRow
                  key={m.id || i}
                  model={m}
                  kind={draft.kind}
                  testing={testing === m.id}
                  onPatch={(patch) => patchModel(i, patch)}
                  onTest={() => void test(m)}
                  onDelete={() =>
                    onPatch({ models: draft.models.filter((_, idx) => idx !== i) })
                  }
                />
              ))}
              <button
                type="button"
                onClick={() =>
                  onPatch({
                    models: [
                      ...draft.models,
                      {
                        id: `new-${Date.now()}`, label: "", model: "",
                        overrides: {}, enabled: true, sort_order: draft.models.length,
                      },
                    ],
                  })
                }
                className="rounded-md border border-dashed border-border px-2 py-1.5 text-[12px] text-muted-foreground hover:border-foreground/30 hover:text-foreground"
              >
                ＋ {t("imageProviders.addModel")}
              </button>
            </div>
          </div>

          <TunableEditor
            title={t("imageProviders.defaults")}
            hint={t("imageProviders.defaultsHint")}
            kind={draft.kind}
            values={draft.defaults}
            onChange={(defaults) => onPatch({ defaults })}
          />

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onSave}
              className="rounded-md bg-foreground px-3 py-1.5 text-[12px] font-medium text-background"
            >
              {t("imageProviders.save")}
            </button>
            {saved && isDirty(draft, saved) && (
              <span className="text-[11px] text-muted-foreground">
                {t("imageProviders.unsaved")}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ModelRow({
  model,
  kind,
  testing,
  onPatch,
  onTest,
  onDelete,
}: {
  model: CanvasImageModel;
  kind: CanvasImageProviderKind;
  testing: boolean;
  onPatch: (patch: Partial<CanvasImageModel>) => void;
  onTest: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("canvasUi");
  const [showOverrides, setShowOverrides] = useState(false);

  return (
    <div className="rounded-md border border-border/70 p-2">
      <div className="flex items-center gap-2">
        <input
          value={model.label}
          onChange={(e) => onPatch({ label: e.target.value })}
          placeholder={t("imageProviders.modelLabelPlaceholder")}
          className={cn(inputCls, "flex-1")}
        />
        <input
          value={model.model}
          onChange={(e) => onPatch({ model: e.target.value })}
          placeholder={t("imageProviders.modelStringPlaceholder")}
          className={cn(inputCls, "flex-1 font-mono")}
        />
        <button
          type="button"
          onClick={onTest}
          disabled={testing}
          title={t("imageProviders.testHint")}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:opacity-40"
        >
          {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" strokeWidth={2} />}
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="size-3.5" strokeWidth={2} />
        </button>
      </div>
      <button
        type="button"
        onClick={() => setShowOverrides(!showOverrides)}
        className="mt-1 text-[11px] text-muted-foreground hover:text-foreground"
      >
        {showOverrides ? "▾" : "▸"} {t("imageProviders.overrides")}
        {Object.keys(model.overrides || {}).length > 0 &&
          ` (${Object.keys(model.overrides).length})`}
      </button>
      {showOverrides && (
        <TunableEditor
          hint={t("imageProviders.overridesHint")}
          kind={kind}
          values={model.overrides}
          onChange={(overrides) => onPatch({ overrides })}
        />
      )}
    </div>
  );
}

/** 可调参数的编辑器。provider 默认值和 model 覆盖项共用, 字段按 provider 的 kind 裁剪。
 *  只把**明确设过**的键写进 values —— 空 = 继承上一层 / 用后端默认。 */
function TunableEditor({
  title,
  hint,
  kind,
  values,
  onChange,
}: {
  title?: string;
  hint?: string;
  kind: CanvasImageProviderKind;
  values: Values;
  onChange: (v: Values) => void;
}) {
  const { t } = useTranslation("canvasUi");
  const set = (key: string, v: unknown) => {
    const next = { ...values };
    if (v === "" || v === undefined) delete next[key];
    else next[key] = v;
    onChange(next);
  };

  return (
    <div className="rounded-md bg-foreground/5 p-2">
      {title && <div className="mb-1 text-[12px] font-medium">{title}</div>}
      {hint && <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
      <div className="flex flex-col gap-2">
        {tunablesFor(kind).map((f) => {
          // 三种控件都用同一份显示值: undefined (没配这项) → 空串, 其余原样转字符串。
          const shown = values[f.key] === undefined ? "" : String(values[f.key]);
          return (
          <div key={f.key} className="flex items-start gap-2">
            <div className="w-[124px] shrink-0 pt-1">
              <div className="font-mono text-[11px] text-foreground">{f.key}</div>
              <div className="text-[10px] leading-tight text-muted-foreground">
                {t(`imageProviders.field.${f.key}`)}
              </div>
            </div>
            <div className="min-w-0 flex-1">
              {f.kind === "bool" && (
                <select
                  value={shown}
                  onChange={(e) => set(f.key, e.target.value === "" ? "" : e.target.value === "true")}
                  className={inputCls}
                >
                  {/* 空选项的语义按字段而定: 多数旋钮"不填"=用我们的默认, 而 watermark
                      不填是**不下发这个字段**、由供应商自己决定。 */}
                  <option value="">{t(`imageProviders.${f.emptyKey ?? "unset"}`)}</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              )}
              {f.kind === "number" && (
                <input
                  type="number"
                  value={shown}
                  placeholder={f.placeholder}
                  onChange={(e) => set(f.key, e.target.value === "" ? "" : Number(e.target.value))}
                  className={inputCls}
                />
              )}
              {f.kind === "text" && (
                <input
                  value={shown}
                  placeholder={f.placeholder}
                  onChange={(e) => set(f.key, e.target.value)}
                  className={inputCls}
                />
              )}
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 text-[12px] font-medium">{label}</div>
      {children}
      {hint && <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}
