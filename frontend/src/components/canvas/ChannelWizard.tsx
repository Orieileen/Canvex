import { useState } from "react";
import { Check, Loader2, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { canvasService } from "@/services/canvas.service";
import { extractApiError } from "@/services/errors";
import type {
  CanvasImageProvider, CanvasKindSpec, CanvasWizardMapping, CanvasWizardParsed,
} from "@/types/canvex";

/**
 * 从供应商文档的 curl 建一条自定义通道 —— 目标是**用户一个字 JSON 都不写**。
 *
 * 为什么需要它: 模板通道解决了"能不能接", 但让人手写
 * `data.result.images[0].url[0]` 这种路径是不现实的 —— 那个路径写这个功能的人自己
 * 也是发一次请求看回包才知道的。
 *
 * 两句话概括这个向导:
 *  - **请求那一半用户已经有了** —— 供应商文档里那段 curl。curl 本身就是一个请求。
 *  - **响应那一半跑一次就知道** —— 不用问他, 在回包里找"哪个位置长得像图"。
 *
 * 而且有件事**文档里根本看不出来**: 这家是同步还是异步。apimart 和同步供应商的示例
 * curl 长得一模一样, 差别只在回包。所以第 2 步必须真发一次。
 */

type Step = "paste" | "probe" | "poll" | "done";

interface ChannelWizardProps {
  /** 建好了 —— 把预填好的通道草稿交给面板, 由它插进列表等用户点保存。 */
  onReady: (draft: Partial<CanvasImageProvider>) => void;
  /** 后端下发的按 kind 分的表单规则 (GET /image-providers/schema/)。向导只用两样:
   *  **哪些 kind 是模板类**(= 向导能建的), 和每种 kind 有哪些占位符。
   *
   *  从这里拿而不是在前端写一份: 占位符表的唯一真相在后端 (`KIND_SPECS[...].variables`,
   *  它自己又是从两个 builder 的返回值派生的)。手抄一份的失败方式很安静 —— 下拉里选得中
   *  的变量后端不认, 或者后端新加的变量在下拉里根本不出现。 */
  specs: Record<string, CanvasKindSpec>;
}

export function ChannelWizard({ onReady, specs }: ChannelWizardProps) {
  const { t } = useTranslation("canvasUi");
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("paste");
  const [busy, setBusy] = useState(false);
  /** 建哪种通道。默认生图 —— 绝大多数人是为它来的。 */
  const [kind, setKind] = useState("custom_image");
  /** 向导能建的 = 模板类通道。**由后端下发的 spec.template 决定, 不按 kind 名字判** ——
   *  加第三种模板通道时这一行自动跟上 (面板里那几处判定用的也是同一条规则)。 */
  const templateKinds = Object.keys(specs).filter((k) => specs[k]?.template);
  /** 这种 kind 的占位符表, 去掉向导自己会填的那几个。见 AUTO_VARS。 */
  const varChoices = (specs[kind]?.variables ?? []).filter((v) => !AUTO_VARS.has(v));

  const [curl, setCurl] = useState("");
  const [parsed, setParsed] = useState<CanvasWizardParsed | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [mapping, setMapping] = useState<CanvasWizardMapping[]>([]);

  const [pollCurl, setPollCurl] = useState("");
  const [taskId, setTaskId] = useState("");
  const [poll, setPoll] = useState<Record<string, unknown> | null>(null);
  const [preview, setPreview] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [found, setFound] = useState("");
  /** 轮询到第几次、供应商说的状态。**面板里显示, 不发 toast**: 一次轮询要几十秒到几
   *  分钟, 每轮弹一个 toast 是把进度做成了噪音 —— 而且 toast 会盖住下面的按钮。 */
  const [pollTry, setPollTry] = useState(0);
  const [pollStatus, setPollStatus] = useState("");

  const reset = () => {
    setStep("paste"); setCurl(""); setParsed(null); setApiKey(""); setMapping([]);
    setPollCurl(""); setTaskId(""); setPoll(null); setPreview(""); setPreviewUrl("");
    setFound(""); setPollTry(0); setPollStatus("");
  };

  /** 用户在下拉里改了某一行的占位符 → 同步回模板。
   *
   *  按 `path` 定位而不是按 key: 请求体可能有嵌套 (`input.prompt`), 同名的键在不同层
   *  是不同的东西。 */
  const remap = (row: CanvasWizardMapping, nextVar: string) => {
    if (!parsed) return;
    const next = mapping.map((m) => (m.path === row.path ? { ...m, var: nextVar } : m));
    setMapping(next);
    const body = structuredClone(parsed.template.body ?? {}) as Record<string, unknown>;
    const segs = row.path.split(".");
    let node: Record<string, unknown> = body;
    for (const seg of segs.slice(0, -1)) node = node?.[seg] as Record<string, unknown>;
    if (node) node[segs[segs.length - 1]] = nextVar ? `{{${nextVar}}}` : row.sample;
    setParsed({ ...parsed, template: { ...parsed.template, body } });
  };

  const parse = async () => {
    setBusy(true);
    try {
      const { data } = await canvasService.wizardParseCurl(curl);
      setParsed(data);
      setMapping(data.mapping);
      setApiKey(data.api_key ?? "");
      data.notes.forEach((n) => toast.info(n, { duration: 8000 }));
      setStep("probe");
    } catch (err) {
      toast.error(extractApiError(err, "解析失败"));
    } finally { setBusy(false); }
  };

  const probe = async () => {
    if (!parsed) return;
    setBusy(true);
    try {
      const { data } = await canvasService.wizardProbe({
        kind,
        base_url: parsed.base_url, api_key: apiKey, model: parsed.model ?? "",
        request_template: parsed.template,
      });
      if (data.result_path) {
        // 同步出图 —— 模板齐了。
        setParsed({ ...parsed, template: { ...parsed.template, result_path: data.result_path } });
        setFound(data.result_path);
        setPreview(data.candidates[0]?.preview ?? "");
        setPreviewUrl(data.preview_url ?? "");
        setStep("done");
      } else if (data.is_async) {
        // **这一步是这个向导最值钱的地方**: 文档里看不出来这家是异步的。
        setTaskId(String(pickTaskId(data.raw) ?? ""));
        setParsed({
          ...parsed,
          template: { ...parsed.template, task_id_path: data.task_id_path ?? "" },
        });
        setStep("poll");
      } else {
        toast.error(t("wizard.noImage"), { duration: 12000 });
      }
    } catch (err) {
      toast.error(extractApiError(err, "试跑失败"), { duration: 15000 });
    } finally { setBusy(false); }
  };

  const parsePoll = async () => {
    if (!parsed) return;
    setBusy(true);
    try {
      const { data } = await canvasService.wizardParseCurl(pollCurl, {
        task_id: taskId, base_url: parsed.base_url,
      });
      setPoll(data.poll ?? null);
      toast.success(t("wizard.pollParsed"));
    } catch (err) {
      toast.error(extractApiError(err, "解析失败"));
    } finally { setBusy(false); }
  };

  /** 反复查, 直到出图。出图那一次顺手把 status_path / done / result_path 都读出来 ——
   *  `done` 用的是**那一刻真实看到的状态值**, 不是让人在 succeeded/completed/success
   *  里猜。 */
  const runPoll = async () => {
    if (!parsed || !poll) return;
    setBusy(true);
    try {
      for (let i = 0; i < 40; i++) {
        setPollTry(i + 1);
        const { data } = await canvasService.wizardProbe({
          kind,
          base_url: parsed.base_url, api_key: apiKey, model: parsed.model ?? "",
          request_template: parsed.template, poll, task_id: taskId,
        });
        if (data.done && data.result_path) {
          const filled = {
            ...poll, status_path: data.status_path ?? "",
            done: [data.status ?? ""], result_path: data.result_path,
          };
          setPoll(filled);
          setParsed({ ...parsed, template: { ...parsed.template, poll: filled } });
          setFound(data.result_path);
          setPreview(data.candidates[0]?.preview ?? "");
          setPreviewUrl(data.preview_url ?? "");
          setStep("done");
          return;
        }
        setPollStatus(data.status || "…");
        await new Promise((r) => setTimeout(r, 6000));
      }
      toast.error(t("wizard.pollGaveUp"), { duration: 12000 });
    } catch (err) {
      toast.error(extractApiError(err, "查询失败"), { duration: 15000 });
    } finally { setBusy(false); }
  };

  const finish = () => {
    if (!parsed) return;
    onReady({
      kind: kind as CanvasImageProvider["kind"],
      label: channelName(parsed.base_url, t(`wizard.nameFor.${kind}`, "")),
      base_url: parsed.base_url,
      api_key: apiKey,
      request_template: parsed.template,
      models: parsed.model
        ? [{ id: `new-${Date.now()}`, label: parsed.model, model: parsed.model,
             overrides: {}, enabled: true, sort_order: 0 }]
        : [],
    });
    reset(); setOpen(false);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border px-3 py-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-foreground/5 hover:text-foreground"
      >
        <Wand2 className="size-4" strokeWidth={2} />
        {t("wizard.start")}
      </button>
    );
  }

  return (
    <div className="rounded-md border border-border p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[12px] font-medium">{t("wizard.title")}</span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {t(`wizard.step.${step}`)}
        </span>
      </div>

      {step === "paste" && (
        <>
          {/* 建哪种。只列**模板类** kind —— 由后端下发的 spec.template 决定, 不按 kind
              名字判, 加第三种模板通道时这里自动多一项。只有一种时整行不出现。 */}
          {templateKinds.length > 1 && (
            <div className="mb-2 flex gap-1">
              {templateKinds.map((k) => (
                <button
                  key={k} type="button" onClick={() => setKind(k)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-[11px]",
                    k === kind
                      ? "border-foreground/30 bg-foreground/10 font-medium text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(`wizard.kindShort.${k}`, k)}
                </button>
              ))}
            </div>
          )}
          <p className="mb-1.5 text-[11px] leading-relaxed text-muted-foreground">
            {t(`wizard.pasteHint.${kind}`, { defaultValue: t("wizard.pasteHint.custom_image") })}
          </p>
          <textarea
            value={curl} onChange={(e) => setCurl(e.target.value)} rows={8} spellCheck={false}
            placeholder={"curl --request POST \\\n  --url https://api.example.com/v1/images/generations \\\n  --header 'Authorization: Bearer <token>' \\\n  --data '{\"model\":\"…\",\"prompt\":\"…\"}'"}
            className="w-full resize-y rounded-md border border-border bg-background p-2 font-mono text-[11px] outline-none focus:border-foreground/30"
          />
          <WizardButtons
            busy={busy} disabled={!curl.trim()} onRun={() => void parse()}
            runLabel={t("wizard.parse")} onCancel={() => { reset(); setOpen(false); }}
          />
        </>
      )}

      {step === "probe" && parsed && (
        <>
          <Row label="Base URL">{parsed.base_url}</Row>
          <Row label={t("wizard.model")}>{parsed.model || "—"}</Row>
          <label className="mt-2 block text-[11px] text-muted-foreground">API key</label>
          <input
            value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…"
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[12px] outline-none focus:border-foreground/30"
          />
          <p className="mb-1 mt-3 text-[11px] font-medium">{t("wizard.mappingTitle")}</p>
          <p className="mb-1.5 text-[11px] leading-relaxed text-muted-foreground">
            {t("wizard.mappingHint")}
          </p>
          <div className="rounded-md border border-border">
            {mapping.map((m) => (
              <div key={m.path} className="flex items-center gap-2 border-b border-border px-2 py-1.5 text-[11px] last:border-0">
                <code className="w-28 shrink-0 truncate font-mono">{m.key}</code>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {String(m.sample)}
                </span>
                <select
                  value={m.var} onChange={(e) => remap(m, e.target.value)}
                  className="shrink-0 rounded border border-border bg-background px-1 py-0.5 text-[11px]"
                >
                  <option value="">{t("wizard.varFixed")}</option>
                  {varChoices.map((v) => (
                    <option key={v} value={v}>{t(`wizard.var.${v}`)}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <WizardButtons
            busy={busy} disabled={!apiKey.trim()} onRun={() => void probe()}
            runLabel={t("wizard.probe")} onCancel={() => setStep("paste")}
            note={t("wizard.probeCost")}
          />
        </>
      )}

      {step === "poll" && (
        <>
          <p className="mb-1.5 rounded-md bg-foreground/5 p-2 text-[11px] leading-relaxed">
            {t("wizard.isAsync", { taskId })}
          </p>
          <textarea
            value={pollCurl} onChange={(e) => setPollCurl(e.target.value)} rows={5} spellCheck={false}
            placeholder={"curl --url https://api.example.com/v1/tasks/<task_id> \\\n  --header 'Authorization: Bearer <token>'"}
            className="w-full resize-y rounded-md border border-border bg-background p-2 font-mono text-[11px] outline-none focus:border-foreground/30"
          />
          {!poll ? (
            <WizardButtons
              busy={busy} disabled={!pollCurl.trim()} onRun={() => void parsePoll()}
              runLabel={t("wizard.parse")} onCancel={() => setStep("probe")}
            />
          ) : (
            <>
              {busy && (
                <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  {t("wizard.polling", { n: pollTry, status: pollStatus || "…" })}
                </p>
              )}
              <WizardButtons
                busy={busy} disabled={false} onRun={() => void runPoll()}
                runLabel={t("wizard.runPoll")} onCancel={() => setPoll(null)}
                note={t("wizard.pollNote")}
              />
            </>
          )}
        </>
      )}

      {step === "done" && (
        <>
          <div className="flex items-start gap-2 rounded-md bg-foreground/5 p-2 text-[11px]">
            <Check className="mt-0.5 size-3.5 shrink-0" strokeWidth={2.5} />
            <div className="min-w-0">
              <div className="font-medium">{t("wizard.foundTitle")}</div>
              <code className="break-all font-mono text-muted-foreground">{found}</code>
              {preview && !previewUrl && (
                <div className="mt-1 truncate text-muted-foreground">{preview}</div>
              )}
            </div>
          </div>
          {/* **把刚生成的东西显示出来。** 一行 `data.result.images[0].url[0]` 只能证明
              "有个地址长得像结果"; 看见图才是"这条通道真的通了"的完整证据 —— 而这正是
              这个向导相对于"猜一份配置"的全部区别。拉不到 (地址过期 / 防盗链) 就退回
              显示那行文字, 不挡住"创建"。 */}
          {previewUrl && (
            kind === "custom_video" ? (
              <video
                src={previewUrl} controls muted playsInline
                className="mt-2 max-h-48 w-full rounded-md border border-border object-contain"
              />
            ) : (
              <img
                src={previewUrl} alt=""
                onError={(e) => { e.currentTarget.style.display = "none"; }}
                className="mt-2 max-h-48 w-full rounded-md border border-border object-contain"
              />
            )
          )}
          <WizardButtons
            busy={busy} disabled={false} onRun={finish}
            runLabel={t("wizard.create")} onCancel={() => { reset(); setOpen(false); }}
          />
        </>
      )}
    </div>
  );
}

/** 这几个占位符**不进下拉**: 它们由向导自己填 (base_url / api_key 从 curl 里拆出来,
 *  task_id 是轮询时注入的), 放出来只会让人误选一个然后渲染成空。
 *
 *  其余的从后端下发的 `spec.variables` 来 —— 那是唯一真相 (后端又是从两个变量 builder
 *  的返回值派生的)。这里原来手抄了一份十三项的清单, 而生图和视频的变量表根本不一样。 */
const AUTO_VARS = new Set(["base_url", "api_key", "task_id"]);

/** 「apimart 生图」—— 从 Base URL 的主机名 + 通道类型拼一个默认名字。
 *
 *  存在的理由: 不给名字的话新卡片是空的, 而面板要求有名字才能保存 —— 向导一路跑到最后
 *  一步、点了「创建」, 却卡在一句"名称必填", 是最不该出现的一次卡壳。
 *
 *  取主机名是因为那是用户唯一能一眼认出来的东西 (他自己起的名字也是这么来的:
 *  「自定义-兔子」「向导建的-apimart」)。名字只是默认值, 卡片上随时能改。 */
function channelName(baseUrl: string, kindWord: string): string {
  let host = "";
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return "";                       // 连 URL 都不是就不猜, 让用户自己填
  }
  const core = host.replace(/^(?:api|www)\./i, "").split(".")[0];
  if (!core) return "";
  return kindWord ? `${core} ${kindWord}` : core;
}

function pickTaskId(raw: unknown): string | undefined {
  const seen: string[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === "object") {
      for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
        if (/task_?id|job_?id/i.test(k) && (typeof v === "string" || typeof v === "number")) {
          seen.push(String(v));
        } else walk(v);
      }
    }
  };
  walk(raw);
  return seen[0];
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 py-0.5 text-[11px]">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono">{children}</span>
    </div>
  );
}

function WizardButtons({
  busy, disabled, onRun, runLabel, onCancel, note,
}: {
  busy: boolean; disabled: boolean; onRun: () => void; runLabel: string;
  onCancel: () => void; note?: string;
}) {
  const { t } = useTranslation("canvasUi");
  return (
    <>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button" disabled={busy || disabled} onClick={onRun}
          className="flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-[12px] font-medium text-background disabled:opacity-40"
        >
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          {runLabel}
        </button>
        <button
          type="button" onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-[12px] text-muted-foreground hover:text-foreground"
        >
          {t("sidebar.cancel")}
        </button>
        {note && <span className={cn("text-[11px] text-muted-foreground")}>{note}</span>}
      </div>
    </>
  );
}
