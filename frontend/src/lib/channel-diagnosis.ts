import type { TFunction } from "i18next";

/** 诊断 code → 一句能照做的话。
 *
 *  后端只回 code (见 backend services/channel_diagnosis.py), 文案在这边 —— 否则英文界面
 *  上会冒出一句中文, 而且同一句话有了两个来源。
 *
 *  `defaultValue: ""` 而不是 `i18n.exists`: 后端加了一个新 code、这边还没补文案时, 表现是
 *  "少一句提示"而不是界面上冒出一个 key 名。原文本来就在旁边, 少一句提示不致命。
 *
 *  **两个调用点**: 通道卡片 (ImageProviderSettings —— 一条通道上次失败的原因) 和聊天
 *  (canvex-workspace —— 这一轮为什么没回复)。同一套 code、同一份文案, 所以放在这儿而不是
 *  哪个组件里面。 */
export const diagText = (t: TFunction, code: string) =>
  code ? t(`imageProviders.diag.${code}`, { defaultValue: "" }) : "";
