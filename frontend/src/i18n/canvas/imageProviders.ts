export const imageProviders = {
  en: {
    title: "Image providers",
    subtitle:
      "Endpoint, key and request shape for image generation. Configured here, not in the backend env.",
    empty: "No providers yet. Paste a provider's example curl above, or add one by hand.",
    add: "Add provider",
    addModel: "Add model",
    models: "Models",
    modelCount: "{{n}} model(s)",
    labelPlaceholder: "Provider name, e.g. APIMart",
    modelLabelPlaceholder: "Display name",
    modelStringPlaceholder: "model string the provider wants",
    kind: "Channel type",
    kindImage: "Image generation (Image / Split)",
    kindAngle: "Camera angle re-render (Angle)",
    kindVideo: "Video generation (Video)",
    kindChat: "Chat agent LLM",
    kindHint: {
      image: "Shows up in the Image and Split pickers, and in the chat bar.",
      angle:
        "Shows up in the Angle picker only. The request body is the camera coordinates from the cube, so timeout is the only tunable here.",
      video:
        "Shows up in the Video picker only. Submit returns a task id which we then long-poll, so the tunables here are the timeouts and the poll schedule.",
      chat:
        "The model behind the chat box. It must support OpenAI-style tool calling — one that doesn't will reply with markdown and quietly do nothing on the canvas. Don't point it at your image key.",
    },
    baseUrl: "Base URL",
    baseUrlHint: {
      image:
        "Without the /images/generations suffix — Canvex appends it. Local model servers are fine, but the backend runs in a container: use host.docker.internal:11434, not localhost:11434.",
      angle:
        "Host only, e.g. https://fal.run — the model string is appended as the path. Put the full model id (fal-ai/…) in the model field below.",
      video:
        "Without the /videos/generations suffix — Canvex appends it, and polls {base}/videos/<task id>.",
      chat:
        "OpenAI-compatible chat completions endpoint. Leave blank for OpenAI's own.",
    },
    apiKey: "API key",
    apiKeyHint: "Stored as-is (local single-machine tool). It is never written to logs.",
    defaults: "Request parameters",
    defaultsHint:
      "Defaults for every model under this provider. Blank = use Canvex's own default. Individual models can override any of these.",
    overrides: "Overrides",
    overridesHint:
      "Only what differs from the provider defaults above. Blank = inherit.",
    save: "Save",
    saved: "Provider saved",
    deleted: "Provider deleted",
    delete: "Delete provider",
    confirmDeleteTitle: "Delete this provider?",
    confirmDelete:
      "This removes the provider and all of its models. Generations that used them keep their images, but lose the record of which model made them. This can't be undone.",
    unsaved: "unsaved changes",
    needLabelAndUrl: "Name and Base URL are required",
    saveBeforeTest: "Save first — testing runs against the stored config",
    testHint: "Send one real minimal generation with this model (costs one generation)",
    testOk: "Works — responded in {{s}}s",
    testFailed: "Test failed",
    curlImport: "Import from a curl example",
    curlHint:
      "Paste the example curl from your provider's docs. The request body's shape tells us which field carries the image and whether it takes one value or an array — the parts their docs never phrase in our terms.",
    curlOk: "Parsed — check the fields below",
    curlUnknown: "Parsed, but these body keys aren't ones we model: {{keys}}",
    parse: "Parse",
    parsing: "Parsing…",
    unset: "not set",
    dont_send: "don't send",
    field: {
      image_field: "field carrying the source image(s)",
      image_as_single: "send a single string instead of an array when n=1",
      response_format: "b64_json / url",
      quality: "quality, if the provider takes one",
      watermark: "not sent unless set explicitly",
      inline_image: "download source URLs and inline as base64",
      size_mode: "pixel = snap to the provider's legal pixel sizes",
      timeout: "request timeout (s)",
      poll_enabled: "provider returns a task id to poll",
      poll_url: "poll endpoint, blank = Base URL",
      poll_max_attempts: "max polls",
      poll_interval: "seconds between polls (first wait)",
      poll_max_interval: "backoff ceiling; blank/0 = fixed interval",
      poll_timeout: "per-poll timeout (s)",
    },
  },
  zh: {
    title: "生图供应商",
    subtitle: "生图的端点、密钥和请求形状。在这里配,不再改后端 env。",
    empty: "还没有配置供应商。可以在上方粘一段供应商文档里的示例 curl,或手动新建一个。",
    add: "新建供应商",
    addModel: "添加模型",
    models: "模型",
    modelCount: "{{n}} 个模型",
    labelPlaceholder: "供应商名称,如 APIMart",
    modelLabelPlaceholder: "显示名称",
    modelStringPlaceholder: "该供应商要的模型字符串",
    kind: "通道类型",
    kindImage: "生图 (Image / Split)",
    kindAngle: "视角重渲染 (Angle)",
    kindVideo: "视频生成 (Video)",
    kindChat: "聊天模型 (Chat)",
    kindHint: {
      image: "会出现在 Image、Split 两个选择器和聊天栏里。",
      angle:
        "只出现在 Angle 的选择器里。它的请求体是画布上那个立方体给的相机坐标,所以这里能调的只有超时。",
      video:
        "只出现在 Video 的选择器里。提交后拿到 task id 再长轮询,所以这里能调的是各种超时和轮询节奏。",
      chat:
        "聊天框背后的模型。它必须支持 OpenAI 风格的 tool calling —— 不支持的会回一段 markdown 然后画布上什么都不发生。别填生图那把 key。",
    },
    baseUrl: "Base URL",
    baseUrlHint: {
      image:
        "不要带 /images/generations 后缀,Canvex 会自己拼。可以填本机推理服务,但后端跑在容器里 —— 要用 host.docker.internal:11434,不是 localhost:11434。",
      angle:
        "只填域名,比如 https://fal.run —— 模型名会被拼成路径。完整模型 id (fal-ai/…) 填在下面的模型栏。",
      video:
        "不要带 /videos/generations 后缀,Canvex 会自己拼;轮询打的是 {base}/videos/<task id>。",
      chat:
        "OpenAI 兼容的 chat completions 端点。留空 = 用 OpenAI 官方的。",
    },
    apiKey: "API 密钥",
    apiKeyHint: "原样保存(本地单机工具)。不会写进日志。",
    defaults: "请求参数",
    defaultsHint:
      "这个供应商下所有模型的默认值。留空 = 用 Canvex 自己的默认。单个模型可以覆盖其中任意一项。",
    overrides: "覆盖项",
    overridesHint: "只填与上面供应商默认值不同的部分。留空 = 继承。",
    save: "保存",
    saved: "已保存",
    deleted: "已删除",
    delete: "删除供应商",
    confirmDeleteTitle: "删除这个供应商?",
    confirmDelete:
      "会连同它下面的所有模型一起删掉。已经生成的图还在,但会丢掉「这张图是哪个模型出的」这条记录。不可撤销。",
    unsaved: "有未保存的改动",
    needLabelAndUrl: "名称和 Base URL 必填",
    saveBeforeTest: "请先保存再测试 —— 测试打的是已保存的那份配置",
    testHint: "用这个模型真发一次最小生成(会消耗一次生成额度)",
    testOk: "通了 —— {{s}} 秒返回",
    testFailed: "测试失败",
    curlImport: "从 curl 示例导入",
    curlHint:
      "把供应商文档里的示例 curl 粘进来。请求体的形状能告诉我们哪个字段装图、是单值还是数组 —— 这些正是他们文档不会用我们的说法写出来的部分。",
    curlOk: "已解析,检查下面的字段",
    curlUnknown: "已解析,但这些请求体字段我们没有对应项:{{keys}}",
    parse: "解析",
    parsing: "解析中…",
    unset: "未设置",
    dont_send: "不下发",
    field: {
      image_field: "装源图的字段名",
      image_as_single: "n=1 时发单个字符串而不是数组",
      response_format: "b64_json / url",
      quality: "质量参数(供应商支持才填)",
      watermark: "不显式设置就不下发",
      inline_image: "把源图 URL 下载下来转 base64 内联",
      size_mode: "pixel = 归一到供应商的合法像素尺寸",
      timeout: "请求超时(秒)",
      poll_enabled: "供应商先返 task id 再轮询",
      poll_url: "轮询端点,留空 = Base URL",
      poll_max_attempts: "最多轮询几次",
      poll_interval: "轮询间隔(秒,首轮等待)",
      poll_max_interval: "退避上限;留空/0 = 固定间隔",
      poll_timeout: "单次轮询超时(秒)",
    },
  },
}

export const imageModels = {
  en: {
    title: "Image model",
    angleTitle: "Angle model",
    videoTitle: "Video model",
    pick: "Pick image model",
    /** 触发按钮上显示 —— 只有一个通道都没配时才会出现。 */
    none: "None",
    empty: "No models configured yet.",
    configure: "Configure providers…",
  },
  zh: {
    title: "生图模型",
    angleTitle: "视角模型",
    videoTitle: "视频模型",
    pick: "选择生图模型",
    none: "未配置",
    empty: "还没有配置任何模型。",
    configure: "配置供应商…",
  },
}
