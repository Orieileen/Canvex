export const workspace = {
  en: {
    loading: "Loading…",
    backToLatest: "Back to latest",
    toggleMinimap: "Toggle minimap",
    emptyState: "Select a canvas from the sidebar, or create a new one to get started.",
    saveStatus: {
      pending: "Unsaved changes…",
      saving: "Saving…",
      saved: "Saved",
      error: "Save failed",
    },
    status: {
      replied: "Replied",
      replyFailed: "Reply failed",
    },
    kindNames: { image: "image", video: "video", angle: "angle" },
    placeholder: {
      generating: "Generating {{kind}}…",
    },
    toast: {
      generationFailed: "{{kind}} generation failed: {{reason}}",
      jobPollingFailed: "{{kind}} job polling failed",
      attachFailed: "Failed to attach image",
      loadImageFailed: "Failed to load image",
      chatFailed: "Chat failed",
    },
    tombstone: {
      pollingFailed: "polling failed",
      jobIdMissing: "job id missing from tool result",
      streamEnded: "stream ended before result",
    },
    error: {
      loadFailed: "Failed to load canvas",
      notFound: "Canvas not found",
    },
  },
  zh: {
    loading: "加载中…",
    backToLatest: "回到最新",
    toggleMinimap: "切换小地图",
    emptyState: "从侧栏选择一个画布，或新建一个开始使用。",
    saveStatus: {
      pending: "有未保存的更改…",
      saving: "保存中…",
      saved: "已保存",
      error: "保存失败",
    },
    status: {
      replied: "已回复",
      replyFailed: "回复失败",
    },
    kindNames: { image: "图片", video: "视频", angle: "视角图" },
    placeholder: {
      generating: "正在生成 {{kind}}…",
    },
    toast: {
      generationFailed: "{{kind}} 生成失败：{{reason}}",
      jobPollingFailed: "{{kind}} 任务轮询失败",
      attachFailed: "图片添加失败",
      loadImageFailed: "图片加载失败",
      chatFailed: "对话失败",
    },
    tombstone: {
      pollingFailed: "轮询失败",
      jobIdMissing: "工具结果中缺少任务 ID",
      streamEnded: "在收到结果前流已结束",
    },
    error: {
      loadFailed: "画布加载失败",
      notFound: "未找到画布",
    },
  },
}
