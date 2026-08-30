export const wizard = {
  en: {
  start: "Set up from a curl example",
  title: "New channel from curl",
  step: { paste: "1 / 3 · paste", probe: "2 / 3 · try it", poll: "3 / 3 · polling",
          confirm: "2 / 2 · check", done: "done" },
  /** 建哪种通道的短标签。**只在向导的选择行上用** —— 卡片上的徽标是完整名字
   *  (imageProviders.kindCustom_image), 那里放得下, 这里放不下。 */
  kindShort: { custom_image: "Image", custom_video: "Video", chat: "Chat", angle: "Angle" },
  /** 聊天 / 换视角那条短路上的一句话 —— 说清楚"为什么只问这三样就够了"。 */
  confirmHint: {
    chat: "A chat channel only needs these three — the request shape is fixed, so there is no template to fill in. It must be a key that supports OpenAI-style tool calling.",
    angle: "The Angle channel only needs these three — the request body is the camera coordinates from the cube, not something you configure.",
  },
  /** 默认名字里那个词: 「apimart images」。见 ChannelWizard 的 channelName。 */
  nameFor: { custom_image: "images", custom_video: "video", chat: "chat", angle: "angle" },
  pasteHint: {
    chat: "Paste any chat-completions curl for this provider — we only take the endpoint, the key and the model name out of it.",
    angle: "Paste any curl for this provider — we only take the endpoint, the key and the model name out of it.",
    custom_image:
      "Paste the image-generation curl from your provider's docs. We turn it into the request; the response half we work out by actually running it.",
    custom_video:
      "Paste the video-generation curl from your provider's docs. Video is almost always async, so expect a second paste — the curl that checks on a task.",
  },
  parse: "Read it",
  model: "Model",
  mappingTitle: "What each field is",
  mappingHint:
    "Guessed from the key name and the shape of the example value — fix any row that's wrong. Anything left as \"fixed value\" is sent to the provider as-is.",
  varFixed: "fixed value",
  var: {
    prompt: "prompt", model: "model name", n: "image count",
    size: "size (pixels)", aspect_ratio: "size (ratio)",
    width: "width", height: "height", resolution: "quality tier",
    image: "source image (one)", images: "source images (array)",
    image_base64: "source image (downloaded, base64)",
    images_base64: "source images (downloaded, base64)",
    duration: "duration",
  },
  probe: "Try it once",
  probeCost: "sends a real request — costs one generation",
  noImage:
    "The response came back but there is no image in it and it doesn't look like a task either. Check the model name, or open the advanced JSON editor.",
  isAsync:
    "This provider is asynchronous — it returned a task ({{taskId}}) instead of an image. That isn't visible in the docs; the example curl looks the same either way. Paste the curl that queries a task and we'll finish the rest.",
  pollParsed: "Got it — now let's watch that task until the image appears.",
  runPoll: "Watch until it's done",
  polling: "Check {{n}} — still running (status: {{status}})…",
  pollNote: "can take a few minutes",
  pollGaveUp: "Gave up waiting. The task may just be slow — you can raise the poll settings later.",
  foundTitle: "Found the image here",
  create: "Create the channel",
  },
  zh: {
  start: "从一段 curl 开始配",
  title: "从 curl 新建通道",
  step: { paste: "1 / 3 · 粘贴", probe: "2 / 3 · 试跑", poll: "3 / 3 · 轮询",
          confirm: "2 / 2 · 确认", done: "完成" },
  kindShort: { custom_image: "图片", custom_video: "视频", chat: "聊天", angle: "换视角" },
  confirmHint: {
    chat: "聊天通道只要这三样 —— 请求形状是固定的,没有模板要填。这把 key 必须支持 OpenAI 那套工具调用。",
    angle: "换视角通道只要这三样 —— 请求体是方块上的相机坐标,不是要你配的东西。",
  },
  nameFor: { custom_image: "生图", custom_video: "视频", chat: "聊天", angle: "换视角" },
  pasteHint: {
    chat: "把这家任意一段 chat 的 curl 粘进来 —— 我们只从里面取端点、key 和模型名三样。",
    angle: "把这家任意一段 curl 粘进来 —— 我们只从里面取端点、key 和模型名三样。",
    custom_image:
      "把供应商文档里那段生图的 curl 粘进来。请求那一半从它来;响应那一半靠真跑一次问出来。",
    custom_video:
      "把供应商文档里那段生视频的 curl 粘进来。视频基本都是异步的,所以八成还要再粘一段 —— 查询任务的那个 curl。",
  },
  parse: "读一下",
  model: "模型",
  mappingTitle: "每个字段是什么",
  mappingHint:
    "按键名和示例值的形状猜的 —— 猜错的那行直接改。留成「固定值」的会原样发给供应商。",
  varFixed: "固定值",
  var: {
    prompt: "提示词", model: "模型名", n: "张数",
    size: "尺寸(像素)", aspect_ratio: "尺寸(比例)",
    width: "宽", height: "高", resolution: "画质档位",
    image: "源图(单张)", images: "源图(数组)",
    image_base64: "源图(下载后 base64)",
    images_base64: "源图(下载后 base64,数组)",
    duration: "时长",
  },
  probe: "试跑一次",
  probeCost: "会真发一次请求,消耗一次生成额度",
  noImage:
    "回包收到了,但里面既没有图、也不像一张任务受理单。检查一下模型名,或者打开下面的高级 JSON 编辑器手动调。",
  isAsync:
    "这家是异步的 —— 它回的是一张任务受理单({{taskId}})而不是图。这件事文档里看不出来,异步和同步供应商的示例 curl 长得一模一样。把查询任务的那段 curl 粘进来,剩下的我们来补。",
  pollParsed: "读到了 —— 接下来盯着这个任务直到出图。",
  runPoll: "盯到出图",
  polling: "第 {{n}} 次查 —— 还在跑(状态:{{status}})…",
  pollNote: "可能要几分钟",
  pollGaveUp: "等太久放弃了。任务可能只是慢,轮询参数以后可以调大。",
  foundTitle: "图在这个位置",
  create: "创建通道",
  },
}
