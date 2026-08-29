import { useState } from "react";
import { Check, Loader2, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { canvasService } from "@/services/canvas.service";
import { extractApiError } from "@/services/errors";
import type {
  CanvasImageProvider, CanvasWizardMapping, CanvasWizardParsed,
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
}

export function ChannelWizard({ onReady }: ChannelWizardProps) {
  const { t } = useTranslation("canvasUi");
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("paste");
  const [busy, setBusy] = useState(false);

  const [curl, setCurl] = useState("");
  const [parsed, setParsed] = useState<CanvasWizardParsed | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [mapping, setMapping] = useState<CanvasWizardMapping[]>([]);

  const [pollCurl, setPollCurl] = useState("");
  const [taskId, setTaskId] = useState("");
  const [poll, setPoll] = useState<Record<string, unknown> | null>(null);
  const [preview, setPreview] = useState("");
  const [found, setFound] = useState("");

  const reset = () => {
    setStep("paste"); setCurl(""); setParsed(null); setApiKey(""); setMapping([]);
    setPollCurl(""); setTaskId(""); setPoll(null); setPreview(""); setFound("");
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
        base_url: parsed.base_url, api_key: apiKey, model: parsed.model ?? "",
        request_template: parsed.template,
      });
      if (data.result_path) {
        // 同步出图 —— 模板齐了。
        setParsed({ ...parsed, template: { ...parsed.template, result_path: data.result_path } });
        setFound(data.result_path);
        setPreview(data.candidates[0]?.preview ?? "");
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
        const { data } = await canvasService.wizardProbe({
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
          setStep("done");
          return;
        }
        toast.info(t("wizard.polling", { status: data.status || "…" }), { duration: 4000 });
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
      kind: "custom_image",
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
          <p className="mb-1.5 text-[11px] leading-relaxed text-muted-foreground">
            {t("wizard.pasteHint")}
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
                  {VAR_CHOICES.map((v) => (
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
            <WizardButtons
              busy={busy} disabled={false} onRun={() => void runPoll()}
              runLabel={t("wizard.runPoll")} onCancel={() => setPoll(null)}
            />
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
              {preview && <div className="mt-1 truncate text-muted-foreground">{preview}</div>}
            </div>
          </div>
          <WizardButtons
            busy={busy} disabled={false} onRun={finish}
            runLabel={t("wizard.create")} onCancel={() => { reset(); setOpen(false); }}
          />
        </>
      )}
    </div>
  );
}

/** 用户能把某个键改成哪些占位符。跟后端 KIND_SPECS[custom_image].variables 是同一批,
 *  但这里只列**用户会想手动指定**的那些 —— base_url / api_key / task_id 由向导自己填,
 *  放进下拉只会让人误选。 */
const VAR_CHOICES = [
  "prompt", "model", "n", "size", "aspect_ratio", "width", "height",
  "resolution", "image", "images", "image_base64", "images_base64", "duration",
] as const;

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
