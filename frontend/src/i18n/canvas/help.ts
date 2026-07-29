export const help = {
  en: {
    dialogTitle: "Canvex — Help & tips",
    dialogDescription:
      "A quick tour of the canvas: annotations, the AI toolbar, skills, and the basics.",
    annotate: {
      title: "Annotate to steer edits (boxes & arrows)",
      blurb:
        "Draw a box, arrow, or text label over an image to tell the AI exactly where to edit. Your marks are turned into coordinates in the prompt — the source image stays clean and the annotations never show up in the result.",
      steps: [
        "Select an image, draw a shape on top of it, then select both together (marquee or shift-click) — the toolbar switches to “image + shapes”.",
        "A box / ellipse marks a region; an arrow marks a single point at its tip; a text label near a shape is the instruction for that spot (e.g. box the logo + type “make this red”).",
        "Click the “TEXT” tile in the toolbar to preview the exact prompt (e.g. “top-right region (x≈60–90%): make this red”).",
        "Press Apply (wand) — the AI gets the clean original plus your region text. Or use Cutout / Split to target the subject you boxed.",
      ],
      tips: [
        "Rough boxes are fine — coordinates are coarse (a 3×3 grid word + a percentage span), so you don’t need pixel-perfect marks.",
        "Drag arrows FROM the label TOWARD the spot: the arrowhead end is what the model reads.",
      ],
    },
    toolbar: {
      title: "The AI toolbar",
      blurb:
        "Select any image on the canvas to get a floating toolbar — re-edit, cut out, split, animate, rotate, mock up, color-grade, merge, download, or send to chat, without typing into the chat box.",
      steps: [
        "Select an image — the toolbar appears below it. Pick a tab: Image / Video / Angle / Split / Merge / Mockup (tabs that don’t fit your selection grey out).",
        "On the Image tab, type a change, set aspect ratio · quality (1K / 2K / 4K) · count (×1 / ×2 / ×4), then press Apply.",
      ],
      list: {
        heading: "Modes",
        items: [
          "Image — edit / restyle by prompt. Cutout (scissors) = one-click transparent background.",
          "Split — two stacked results: a transparent subject + a clean subject-removed background.",
          "Angle — drag a 3D cube to re-render the shot from a new viewpoint (needs a pinned image).",
          "Video — describe the motion → a clip.",
          "Mockup — wrap a design onto the image via depth: set target → drop another image → Depth / Mask / Opacity.",
          "Merge — flatten the image + your marks into one PNG locally (no AI call).",
          "Single images also get Adjust (a Lightroom-style color panel), Send to chat, and Download.",
        ],
      },
      tips: ["Click a thumbnail tile on the left of the toolbar to preview exactly what the AI will receive."],
    },
    skills: {
      title: "Skills",
      blurb:
        "The sliders icon in the chat box lets you turn OFF a skill (a canned playbook the assistant follows) for just your next message, so it answers your request literally instead of running a workflow.",
      steps: [
        "Click the sliders icon → “Skills for this message”. Every skill is on by default; the assistant decides which one fits.",
        "Uncheck a skill to skip it for the next message only — your choice resets automatically after you send.",
      ],
      list: {
        heading: "Available skills",
        items: [
          "image-prompt-sop — rewrites a vague request into a high-quality prompt and auto-picks size + count for a single image.",
          "amazon-listing-pack-sop — turns one product photo into a 7-image Amazon set (main, infographic, angle, detail, 2 lifestyle, scale) generated in parallel.",
        ],
      },
      tips: ["The dot on the sliders icon means at least one skill is off this turn. The selector only disables skills — it never forces one."],
    },
    gettingStarted: {
      title: "Getting started",
      blurb:
        "Generate images and videos by describing them in the chat box, organize work into scenes, and reuse past assets from the media library.",
      steps: [
        "Click “New canvas”, give it a name, and a blank scene opens.",
        "Type into the chat box at the bottom to generate. A placeholder reserves the spot, then the result drops in (images take seconds; video 1–5 min). You can ask for up to 4 at once.",
        "Each row under SCENES is its own canvas; edits autosave. Pin a canvas to the top, rename, or delete via the ⋮ menu.",
        "Open “Media library” to browse everything you’ve made (grouped by canvas) and click a thumbnail to drop it into the current canvas.",
      ],
    },
  },
  zh: {
    dialogTitle: "Canvex — 帮助与技巧",
    dialogDescription: "快速了解画布：标注、AI 工具栏、技能以及基础操作。",
    annotate: {
      title: "用标注引导编辑（方框与箭头）",
      blurb:
        "在图片上画一个方框、箭头或文字标签，告诉 AI 具体在哪里编辑。你的标记会被转换成提示词中的坐标——源图保持干净，标注永远不会出现在结果里。",
      steps: [
        "选中一张图片，在上面画一个图形，然后把两者一起选中（框选或 Shift 点击）——工具栏会切换到“图片 + 图形”。",
        "方框 / 椭圆标记一个区域；箭头用其尖端标记一个点；图形旁的文字标签是该位置的指令（例如把 logo 框起来 + 输入“把这里变成红色”）。",
        "点击工具栏中的“TEXT”图块，预览准确的提示词（例如“右上区域（x≈60–90%）：把这里变成红色”）。",
        "按下应用（魔棒）——AI 会拿到干净的原图加上你的区域文字。或使用抠图 / 拆分来定位你框出的主体。",
      ],
      tips: [
        "方框画得粗略也没关系——坐标本身是粗粒度的（一个 3×3 网格词 + 一个百分比区间），所以不需要像素级精准的标记。",
        "把箭头从标签拖向目标位置：箭头尖端才是模型读取的部分。",
      ],
    },
    toolbar: {
      title: "AI 工具栏",
      blurb:
        "选中画布上的任意图片即可获得一个浮动工具栏——无需在聊天框里输入，就能重新编辑、抠图、拆分、生成动画、换视角、做样机、调色、合并、下载或发送到聊天。",
      steps: [
        "选中一张图片——工具栏会出现在它下方。挑选一个标签：图片 / 视频 / 换视角 / 拆分 / 合并 / 样机（不适用于当前选区的标签会变灰）。",
        "在“图片”标签下，输入要做的改动，设置宽高比 · 画质（1K / 2K / 4K）· 数量（×1 / ×2 / ×4），然后按下应用。",
      ],
      list: {
        heading: "模式",
        items: [
          "图片——按提示词编辑 / 重新风格化。抠图（剪刀）= 一键透明背景。",
          "拆分——两个堆叠的结果：一个透明主体 + 一个去除主体后的干净背景。",
          "换视角——拖动 3D 立方体，从新的视角重新渲染画面（需要一张已置顶的图片）。",
          "视频——描述运动 → 一段视频。",
          "样机——通过深度把一个设计贴到图片上：设置目标 → 放入另一张图片 → 深度 / 蒙版 / 不透明度。",
          "合并——在本地把图片 + 你的标记压平成一张 PNG（不调用 AI）。",
          "单张图片还可以使用调整（一个 Lightroom 风格的调色面板）、发送到聊天和下载。",
        ],
      },
      tips: ["点击工具栏左侧的缩略图块，预览 AI 将确切收到的内容。"],
    },
    skills: {
      title: "技能",
      blurb:
        "聊天框里的滑块图标可以让你仅针对下一条消息关闭某个技能（助手会遵循的一套既定流程），这样它就会按字面回应你的请求，而不是执行一套工作流。",
      steps: [
        "点击滑块图标 →“本条消息的技能”。每个技能默认开启；由助手决定哪个最合适。",
        "取消勾选某个技能，仅在下一条消息中跳过它——发送后你的选择会自动重置。",
      ],
      list: {
        heading: "可用技能",
        items: [
          "image-prompt-sop——把一个含糊的请求改写成高质量提示词，并为单张图片自动挑选尺寸 + 数量。",
          "amazon-listing-pack-sop——把一张产品照片变成一套 7 张图的亚马逊图集（主图、信息图、角度图、细节图、2 张场景图、比例图），并行生成。",
        ],
      },
      tips: ["滑块图标上的圆点表示本轮至少有一个技能被关闭。该选择器只能关闭技能——永远不会强制启用某个技能。"],
    },
    gettingStarted: {
      title: "快速上手",
      blurb:
        "在聊天框里描述图片和视频即可生成，把工作整理到不同画布中，并从素材库复用过往素材。",
      steps: [
        "点击“新建画布”，给它起个名字，一个空白画布就会打开。",
        "在底部的聊天框里输入即可生成。会先用占位符占住位置，随后结果落入其中（图片几秒；视频 1–5 分钟）。你一次最多可以请求 4 张。",
        "画布列表下的每一行都是它自己的画布；编辑会自动保存。可通过 ⋮ 菜单把画布置顶、重命名或删除。",
        "打开“素材库”，浏览你制作的全部内容（按画布分组），点击缩略图即可把它放入当前画布。",
      ],
    },
  },
}
