export const skills = {
  en: {
    // ── SkillSelector (per-message opt-out popover) ──────────────────────────
    configureAriaLabel: "Configure skills",
    header: "Skills for this message",
    hint: "Uncheck to skip a skill for the next message only.",
    manage: "Manage skills…",

    // ── SkillLibrary (install / uninstall panel) ─────────────────────────────
    libraryTitle: "Skills",
    librarySubtitle:
      "SOPs the assistant can load on its own. Drop in a SKILL.md to add one.",
    dropTitle: "Drop a .md file here",
    dropHint: "or click to choose — SKILL.md files, up to {{limit}} KB each",
    dropActive: "Release to install",
    empty: "No skills installed.",
    builtin: "Built-in",
    installed: "Installed",
    disabled: "Disabled",
    enable: "Enable",
    disable: "Disable",
    edit: "Edit",
    save: "Save",
    saving: "Saving…",
    delete: "Delete",
    copyAsMine: "Copy as mine",
    copyHint:
      "Built-in skills can't be edited. This puts a copy in the editor — change `name` in the frontmatter, then install it.",
    newSkill: "Write one instead",
    newPlaceholder:
      "---\nname: my-skill\ndescription: When the assistant should use this — one or two sentences, this is all it sees before deciding.\n---\n\n# my-skill\n\n## When to use\n\n…",
    installed_toast: "Installed {{name}}",
    updated: "Updated {{name}}",
    removed: "Removed {{name}}",
    enabledToast: "{{name}} is on",
    disabledToast: "{{name}} is off",
    notMarkdown: "{{file}} isn't a .md file — skipped.",
    /* 后端拒绝一篇 SKILL.md 时的说明。后端只回一个 `code` 加几个参数, 完整的话在这里 ——
       它自己带的那句英文是给 curl / 日志看的开发者视角摘要, 不是给用户读的。
       key 必须跟 backend/studio/services/agent/skill_md.py 的 code 一一对应。 */
    errors: {
      empty: "That file is empty.",
      too_big:
        "That file is {{size_kb}} KB, over the {{limit_kb}} KB limit. A SKILL.md is read into the assistant's context in full, so an oversized one would blow the context window.",
      no_frontmatter:
        "No YAML frontmatter at the top. A SKILL.md has to start with `---` on its own line, then `name` and `description`, then `---` on its own line again.",
      yaml_error: "The frontmatter isn't valid YAML:\n{{reason}}",
      frontmatter_not_mapping:
        "The frontmatter has to be `key: value` pairs — this parsed as something else.",
      name_missing: "The frontmatter is missing `name`. That's the skill's identifier.",
      name_invalid:
        "`name: {{name}}` isn't valid — {{reason}}. Use lowercase letters, digits and single hyphens, and don't start or end with a hyphen.",
      description_missing:
        "The frontmatter is missing `description`. The assistant decides whether to use a skill from that line alone, so an empty one never fires.",
      description_too_long:
        "`description` is {{length}} characters, over the {{limit}} limit. Anything past the limit is silently dropped — so the assistant wouldn't see it when deciding whether to use this skill. Shorten it yourself.",
      rejected_by_deepagents:
        "deepagents couldn't parse this SKILL.md. Check the frontmatter fields other than name and description (allowed-tools / metadata / license).",
      builtin_readonly:
        "`{{name}}` is built in, so its text can't be edited — there'd be no way back if it broke. Use \u201cCopy as mine\u201d and edit that instead, then disable the built-in one.",
      builtin_name_taken: "`{{name}}` is a built-in skill's name. Give yours a different `name`.",
      name_conflict: "A skill called `{{name}}` is already installed.",
      builtin_undeletable:
        "`{{name}}` is built in, so it can't be deleted — it ships with the codebase and would come back on the next rebuild. Disabling it does the same job.",
    },
    tooBig: "{{file}} is over {{limit}} KB — skipped.",
    readFailed: "Couldn't read {{file}} — skipped.",
    // Name collision: backend found an existing skill with the same frontmatter name.
    overwriteTitle: "Replace {{name}}?",
    overwriteBody:
      "A skill called {{name}} is already installed. Installing this file replaces its contents.",
    overwrite: "Replace",
    deleteTitle: "Delete {{name}}?",
    deleteBody: "The assistant loses this SOP immediately. This can't be undone.",
  },
  zh: {
    // ── SkillSelector (单条消息的跳过) ────────────────────────────────────────
    configureAriaLabel: "配置技能",
    header: "本条消息使用的技能",
    hint: "取消勾选即可仅在下一条消息中跳过该技能。",
    manage: "管理技能…",

    // ── SkillLibrary (装 / 卸) ───────────────────────────────────────────────
    libraryTitle: "技能库",
    librarySubtitle: "助手会自己判断要不要用的 SOP。拖一个 SKILL.md 进来就装上了。",
    dropTitle: "把 .md 文件拖到这里",
    dropHint: "或点击选择 —— SKILL.md 文件, 单个不超过 {{limit}} KB",
    dropActive: "松手就装上",
    empty: "还没有装任何技能。",
    builtin: "内置",
    installed: "已装",
    disabled: "已停用",
    enable: "启用",
    disable: "停用",
    edit: "编辑",
    save: "保存",
    saving: "保存中…",
    delete: "删除",
    copyAsMine: "复制为我的",
    copyHint:
      "内置技能的正文改不了。这会把它复制到编辑器里 —— 改掉 frontmatter 里的 `name` 再装上。",
    newSkill: "直接写一个",
    newPlaceholder:
      "---\nname: my-skill\ndescription: 什么时候该用这个技能 —— 一两句话。助手在决定要不要读全文之前, 只看得见这一段。\n---\n\n# my-skill\n\n## 什么时候用\n\n…",
    installed_toast: "装上了 {{name}}",
    updated: "已更新 {{name}}",
    removed: "已删除 {{name}}",
    enabledToast: "{{name}} 已启用",
    disabledToast: "{{name}} 已停用",
    notMarkdown: "{{file}} 不是 .md 文件, 跳过了。",
    errors: {
      empty: "文件是空的。",
      too_big:
        "文件 {{size_kb}} KB, 超过 {{limit_kb}} KB 上限。SKILL.md 会被整篇读进助手的上下文, 太长会直接撑爆。",
      no_frontmatter:
        "开头没有 YAML frontmatter。SKILL.md 必须以 `---` 单独一行开始, 写上 name 和 description, 再用 `---` 单独一行结束。",
      yaml_error: "frontmatter 的 YAML 语法有问题:\n{{reason}}",
      frontmatter_not_mapping: "frontmatter 得是 `键: 值` 的形式, 现在解析出来不是。",
      name_missing: "frontmatter 里缺 `name`。它同时是这个技能的唯一标识。",
      name_invalid:
        "`name: {{name}}` 不合规范 —— {{reason}}。只能用小写字母、数字和单个连字符, 不能以连字符开头或结尾。",
      description_missing:
        "frontmatter 里缺 `description`。助手全靠这一段判断什么时候该用这个技能, 空着等于装了也不会触发。",
      description_too_long:
        "`description` {{length}} 字, 超过上限 {{limit}} 字。超出的部分会被悄悄截掉, 助手判断要不要用这个技能时就看不到了 —— 请自己先压缩。",
      rejected_by_deepagents:
        "deepagents 解析这篇 SKILL.md 失败了。检查 frontmatter 里除 name / description 之外的字段 (allowed-tools / metadata / license) 写法。",
      builtin_readonly:
        "`{{name}}` 是内置技能, 正文改不了 —— 改坏了没法还原。用「复制为我的」拷一份出来改, 再把内置这条停用。",
      builtin_name_taken: "`{{name}}` 是内置技能的名字, 占用了。给你这篇换个 `name` 吧。",
      name_conflict: "已经装了一个叫 `{{name}}` 的技能。",
      builtin_undeletable:
        "`{{name}}` 是内置技能, 删不掉 —— 它随代码库发, 重建容器又会回来。停用它就行, 效果一样。",
    },
    tooBig: "{{file}} 超过 {{limit}} KB, 跳过了。",
    readFailed: "{{file}} 读不出来, 跳过了。",
    overwriteTitle: "覆盖 {{name}}?",
    overwriteBody: "已经装了一个叫 {{name}} 的技能。装这个文件会把它的正文换掉。",
    overwrite: "覆盖",
    deleteTitle: "删除 {{name}}?",
    deleteBody: "助手会立刻失去这份 SOP。删了没法撤销。",
  },
}
