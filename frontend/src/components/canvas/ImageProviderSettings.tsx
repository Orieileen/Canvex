import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
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
  CanvasKindSpec,
  CanvasTunableSpec,
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

// 可调参数那张表**由后端下发** (GET /image-providers/schema/, 从 ImageChannel 的字段声明
// 派生)。这里曾经手抄过一份 13 项的清单 + 一个"angle 只能调 timeout"的集合 —— 而后端
// image_channels.py 顶上的注释警告的正是"手抄的那份会悄悄落后, 表现是在界面上配了却不
// 生效, 而且没有任何报错"。现在加一个旋钮只需在 ImageChannel 上加一行, 再补两条翻译。

type Values = Record<string, unknown>;

/** kind → 界面上的展示名。徽标和新建时的下拉共用, 免得两处各拼一次 i18n key。 */
const kindLabel = (t: TFunction, kind: string) =>
  t(`imageProviders.kind${kind[0].toUpperCase()}${kind.slice(1)}`);

const inputCls =
  "w-full rounded-md border border-border bg-background px-2 py-1 text-[12px] outline-none focus:border-foreground/30";

/** 本地临时 id —— 后端还没有这条记录。
 *
 *  **必须以 `new-` 开头**: save / remove / reload / providerPayload 全靠这个前缀判断
 *  "该 create 还是 update"、"这行模型的 id 能不能发给后端"。
 *
 *  后面缀一个自增序号而不是只用 `Date.now()`: 连点两次「新建」(或 curl 导入紧接着新建)
 *  会落在同一毫秒, 两张卡片拿到同一个 key —— 后一张直接把前一张从 drafts 里覆盖掉,
 *  用户刚填的东西无声消失。 */
let localIdSeq = 0;
const newLocalId = () => `new-${Date.now()}-${localIdSeq++}`;

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

/** JSON.stringify 但对象键按名字排序 —— 比较两份配置时必须用这个。
 *
 *  `defaults` / `overrides` 是自由 JSON, 存的是 Postgres jsonb, **不保留键顺序**
 *  (jsonb 按键长度+字典序重排)。拿原生 stringify 比, 本地按输入顺序、服务端按 jsonb
 *  顺序, 同一份配置也会被判成"改过了" —— 于是「有未保存的改动」永远亮着, 而 reload
 *  会永久把这张卡片钉在本地副本上, 别处的改动再也刷不进来。 */
const stableStringify = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
};

const isDirty = (draft: CanvasImageProvider, saved: CanvasImageProvider) =>
  stableStringify(providerPayload(draft)) !== stableStringify(providerPayload(saved));

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
  // 表单的字段表由后端下发。跟 providers 分开拉: 它跟用户配了什么无关, 只随后端版本变,
  // 保存/删除后不需要重拉。拉不到就给空数组 —— 那样参数区是空的, 但名称 / Base URL /
  // key / 模型这些正经字段照常能填能存。
  const [tunables, setTunables] = useState<Record<string, CanvasKindSpec>>({});
  const kinds = Object.keys(tunables);

  /** `discardDraft` = 刚保存成功的那张卡片的草稿 id, 用服务端版本无条件顶掉它。
   *
   *  丢弃必须发生在**这一次 setDrafts 里**, 不能在保存后先单独 delete 一次: 那样卡片
   *  会在整个 reload 请求期间从列表里消失 (ProviderCard 被卸载 → 展开着的 overrides
   *  面板全部收起), reload 万一失败还会一直消失到重新打开面板。 */
  const reload = useCallback(async (discardDraft?: string) => {
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
          if (id.startsWith("new-") && id !== discardDraft) next[id] = draft;
        }
        for (const p of data) {
          const local = p.id === discardDraft ? undefined : prev[p.id];
          next[p.id] = local && isDirty(local, p) ? local : structuredClone(p);
        }
        return next;
      });
    } catch (err) {
      // 列表没拉回来, 但 discardDraft 那条**确实已经存进库了** —— 草稿还留着的话, 下
      // 一次 reload 成功时本地临时卡片和服务端那张会并排出现两份。所以这里也得丢。
      if (discardDraft) {
        setDrafts((prev) => {
          const next = { ...prev };
          delete next[discardDraft];
          return next;
        });
      }
      toast.error(extractApiError(err, "load providers failed"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void reload();
    if (Object.keys(tunables).length === 0) {
      canvasService
        .getImageProviderSchema()
        .then(({ data }) => setTunables(data.tunables))
        .catch(() => setTunables({}));
    }
    // tunables 刻意不进依赖: 它只在还没拿到时拉一次, 进依赖会在 setTunables 后再触发一轮。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reload]);

  const patchDraft = (id: string, patch: Partial<CanvasImageProvider>) =>
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const addDraft = (seed?: Partial<CanvasImageProvider>) => {
    // 本地临时 id: 后端还没有这条记录, 保存时走 create。
    const id = newLocalId();
    setDrafts((prev) => ({ ...prev, [id]: { ...emptyProvider(), ...seed, id } }));
    setExpanded(id);
  };

  const save = async (id: string) => {
    const draft = drafts[id];
    // "这种通道要不要 base_url" 由后端下发 (chat 留空 = 走 OpenAI 官方端点)。不在这里
    // 自己判 —— 那等于把后端规则抄一份, 而且抄的那份会**抢先**生效: 后端哪天把某个 kind
    // 改成可空, 这里的 toast 会在请求发出去之前就拦下来。schema 没拉到时放行, 让后端拒。
    const needsUrl = tunables[draft.kind]?.requires_base_url ?? false;
    if (!draft.label.trim() || (needsUrl && !draft.base_url.trim())) {
      toast.error(t(needsUrl ? "imageProviders.needLabelAndUrl" : "imageProviders.needLabel"));
      return;
    }
    try {
      const body = providerPayload(draft);
      if (id.startsWith("new-")) await canvasService.createImageProvider(body);
      else await canvasService.updateImageProvider(id, body);
      toast.success(t("imageProviders.saved"));
      // 保存成功后**一定**丢掉这份草稿, 更新和新建都一样 —— 刚存过, 没有未保存的东西
      // 可保。留着它的话 reload 里 `isDirty(local, p)` 会判真 (草稿里刚加的模型行不带
      // id, 服务端返回的那行带真 id, 两边永远比不相等), 于是卡片一直显示本地那份:
      // 模型行卡在临时 id 上("请先保存再测试"), 而每次再保存都会把它删掉重建换一个新
      // UUID —— 正是 ImageModelSerializer 显式声明可写 id 要避免的那种翻搅 (历史任务
      // 的 image_model 被 SET_NULL, 前端粘性选择变成死 id)。
      // 交给 reload 在换上服务端版本的那一次 setDrafts 里丢, 卡片就不会中途消失。
      await reload(id);
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
              tunables={tunables}
              kinds={kinds}
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
              id: newLocalId(), label: model, model,
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
  tunables,
  kinds,
}: {
  draft: CanvasImageProvider;
  saved?: CanvasImageProvider;
  expanded: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<CanvasImageProvider>) => void;
  onSave: () => void;
  onDelete: () => void;
  /** 后端下发的按 kind 分组的表单规则。 */
  tunables: Record<string, CanvasKindSpec>;
  /** 可选的通道类型 = schema 的键。 */
  kinds: string[];
}) {
  const { t } = useTranslation("canvasUi");
  const [testing, setTesting] = useState("");
  const isNew = draft.id.startsWith("new-");
  // 这种通道的全部表单规则, 由后端下发。切换 kind 时旋钮列表、占位符、base_url 示例、
  // 能不能一键测**同时**跟着换 —— 后端保存时按的是同一份 KIND_SPECS, 所以界面和真实
  // 行为不会各说一套。
  const spec = tunables[draft.kind];
  const specs = spec?.tunables ?? [];

  const test = async (model: CanvasImageModel) => {
    // 供应商没保存、或这一行模型还没保存, 后端都拿不到可查的记录 —— 模型行的本地临时
    // id ("new-1723…") 不是 UUID, 发过去只会换来一个 500。
    //
    // 卡片上有未保存的改动时同样拦下: 测试打的是**库里那份**配置。改完 key 直接点 ⚡
    // 会拿到一个针对旧值的通过/失败, 而这个按钮存在的全部意义就是告诉用户"你刚填的这
    // 份对不对" —— 给错答案比不给更糟。
    if (isNew || model.id.startsWith("new-") || (saved && isDirty(draft, saved))) {
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
        {/* 折叠态也看得见 —— 以前要逐个展开才知道哪条是生图、哪条是聊天。
            存过的卡片下面不再重复一个禁用的下拉, 这里就是通道类型的唯一显示处。 */}
        <span className="shrink-0 rounded bg-foreground/5 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {kindLabel(t, draft.kind)}
        </span>
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
          {/* 只有新建时才是一个真实的选择。存过之后它就不是设置了 —— 是"这个端点说哪种
              协议", 改它等于换一个东西 (后端也会拒), 所以这里不留一个点不动的下拉当摆设,
              类型改由头部那个徽标显示。 */}
          {isNew && (
            <Field label={t("imageProviders.kind")} hint={t(`imageProviders.kindHint.${draft.kind}`)}>
              <select
                value={draft.kind}
                onChange={(e) => onPatch({ kind: e.target.value as CanvasImageProviderKind })}
                className={inputCls}
              >
                {/* kind 列表 = schema payload 的键。加第五种通道时后端加一行, 这里自动
                    多一项 (只需补一条 i18n 文案)。 */}
                {kinds.map((k) => (
                  <option key={k} value={k}>{kindLabel(t, k)}</option>
                ))}
              </select>
            </Field>
          )}
          <Field
            label={t("imageProviders.baseUrl")}
            hint={t(`imageProviders.baseUrlHint.${draft.kind}`)}
          >
            <input
              value={draft.base_url}
              onChange={(e) => onPatch({ base_url: e.target.value })}
              placeholder={spec?.base_url_example ?? ""}
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
                  specs={specs}
                  canTest={spec?.testable ?? false}
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
                        id: newLocalId(), label: "", model: "",
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
            specs={specs}
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
  specs,
  canTest,
  testing,
  onPatch,
  onTest,
  onDelete,
}: {
  model: CanvasImageModel;
  /** 已按 provider 的 kind 过滤好的旋钮表。 */
  specs: CanvasTunableSpec[];
  /** 能不能一键测。只有 image / angle 行: video 一次生成是分钟级的撑不过同步请求;
   *  chat 的探针要验的是"支不支持 tools", 跟发一张图不是一回事, 还没写。 */
  canTest: boolean;
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
        {canTest && (
          <button
            type="button"
            onClick={onTest}
            disabled={testing}
            title={t("imageProviders.testHint")}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:opacity-40"
          >
            {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" strokeWidth={2} />}
          </button>
        )}
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
          specs={specs}
          values={model.overrides}
          onChange={(overrides) => onPatch({ overrides })}
        />
      )}
    </div>
  );
}

/** 可调参数的编辑器。provider 默认值和 model 覆盖项共用, 字段按 provider 的 kind 裁剪。
 *  只把**明确设过**的键写进 values —— 空 = 继承上一层 / 用 ImageChannel 的字段默认值。
 *
 *  `specs` 是后端下发的那张表, 已按 kind 过滤好。 */
function TunableEditor({
  title,
  hint,
  specs,
  values,
  onChange,
}: {
  title?: string;
  hint?: string;
  specs: CanvasTunableSpec[];
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
        {specs.map((f) => {
          // 三种控件都用同一份显示值: undefined (没配这项) → 空串, 其余原样转字符串。
          const shown = values[f.key] === undefined ? "" : String(values[f.key]);
          return (
          <div key={f.key} className="flex items-start gap-2">
            <div className="w-[124px] shrink-0 pt-1">
              <div className="font-mono text-[11px] text-foreground">{f.key}</div>
              <div className="text-[10px] leading-tight text-muted-foreground">
                {t(`imageProviders.field.${f.key}`, f.key)}
              </div>
            </div>
            <div className="min-w-0 flex-1">
              {f.control === "bool" && (
                <select
                  value={shown}
                  onChange={(e) => set(f.key, e.target.value === "" ? "" : e.target.value === "true")}
                  className={inputCls}
                >
                  {/* 空选项的语义按字段而定: 多数旋钮"不填"=用我们的默认, 而 watermark
                      不填是**不下发这个字段**、由供应商自己决定。 */}
                  <option value="">{t(`imageProviders.${f.empty_label}`)}</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              )}
              {f.control === "number" && (
                <input
                  type="number"
                  value={shown}
                  placeholder={f.placeholder}
                  onChange={(e) => set(f.key, e.target.value === "" ? "" : Number(e.target.value))}
                  className={inputCls}
                />
              )}
              {f.control === "text" && (
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
