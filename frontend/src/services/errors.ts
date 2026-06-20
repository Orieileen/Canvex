import { isAxiosError } from "axios";

/** DRF 字段错误的值可能是字符串或字符串数组, 取第一条可读消息。 */
function firstMessage(val: unknown): string | null {
  if (typeof val === "string") return val;
  if (Array.isArray(val) && typeof val[0] === "string") return val[0];
  return null;
}

export interface ParsedApiError {
  /** 字段名 → 该字段第一条错误 (表单内联展示用)。 */
  fields: Record<string, string>;
  /** 一条汇总消息 (toast 用): detail / non_field_errors / 第一个字段错误 / fallback。 */
  summary: string;
}

/**
 * 把 DRF 400 响应拆成「逐字段错误 + 一条汇总」, 让表单能在对应字段下内联提示, 用户一眼知道
 * 哪填错了。支持的形态:
 *   { detail: "..." }
 *   { non_field_errors: ["..."] }
 *   { name: ["..."], schema_template: "..." }   // 字符串或数组都接
 */
export function parseApiErrors(err: unknown, fallback: string): ParsedApiError {
  const data = isAxiosError(err) ? err.response?.data : undefined;
  if (!data || typeof data !== "object") return { fields: {}, summary: fallback };

  const fields: Record<string, string> = {};
  let summary = "";
  for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
    const msg = firstMessage(val);
    if (!msg) continue;
    if (key !== "detail" && key !== "non_field_errors") fields[key] = msg;
    if (!summary) summary = msg;  // detail / non_field_errors / 第一个字段错误, 谁先到用谁
  }
  return { fields, summary: summary || fallback };
}

/** 从错误响应里取第一条可读消息 (无字段定位需求时用)。 */
export function extractApiError(err: unknown, fallback: string): string {
  return parseApiErrors(err, fallback).summary;
}
