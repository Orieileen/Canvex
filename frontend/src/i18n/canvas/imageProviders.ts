/**
 * 通道配置面板的文案。
 *
 * **术语 (这三个词以前是混着用的)**:
 *   - **通道** = 界面上这个对象:一个端点 + 一把 key + 一套请求形状,下面挂几个模型。
 *   - **供应商** = 那家**公司** (tu-zi / APIMart / OpenAI)。同一家公司底下可以有好几条
 *     通道 —— 这个项目里就同时存在「tu-zi」和「自定义-兔子」两条,打的是同一家。
 *   - **模型** = 通道下面的一行。
 *
 * 混用的样子是:侧栏和标题叫「通道配置」,卡片上却写「新建供应商」「删除供应商」——
 * 同一个对象两个名字,而第二个名字还被那家公司占着,于是「供应商返回:…」这种报错到底
 * 在说哪一个就没法判断了。
 *
 * 后端的模型类仍然叫 `ImageProvider`:改类名要动迁移和整张表,而用户看不到类名。
 * 对应关系 —— `ImageProvider` = 界面上的通道,`ImageModel` = 界面上的模型。
 */
export const imageProviders = {
  en: {
    title: "Channels",
    subtitle:
      "Endpoint, key and request shape for every channel — image, angle, video and the chat model. Configured here, not in the backend env.",
    /** 一键预设。**按 preset.key 查** —— 后端加一条预设,这里补两行翻译即可;
     *  漏了只是标签难看(退回显示 key),不是按钮消失。 */
    presets: {
      tuzi_chat: {
        label: "Quick setup: LLM Agent Chat provider",
        hint: "api.tu-zi.com — powers the chat box and the agent",
      },
      apimart_image: {
        label: "Quick setup: image generation provider",
        hint: "api.apimart.ai — async; the request shape is already wired up",
      },
    },
    empty: "No channels yet. Paste a provider's example curl above, or add one by hand. The chat box needs a Chat channel before the agent will run.",
    add: "Add channel",
    addModel: "Add model",
    models: "Models",
    modelCount: "{{n}} model(s)",
    labelPlaceholder: "Channel name, e.g. APIMart images",
    modelLabelPlaceholder: "Display name",
    modelStringPlaceholder: "model string the provider wants",
    kind: "Channel type",
    kindImage: "Image generation",
    kindAngle: "Camera angle re-render",
    kindVideo: "Video generation",
    kindChat: "Chat model",
    kindCustom_image: "Image generation · custom template",
    kindCustom_video: "Video generation · custom template",
    template: "Request template",
    templateHint:
      "The whole request, as JSON. Placeholders below are substituted per generation; a key whose value resolves to empty is dropped entirely.",
    templateStarter: "Start from…",
    templateVars: "Available placeholders",
    templateInvalid: "Not valid JSON — check for a trailing comma or a missing quote.",
    templateFormat: "Reformat",
    kindHint: {
      image: "Shows up in the Image and Split pickers, and in the chat bar.",
      angle:
        "Shows up in the Angle picker only. The request body is the camera coordinates from the cube, so timeout is the only tunable here.",
      video:
        "Shows up in the Video picker only. Submit returns a task id which we then long-poll, so the tunables here are the timeouts and the poll schedule.",
      chat:
        "The model behind the chat box. It must support OpenAI-style tool calling — one that doesn't will reply with markdown and quietly do nothing on the canvas. Don't point it at your image key.",
      custom_image:
        "For providers the built-in Image channel can't express. You write the whole request — endpoint, headers, body, where the result is — so the fixed /images/generations path and Bearer auth stop being assumptions. Shows up in the same pickers as Image.",
      custom_video:
        "Same idea as custom image generation, for video. Submit-then-poll is written out in the template rather than guessed at.",
    },
    baseUrl: "Base URL",
    baseUrlHint: {
      custom_image:
        "Whatever {{base_url}} should expand to in your template. Canvex appends nothing — the full path is yours to write.",
      custom_video:
        "Whatever {{base_url}} should expand to in your template. Canvex appends nothing — the full path is yours to write.",
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
      "Defaults for every model under this channel. Blank = use Canvex's own default. Individual models can override any of these.",
    overrides: "Overrides",
    overridesHint:
      "Only what differs from the channel defaults above. Blank = inherit.",
    save: "Save",
    saved: "Channel saved",
    deleted: "Channel deleted",
    delete: "Delete channel",
    confirmDeleteTitle: "Delete this channel?",
    confirmDelete:
      "This removes the channel and all of its models. Generations that used them keep their images, but lose the record of which model made them. This can't be undone.",
    unsaved: "unsaved changes",
    needLabelAndUrl: "Name and Base URL are required",
    needLabel: "Name is required",
    saveBeforeTest: "Save first — testing runs against the stored config",
    testHint: "Send one real minimal generation with this model (costs one generation)",
    testOk: "Works — responded in {{s}}s",
    testFailed: "Test failed",
    healthOk: "Last call went through · {{when}}",
    healthError: "Last call failed · {{when}}",
    healthUnknown: "Never called yet",
    /** 诊断文案 —— 后端只回一个 code (backend services/channel_diagnosis.py), 话在这儿说。
     *  后端不回中文的理由: 那样英文界面上会冒出一句中文, 而且同一句话有了两个来源。
     *  每一句都必须是**能照做的一步**, 不是对报错的复述 —— 复述的活儿原文自己会干。 */
    diag: {
      quota:
        "Not a config problem — this key is out of credit. Top up with the provider; leave these settings alone.",
      auth:
        "The provider rejected this key. Check the API key is complete and still valid — and that it was issued by whoever this Base URL points at.",
      rate_limit:
        "Rate-limited, not a config problem. Wait a moment and try again, or ask the provider to raise your limit.",
      provider_down:
        "The provider itself errored (5xx) — not your config. Try again shortly; if it keeps happening, that provider is unstable right now.",
      endpoint:
        "No such endpoint. Base URL should stop at …/v1 — don't include /images/generations, Canvex appends that itself.",
      endpoint_template:
        "No such endpoint. Check the `url` in the request template, and how it joins onto the Base URL.",
      unreachable:
        "Couldn't reach that address. Check the Base URL's spelling, scheme (http/https) and port. It may also just be a network blip — try once more.",
      unreachable_local:
        "Couldn't reach that local address. The backend runs in a container, so localhost means the container itself — point local model servers at host.docker.internal instead.",
      timeout:
        "Connected, but the provider never answered. Raise the timeout (60–300s is normal for image generation). If this provider is async — it hands back a task id first — you need polling, not a longer timeout.",
      tls:
        "The TLS handshake failed — usually the network or a proxy, not your config. Try another network, or turn the proxy off.",
      ratio:
        "This model doesn't take that aspect ratio — but the message below lists the ones it does. Paste them into \"aspect ratios this model accepts\" and the toolbar will only offer those.",
      no_channel:
        "The aggregator has no route for this request — usually the model name isn't enabled for your account or group, occasionally the size tier isn't supported. Check the model name against their docs first; if it's right, check that model's access in their console. (Some aggregators report this as a 5xx, so don't read it as \"their server is down\".)",
      model:
        "The provider doesn't recognise this model name. Copy it verbatim from their docs (case and date suffixes count) — or your account may not have access to it yet.",
      bad_request:
        "The provider rejected the request. Which field it objected to is in the raw response below.",
    },
    unset: "not set",
    dont_send: "don't send",
    /** 旋钮分组。分组本身由后端下发 (services/image_channels.py 的 _TUNABLE_GROUPS),
     *  这里只管怎么念。 */
    group: {
      shape: "Request shape",
      timing: "Timeout",
      poll: "Async polling",
      other: "Other",
    },
    groupHint: {
      shape: "What shape this provider wants its requests in. Follow their docs; blank = Canvex's default.",
      timing: "How long one request may take before we give up. 60–300s is normal for image generation.",
      poll: "Only matters if this provider is async — it hands back a task id and you poll for the result. The defaults are usually fine unless you see \"polled N times and it still isn't done\".",
      other: "",
    },
    field: {
      image_field: "field carrying the source image(s)",
      image_as_single: "send a single string instead of an array when n=1",
      response_format: "b64_json / url",
      quality: "quality, if the provider takes one",
      watermark: "not sent unless set explicitly",
      inline_image: "download source URLs and inline as base64",
      size_mode: "pixel = snap to the provider's legal pixel sizes",
      allowed_ratios:
        "comma-separated, e.g. 16:9, 1:1, 4:3, 9:16, auto — blank means no limit. Models differ even within one provider, and the toolbar's ratio picker is trimmed to whatever you put here.",
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
    title: "通道配置",
    subtitle: "所有通道的端点、密钥和请求形状 —— 生图、视角、视频、聊天模型。在这里配,不再改后端 env。",
    presets: {
      tuzi_chat: {
        label: "快捷配置:llm Agent Chat 供应商",
        hint: "api.tu-zi.com —— 聊天框和 agent 都走它",
      },
      apimart_image: {
        label: "快捷配置:生图供应商",
        hint: "api.apimart.ai —— 异步通道,请求形状已经配好",
      },
    },
    empty: "还没有配置任何通道。可以在上方粘一段供应商文档里的示例 curl,或手动新建一个。聊天框要能用,得先加一条「聊天模型」通道。",
    add: "新建通道",
    addModel: "添加模型",
    models: "模型",
    modelCount: "{{n}} 个模型",
    labelPlaceholder: "通道名称,如 APIMart 生图",
    modelLabelPlaceholder: "显示名称",
    modelStringPlaceholder: "该供应商要的模型字符串",
    kind: "通道类型",
    kindImage: "图片生成",
    kindAngle: "视角重渲染",
    kindVideo: "视频生成",
    kindChat: "聊天模型",
    kindCustom_image: "图片生成 · 自定义模板",
    kindCustom_video: "视频生成 · 自定义模板",
    template: "请求模板",
    templateHint:
      "整个请求, 用 JSON 写。下面那些占位符会在每次生成时替换掉; 某个键的值解析出来是空的话, 这个键整个不下发。",
    templateStarter: "从模板开始…",
    templateVars: "可用的占位符",
    templateInvalid: "这不是合法的 JSON —— 检查一下多余的逗号或者少了的引号。",
    templateFormat: "格式化",
    kindHint: {
      image: "会出现在「图像」「拆分」两个选择器和聊天栏里。",
      angle:
        "只出现在「换视角」的选择器里。它的请求体是画布上那个立方体给的相机坐标,所以这里能调的只有超时。",
      video:
        "只出现在「视频」的选择器里。提交后拿到 task id 再长轮询,所以这里能调的是各种超时和轮询节奏。",
      chat:
        "聊天框背后的模型。它必须支持 OpenAI 风格的 tool calling —— 不支持的会回一段 markdown 然后画布上什么都不发生。别填生图那把 key。",
      custom_image:
        "给内置「图片生成」通道表达不了的供应商用。整个请求由你写 —— 端点、请求头、请求体、结果在哪一层,所以写死的 /images/generations 和 Bearer 认证不再是前提。它和「图片生成」出现在同一批选择器里。",
      custom_video:
        "跟自定义图片生成同一个思路,用于视频。「提交完再轮询」这套写在模板里,不再靠猜。",
    },
    baseUrl: "Base URL",
    baseUrlHint: {
      custom_image:
        "模板里 {{base_url}} 展开成什么就填什么。Canvex 不会再往后拼任何东西 —— 完整路径由你在模板里写。",
      custom_video:
        "模板里 {{base_url}} 展开成什么就填什么。Canvex 不会再往后拼任何东西 —— 完整路径由你在模板里写。",
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
      "这条通道下所有模型的默认值。留空 = 用 Canvex 自己的默认。单个模型可以覆盖其中任意一项。",
    overrides: "覆盖项",
    overridesHint: "只填与上面通道默认值不同的部分。留空 = 继承。",
    save: "保存",
    saved: "已保存",
    deleted: "已删除",
    delete: "删除通道",
    confirmDeleteTitle: "删除这条通道?",
    confirmDelete:
      "会连同它下面的所有模型一起删掉。已经生成的图还在,但会丢掉「这张图是哪个模型出的」这条记录。不可撤销。",
    unsaved: "有未保存的改动",
    needLabelAndUrl: "名称和 Base URL 必填",
    needLabel: "名称必填",
    saveBeforeTest: "请先保存再测试 —— 测试打的是已保存的那份配置",
    testHint: "用这个模型真发一次最小生成(会消耗一次生成额度)",
    testOk: "通了 —— {{s}} 秒返回",
    testFailed: "测试失败",
    healthOk: "上次调用通了 · {{when}}",
    healthError: "上次调用失败 · {{when}}",
    healthUnknown: "还没调用过",
    diag: {
      quota:
        "这不是配置问题 —— 这把 key 的额度用完了(或者欠费了)。去供应商后台充值,配置一个字都不用改。",
      auth:
        "供应商不认这把 key。检查 API 密钥有没有复制全、是不是过期了,以及它确实是这个 Base URL 那家发的。",
      rate_limit:
        "被限流了,不是配置问题。等一会儿再试,或者去供应商后台提额。",
      provider_down:
        "供应商自己出错了(5xx),不是你的配置。过一会儿再试;一直这样就是那家现在不稳。",
      endpoint:
        "这个端点不存在。Base URL 填到 …/v1 就够了,别带 /images/generations —— 那一段是我们自己拼的。",
      endpoint_template:
        "这个端点不存在。检查模板里的 `url`,以及它跟 Base URL 拼起来对不对。",
      unreachable:
        "连不上这个地址。检查 Base URL 的拼写、协议(http/https)和端口。也可能只是网络抖了一下,再点一次看看。",
      unreachable_local:
        "连不上这个本机地址。后端跑在容器里,localhost 指的是容器自己 —— 本机的推理服务要写 host.docker.internal。",
      timeout:
        "连上了,但对方一直没回。把「超时」调大(生图 60–300 秒都算正常)。如果这家是异步的(先回一个 task_id),那要配轮询,加超时没用。",
      tls:
        "TLS 握手失败 —— 通常是网络或代理的事,不是配置。换个网络、或者把代理关掉再试。",
      ratio:
        "这个模型不收这个比例 —— 但下面那段原文把它收的都列出来了。把它们填到「这个模型收哪几种比例」里,工具栏就只会给这些。",
      no_channel:
        "聚合商说这个请求没有可用渠道 —— 通常是这个模型名在你的账号/分组下没开通,偶尔是这个尺寸档它不支持。先照文档核对模型名;确认没错就去供应商后台看这个模型的权限。(有的聚合商把这种情况报成 5xx,别当成\"人家服务器挂了\"。)",
      model:
        "供应商不认这个模型名。照它文档里的写法原样填(大小写、日期后缀都算);也可能是你的账号还没开通这个模型。",
      bad_request:
        "供应商说这次请求有问题,具体是哪个字段写在下面那段原文里。",
    },
    unset: "未设置",
    dont_send: "不下发",
    group: {
      shape: "请求形状",
      timing: "超时",
      poll: "异步轮询",
      other: "其它",
    },
    groupHint: {
      shape: "这家要什么格式的请求。照供应商文档填,留空 = 用 Canvex 自己的默认。",
      timing: "一次请求最多等多久就放弃。生图 60–300 秒都算正常。",
      poll: "只有这家是异步的才用得上 —— 先回一个 task id,再让你去查结果。默认值一般够用,除非报「轮询了 N 次还没完成」。",
      other: "",
    },
    field: {
      image_field: "装源图的字段名",
      image_as_single: "n=1 时发单个字符串而不是数组",
      response_format: "b64_json / url",
      quality: "质量参数(供应商支持才填)",
      watermark: "不显式设置就不下发",
      inline_image: "把源图 URL 下载下来转 base64 内联",
      size_mode: "pixel = 归一到供应商的合法像素尺寸",
      allowed_ratios:
        "逗号分隔,如 16:9, 1:1, 4:3, 9:16, auto —— 留空 = 不限制。同一家的不同模型收的比例都不一样;填了之后工具栏的比例选择器只列这些。",
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
    configure: "Channel settings…",
  },
  zh: {
    title: "生图模型",
    angleTitle: "视角模型",
    videoTitle: "视频模型",
    pick: "选择生图模型",
    none: "未配置",
    empty: "还没有配置任何模型。",
    configure: "通道配置…",
  },
}
