/** Parse a deepagents `tool_call` stream event into a skill slug, if it's a
 *  SkillsMiddleware skill-load (`read_file` of a canonical `SKILL.md` path).
 *
 *  Background: SkillsMiddleware uses progressive disclosure — it injects skill
 *  names + descriptions + paths into the system prompt, and the agent calls
 *  `read_file(file_path="/skills/<slug>/SKILL.md")` to pull a SOP when it
 *  matches user intent. We detect that exact call shape and surface the slug
 *  to the UI; everything else (skill assets, other tools) falls through.
 *
 *  Path argument key: deepagents' `read_file` tool schema names it `file_path`
 *  (the `path` arg belongs to the `ls` tool). We accept either for forward
 *  compatibility in case the schema changes.
 */

const SKILL_READ_PATTERN = /^\/skills\/([^/]+)\/SKILL\.md$/;

export function skillSlugFromToolCall(
  name: string,
  args: Record<string, unknown>,
): string | null {
  if (name !== "read_file") return null;
  const raw = args.file_path ?? args.path;
  const path = typeof raw === "string" ? raw : "";
  return SKILL_READ_PATTERN.exec(path)?.[1] ?? null;
}

/** Coerce an LLM-supplied tool_call arg to a non-negative integer.
 *
 *  Why this exists: gpt-4o-mini occasionally serializes integer args as JSON
 *  strings ("0" instead of 0). `typeof === "number"` alone rejects the string
 *  path; using `parseInt` alone accepts garbage like "0xyz". This helper
 *  handles both shapes and rejects NaN / float / negative — the only call
 *  sites are layout indices and counts where non-negative integer is required.
 *
 *  Used by:
 *   - CanvasWorkspacePage tool_call handler (slot_index from listing-pack agent calls)
 *   - useCanvasPinning pack-mode defense-in-depth re-validation
 */
export function toolArgAsNonNegInt(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) {
    return raw;
  }
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

/** Coerce an LLM-supplied tool_call arg to a non-empty string, else undefined.
 *
 *  Sibling of `toolArgAsNonNegInt` — keeps all tool_call arg coercion in one
 *  tested place. Treats "" the same as absent: callers want a real value or
 *  nothing (an empty `size`/`resolution` falls back to defaults; an empty
 *  `label` means "no label").
 *
 *  Used by the CanvasWorkspacePage tool_call handler for `label` / `size` /
 *  `resolution` args.
 */
export function toolArgAsString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw ? raw : undefined;
}
