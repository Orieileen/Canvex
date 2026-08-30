import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Sparkles,
  Trash2,
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
import { ChannelWizard } from "@/components/canvas/ChannelWizard";
import { canvasService } from "@/services/canvas.service";
import { extractApiError } from "@/services/errors";
import { cn } from "@/lib/utils";
import type {
  CanvasChannelPreset,
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

/** 诊断 code → 一句能照做的话。
 *
 *  后端只回 code (见 backend services/channel_diagnosis.py), 文案在这边 —— 否则英文界面
 *  上会冒出一句中文, 而且同一句话有了两个来源。
 *
 *  `defaultValue: ""` 而不是 `i18n.exists`: 后端加了一个新 code、这边还没补文案时, 表现是
 *  "少一句提示"而不是界面上冒出一个 key 名。原文本来就在下面, 少一句提示不致命。 */
const diagText = (t: TFunction, code: string) =>
  code ? t(`imageProviders.diag.${code}`, { defaultValue: "" }) : "";

/** 等宽多行输入 (curl 导入、请求模板)。跟 `inputCls` 同一个理由: 这串 class 在本文件里
 *  已经出现过三次, 而改主题/尺寸时漏掉一处不会报错, 只会长得不一样。 */
const monoTextareaCls =
  "w-full resize-y rounded-md border border-border bg-background p-2 font-mono text-[11px] outline-none";

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

/** 「上一次调用是多久以前」。
 *
 *  用 Intl.RelativeTimeFormat 而不是自己拼「3 分钟前」: 后者要为秒/分/时/天各补两套
 *  翻译还得处理单复数, 而浏览器本来就带一份, 跟着 i18n 当前语言走。
 *
 *  表是 [到这个秒数为止, 换算除数, 单位]。找第一个装得下的档 —— 90 秒说"1 分钟前"而
 *  不是"90 秒前"。 */
const RELATIVE_STEPS: [limit: number, per: number, unit: Intl.RelativeTimeFormatUnit][] = [
  [60, 1, "second"],
  [3600, 60, "minute"],
  [86400, 3600, "hour"],
  [604800, 86400, "day"],
  [2629800, 604800, "week"],
  [31557600, 2629800, "month"],
  [Infinity, 31557600, "year"],
];

const relTime = (iso: string, lang: string) => {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  const [, per, unit] =
    RELATIVE_STEPS.find(([limit]) => Math.abs(seconds) < limit) ?? RELATIVE_STEPS[RELATIVE_STEPS.length - 1];
  // 负数 = 过去。numeric:"auto" 让"0 秒前"变成「刚刚」/「now」而不是「0 秒前」。
  return new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(
    Math.round(-seconds / per), unit,
  );
};

/** 空草稿 —— 「新建供应商」和 curl 导入都从它开始。 */
const emptyProvider = (): CanvasImageProvider => ({
  id: "",
  label: "",
  // 手动新建 = 建一条**自定义模板**通道。老的 image / video 两种不再能新建 (schema 里
  // creatable=false) —— 它们是模板通道出现之前的形状, 而 custom_* 能表达的严格更多。
  kind: "custom_image",
  request_template: {},
  base_url: "",
  api_key: "",
  defaults: {},
  models: [],
  created_at: "",
  updated_at: "",
  // 健康是**服务端事实**, 本地草稿上永远是"还没调用过"。真正的值由 reload 从服务端带回。
  last_status: "",
  last_checked_at: null,
  last_error: "",
  last_error_diagnosis: "",
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
  // 一起发, 也一起参与 isDirty 比较 —— 漏了的话改完模板点保存"没有未保存的改动",
  // 而且改动直接丢。
  request_template: p.request_template ?? {},
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
        .then(({ data }) => { setTunables(data.tunables); setPresets(data.presets ?? []); })
        .catch(() => setTunables({}));
    }
    // tunables 刻意不进依赖: 它只在还没拿到时拉一次, 进依赖会在 setTunables 后再触发一轮。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reload]);

  /** 一键预设。后端下发 (见 image_channels.PRESETS) —— 前端不写死任何一家供应商。 */
  const [presets, setPresets] = useState<CanvasChannelPreset[]>([]);
  /** 按**角色**分组: 聊天 / 生图 / 换视角。同一个角色下的几家并排, 角色名只说一次。
   *
   *  分组用后端给的 `role` 而不是 kind 名字 —— 一个角色可能对应多种 kind (生图 = 内置
   *  image + 模板 custom_image), 按名字分的话哪天加一条内置 image 的预设就会自己单开
   *  一组。顺序完全跟后端下发的行序, 这里只做首次出现的分段。 */
  const presetRoles = useMemo(() => {
    const seen = new Map<string, CanvasChannelPreset[]>();
    for (const p of presets) (seen.get(p.role) ?? seen.set(p.role, []).get(p.role)!).push(p);
    return [...seen.entries()];
  }, [presets]);

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
          {/* 两档:
                预设 —— 认识的那几家, 点一下只填 key。
                向导 —— 别家, 粘一段 curl。**四种还能新建的通道它都能建**: 要模板的
                        (custom_image / custom_video) 走完整流程, 不要模板的
                        (chat / angle) 走一条两步的短路。
              预设排最前面: 新用户的第一个问题不是"我想怎么配", 是"我怎么开始"。

              这里原来还有第三档「新建通道」—— 一张空白卡片, 什么都自己填。删掉的理由:
              上面两档合起来已经没有它够不着的东西了。聊天和换视角除了 base_url + key +
              模型名什么都不配, 而那三样一段 curl 里全都有; 老的 image / video 两种确实
              只有它能建, 但那两种已经标成不可新建 (creatable=false) —— custom_* 能表达
              的严格更多, 最后一处差距 (火山那种写死的像素表) 在 allowed_ratios 支持
              `比例=要发的值` 之后也没了。 */}
          {presetRoles.length > 0 && (
            <div className="rounded-md border border-border p-2.5">
              <div className="mb-2 text-[11px] font-medium text-muted-foreground">
                {t("imageProviders.presetsTitle")}
              </div>
              {presetRoles.map(([role, items]) => (
                <div key={role} className="mb-2 last:mb-0">
                  <div className="mb-1 text-[11px] text-muted-foreground">
                    {t(`imageProviders.presetRole.${role}`, role)}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {items.map((preset) => (
                      <PresetChip
                        key={preset.key} preset={preset}
                        onPick={() => addDraft({
                          kind: preset.kind as CanvasImageProvider["kind"],
                          // 通道名用 `channel` 而不是 `label`: label 是芯片上那几个字
                          // (供应商名), 拿它当通道名, 列表里会出现一条叫「OpenAI 官方」
                          // 的通道 —— 看不出它是聊天还是生图。
                          label: t(`imageProviders.presets.${preset.key}.channel`, preset.key),
                          base_url: preset.base_url,
                          defaults: preset.defaults as Values,
                          request_template: preset.request_template,
                          models: [{
                            id: newLocalId(), label: preset.model, model: preset.model,
                            overrides: {}, enabled: true, sort_order: 0,
                          }],
                        })}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 建通道只有这一个入口。这里原来还并排放着一个「从 curl 示例导入」—— 同样
              写着"粘一段 curl", 但它是把 curl 猜成内置通道那十四个旋钮、而且从不验证,
              粘完人就落在十四个输入框里。两个入口只是让人选错, 删了。 */}
          <ChannelWizard onReady={(seed) => addDraft(seed)} specs={tunables} />

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
              onTested={() => void reload()}
              tunables={tunables}
              kinds={kinds}
            />
          ))}

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

/** 一键预设按钮。点一下 = 一张填好 base_url / 模型 / 请求形状的草稿, 只剩 key 要填。
 *
 *  **它不是"内置供应商"**: 存进库之后就是一条普通通道, 跟手配出来的没有区别, 随便改
 *  随便删。所以这里也不该有任何一家供应商的特殊逻辑 —— 名字、说明、去哪儿拿 key 全是
 *  按 `preset.key` 查的翻译, 查不到就退回显示 key 本身。 */
function PresetChip({ preset, onPick }: { preset: CanvasChannelPreset; onPick: () => void }) {
  const { t } = useTranslation("canvasUi");
  return (
    <button
      type="button"
      onClick={onPick}
      // 说明放 title 而不是排在芯片下面: 一行只放得下供应商名, 而说明 (哪个域名、
      // 什么形状) 点进去卡片上就有 —— 在这里它只会把一行挤成三行。
      title={t(`imageProviders.presets.${preset.key}.hint`, preset.base_url)}
      className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] transition-colors hover:border-foreground/30 hover:bg-foreground/5"
    >
      <Sparkles className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={2} />
      {t(`imageProviders.presets.${preset.key}.label`, preset.key)}
    </button>
  );
}

/**
 * 通道健康的那个点 —— 「上一次真的调用它时, 供应商应答了吗」。
 *
 * 存在的理由: 一条配好的通道会在**没有任何人操作**的情况下坏掉 (key 过期、额度打光、
 * 供应商换端点), 而在此之前唯一的发现方式是"下一次生成失败" —— 那条报错落在画布上一张
 * 图的红字里, 关掉就没了; 回到这个面板, 这条通道看起来和配好的第一天一模一样。
 *
 * **读服务端那份 (`saved`) 而不是草稿**: 这是一条服务端事实, 本地改了半截不会让一条坏
 * 通道变好, 也不会让一条好通道变坏。所以还没保存的新卡片上它根本不出现 (调用方判)。
 *
 * 三态而不是两态: "还没调用过"必须跟"通了"分得开 —— 一个刚建好的通道显示绿点等于凭空
 * 给了一个没人验证过的承诺。
 */
function HealthDot({ provider }: { provider: CanvasImageProvider }) {
  const { t, i18n } = useTranslation("canvasUi");
  const when = provider.last_checked_at ? relTime(provider.last_checked_at, i18n.language) : "";
  // 悬停能看到全文。展开之后下面还有一块能选中复制的 —— 长报文在 title 里读不了。
  const title =
    provider.last_status === "error"
      ? `${t("imageProviders.healthError", { when })}\n${provider.last_error}`
      : provider.last_status === "ok"
        ? t("imageProviders.healthOk", { when })
        : t("imageProviders.healthUnknown");
  return (
    <span
      title={title}
      // role 不能省: 一个裸 <span> 即使带了 aria-label 也不会被读屏念出来, 而这个点是
      // 纯颜色编码的 —— 没有它, "这条通道坏了"对读屏用户根本不存在。
      role="img"
      aria-label={title}
      className={cn(
        "size-2 shrink-0 rounded-full",
        provider.last_status === "ok" && "bg-ok",
        provider.last_status === "error" && "bg-destructive",
        // 没调用过 = 空心。跟"通了"分得开, 又不像实心灰那样看着像"停用了"。
        !provider.last_status && "border border-border",
      )}
    />
  );
}

/** 展开之后那一行/一块健康详情。失败时给的是**供应商返回的原文** —— 用户拿着它对着
 *  文档就能改, 跟「测试」按钮的 toast 是同一份东西, 所以不美化、不归类。 */
function HealthNote({ provider }: { provider: CanvasImageProvider }) {
  const { t, i18n } = useTranslation("canvasUi");
  if (!provider.last_status) return null;
  const when = provider.last_checked_at ? relTime(provider.last_checked_at, i18n.language) : "";
  if (provider.last_status === "ok") {
    return (
      <p className="text-[11px] text-muted-foreground">{t("imageProviders.healthOk", { when })}</p>
    );
  }
  const hint = diagText(t, provider.last_error_diagnosis);
  return (
    <div className="rounded-md bg-destructive/10 px-2.5 py-2 text-[11px] leading-relaxed text-destructive">
      <div className="font-medium">{t("imageProviders.healthError", { when })}</div>
      {/* 诊断排在原文**前面**: 原文说的是"发生了什么", 这句说的是"你该改哪儿", 而后者
          才是用户打开这张卡片要找的东西。认不出类别时这一行整个不出现。 */}
      {hint && <div className="mt-1">{hint}</div>}
      {/* 可选中: 这段要能复制去搜 / 贴给供应商。break-all 是因为报文里常有一整条没有
          空格的 URL, 不断行会把卡片撑出横向滚动条。 */}
      <div className="mt-1 font-mono break-all whitespace-pre-wrap select-text opacity-75">
        {provider.last_error}
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
  onTested,
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
  /** 「测了一次」—— 让父组件重拉列表, 把那个点和下面的报文换成这一次的结果。
   *  测试的结果是**服务端写的** (后端每次真实调用都记, 不只是这个按钮), 所以不在本地
   *  凑一份出来: 那样它会跟画布上那次生成写进去的结果打架。 */
  onTested: () => void;
  /** 后端下发的按 kind 分组的表单规则。 */
  tunables: Record<string, CanvasKindSpec>;
  /** 可选的通道类型 = schema 的键。 */
  kinds: string[];
}) {
  const { t } = useTranslation("canvasUi");
  const [testing, setTesting] = useState("");
  // 模板编辑器里现在是不是一段非法 JSON。非法时不能保存 —— 编辑器不会把非法文本抛上来,
  // 硬存的话存进去的是**上一个合法版本**, 用户却拿到一句"保存成功"。
  const [templateBad, setTemplateBad] = useState(false);
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
      if (data.ok) {
        toast.success(t("imageProviders.testOk", { s: data.elapsed }));
      } else {
        // 原始错误**永远**显示 —— 用户拿着它对着供应商文档就能改, 所以不美化、不截断成
        // 一句"请求失败"。诊断只是**加**在它上面的一句"你该改哪儿": 认得出就当标题、原文
        // 退到副标题; 认不出就跟以前一模一样。
        const hint = diagText(t, data.diagnosis ?? "");
        toast.error(hint || data.error || t("imageProviders.testFailed"), {
          description: hint ? data.error : undefined,
          duration: 15000,
        });
      }
    } catch (err) {
      toast.error(extractApiError(err, "test failed"));
    } finally {
      setTesting("");
      // 通/不通两种都要刷: 后端在这一次调用里已经把结果记到通道行上了, 不重拉的话卡片上
      // 那个点还停在上一次。
      onTested();
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
        {/* 折叠着也看得见 —— 这一条的全部意义就是不用逐个展开就知道哪条坏了。
            没保存的新卡片没有 `saved`, 也就没有点: 库里还没有这一行, 谈不上"上次调用"。 */}
        {saved && <HealthDot provider={saved} />}
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
          {/* 排在所有字段前面: 一条通道刚坏的时候, "供应商说了什么"比任何一个输入框都
              重要 —— 用户就是照着它去改下面那些字段的。 */}
          {saved && <HealthNote provider={saved} />}
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
                {/* kind 列表 = schema payload 的键, 但**只列还能新建的** (后端的
                    creatable, 见 image_channels._KindSpec)。加通道类型时后端加一行,
                    这里自动多一项 (只需补一条 i18n 文案)。

                    库里存量的 image / video 不会因此被困住: 这个下拉只在 isNew 时渲染,
                    存过的通道压根没有它 —— 类型由头部那个徽标显示, 而那一处不筛。 */}
                {kinds.filter((k) => tunables[k]?.creatable).map((k) => (
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

          {/* 模板通道: 用一个 JSON 编辑器代替那排旋钮。由后端下发的 spec.template 决定,
              **不按 kind 名字判** —— 加第三种模板通道时这里自动跟上。 */}
          {spec?.template && (
            <TemplateEditor
              value={draft.request_template}
              onChange={(request_template) => onPatch({ request_template })}
              onInvalid={setTemplateBad}
              starters={spec.starters}
              variables={spec.variables}
            />
          )}

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
              disabled={templateBad}
              className="rounded-md bg-foreground px-3 py-1.5 text-[12px] font-medium text-background disabled:opacity-40"
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

  // 用户手动折过的组。没记过的组走下面 `isOpen` 那条默认规则。
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  // 按后端给的 group 切段。**顺序完全由后端下发的行序决定** (它已经按组排好), 这里不再
  // 自己排一份 —— 排两份的下场是加一组时界面上的位置跟后端说的不一样, 而且不报错。
  const groups = useMemo(() => {
    const out: { key: string; rows: CanvasTunableSpec[] }[] = [];
    for (const f of specs) {
      const key = f.group || "other";
      const last = out[out.length - 1];
      if (last && last.key === key) last.rows.push(f);
      else out.push({ key, rows: [f] });
    }
    return out;
  }, [specs]);

  // 只有一组时不显示分组头 —— angle / chat 只有一个 timeout, 给它套一个标题纯属噪音。
  const showHeaders = groups.length > 1;

  /** 「异步轮询」默认折起来: 那几个旋钮只在**异步**通道上有意义, 而同步是大多数, 它们
   *  平铺出来占了这张表的一半。已经设过值就展开 —— 一条配好的异步通道不该把自己的配置
   *  藏起来, 那比多几个框糟得多。 */
  const isOpen = (g: { key: string; rows: CanvasTunableSpec[] }) =>
    toggled[g.key] ??
    (g.key !== "poll" || g.rows.some((f) => values[f.key] !== undefined));

  return (
    <div className="rounded-md bg-foreground/5 p-2">
      {title && <div className="mb-1 text-[12px] font-medium">{title}</div>}
      {hint && <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
      <div className="flex flex-col gap-3">
        {groups.map((g) => (
          <div key={g.key} className="flex flex-col gap-2">
            {showHeaders && (
              <button
                type="button"
                onClick={() => setToggled({ ...toggled, [g.key]: !isOpen(g) })}
                className="flex items-center gap-1.5 text-left text-[11px] font-medium text-foreground"
              >
                <span className="text-muted-foreground">{isOpen(g) ? "▾" : "▸"}</span>
                {t(`imageProviders.group.${g.key}`, g.key)}
                <span className="font-normal text-muted-foreground">({g.rows.length})</span>
              </button>
            )}
            {isOpen(g) && showHeaders && (
              <p className="-mt-1 text-[10px] leading-relaxed text-muted-foreground">
                {t(`imageProviders.groupHint.${g.key}`, { defaultValue: "" })}
              </p>
            )}
            {isOpen(g) && g.rows.map((f) => {
          // 三种控件都用同一份显示值: undefined (没配这项) → 空串, 其余原样转字符串。
          const shown = values[f.key] === undefined ? "" : String(values[f.key]);
          return (
          <div key={f.key} className="flex items-start gap-2">
            {/* 人话在上、字段名在下。反过来看了一年也记不住 `image_as_single` 是什么,
                而字段名仍然要留着 —— 供应商文档和我们自己的报错都按它称呼。 */}
            <div className="w-[136px] shrink-0 pt-1">
              <div className="text-[11px] leading-tight text-foreground">
                {t(`imageProviders.field.${f.key}`, f.key)}
              </div>
              <div className="font-mono text-[10px] text-muted-foreground">{f.key}</div>
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
              {f.control === "choice" && (
                <select
                  value={shown}
                  onChange={(e) => set(f.key, e.target.value)}
                  className={inputCls}
                >
                  {/* 空串排第一 = 默认那一项 (见后端的 CHAT_PROTOCOL_CHOICES)。它的
                      名字要说清楚"不选就是这个", 而不是显示成一个空格。 */}
                  {(f.choices ?? []).map((c) => (
                    <option key={c} value={c}>
                      {t(`imageProviders.choice.${f.key}.${c || "default"}`, c || "—")}
                    </option>
                  ))}
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
        ))}
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


/** 模板通道的请求模板编辑器。
 *
 *  为什么是裸 JSON 而不是一堆字段: 模板的整个价值就是"形状随你写" —— 一旦拆成
 *  URL/headers/body 三个框, 就又开始替用户预设结构了, 而下一个供应商总有个地方对不上。
 *
 *  本地存的是**文本**而不是解析后的对象: 用户打字的中间态 (`{"a":` ) 不是合法 JSON,
 *  每敲一个字符就 parse 再回写会把光标和内容都搅乱。只有 parse 成功时才往上抛对象,
 *  失败时留一行红字并且**不覆盖**上层的值 —— 存盘按钮那边拿到的仍然是上一个合法版本。
 *
 *  那个"不覆盖"要配 `onInvalid` 一起看: 光留一行红字是不够的, 用户照样能点保存, 然后
 *  拿到一句"保存成功"而他刚敲的东西被静默丢掉(存进去的是上一个合法版本)。所以非法状态
 *  要报上去, 由卡片把保存按钮禁掉。
 */
function TemplateEditor({
  value, onChange, onInvalid, starters, variables,
}: {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** 当前文本是不是不合法的 JSON。卡片据此禁用保存。 */
  onInvalid: (bad: boolean) => void;
  starters: { label: string; template: Record<string, unknown> }[];
  variables: string[];
}) {
  const { t } = useTranslation("canvasUi");
  const pretty = (v: unknown) => JSON.stringify(v ?? {}, null, 2);
  const [text, setText] = useState(() => pretty(value));
  // 从 text 推, 不另开一份 state —— 它俩描述的是同一件事 ("这段文本能不能 parse"),
  // 分成两份就有走散的可能, 而且渲染期那段外部同步里还要多一次 setState。
  const bad = useMemo(() => {
    try { JSON.parse(text); return false; } catch { return true; }
  }, [text]);
  // 外部换了模板 (选了起点模板 / reload 拿到服务端版本) 时同步进来。比较的是格式化后的
  // 文本, 否则用户自己敲的空白会被当成"外部变了"而被覆盖掉。
  const external = pretty(value);
  const lastExternal = useRef(external);
  if (lastExternal.current !== external) {
    lastExternal.current = external;
    setText(external);
  }

  // 卸载 / bad 变化时把状态报上去。放 effect 里而不是直接在 commit 里调: 上面那段
  // "外部变了"的同步是**渲染期间**改 state 的, 在渲染期间去改父组件的 state 是非法的。
  // cleanup 里报 false 是给"通道类型改掉、编辑器整个卸载"兜底 —— 否则保存按钮会永久禁着。
  useEffect(() => {
    onInvalid(bad);
    return () => onInvalid(false);
  }, [bad, onInvalid]);

  const commit = (next: string) => {
    setText(next);
    try {
      const parsed = JSON.parse(next);
      // **这一步必须同时推进 lastExternal**: onChange 会让父组件的 value 变成 parsed,
      // 下一次渲染 external 就跟着变了 —— 不推进的话上面那段会把它当成"外部改了模板",
      // 于是每敲出一个合法 JSON 都被重新格式化一遍、光标弹到末尾。格式化是「格式化」
      // 按钮的事, 不该在打字中途自己发生。
      lastExternal.current = pretty(parsed);
      onChange(parsed);
    } catch {
      // 解析不了就不 onChange —— 上层保留上一个合法版本, `bad` 由 text 自己推出来。
    }
  };

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[12px] font-medium">{t("imageProviders.template")}</span>
        <select
          value=""
          onChange={(e) => {
            const s = starters.find((x) => x.label === e.target.value);
            if (s) onChange(s.template);
          }}
          className="ml-auto rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground"
        >
          <option value="">{t("imageProviders.templateStarter")}</option>
          {starters.map((s) => (
            <option key={s.label} value={s.label}>{s.label}</option>
          ))}
        </select>
        <button
          type="button"
          disabled={bad}
          onClick={() => setText(pretty(value))}
          className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          {t("imageProviders.templateFormat")}
        </button>
      </div>
      <p className="mb-1.5 text-[11px] leading-relaxed text-muted-foreground">
        {t("imageProviders.templateHint")}
      </p>
      <textarea
        value={text}
        onChange={(e) => commit(e.target.value)}
        rows={16}
        spellCheck={false}
        className={cn(
          monoTextareaCls,
          bad ? "border-destructive" : "focus:border-foreground/30",
        )}
      />
      {bad && (
        <p className="mt-1 text-[11px] text-destructive">{t("imageProviders.templateInvalid")}</p>
      )}
      <div className="mt-1.5 text-[11px] text-muted-foreground">
        {t("imageProviders.templateVars")}:{" "}
        {variables.map((v) => (
          <code key={v} className="mr-1 rounded bg-foreground/5 px-1 py-px">{`{{${v}}}`}</code>
        ))}
      </div>
    </div>
  );
}
