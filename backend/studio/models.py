from __future__ import annotations

import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

from django.core.exceptions import ValidationError
from django.db import models


# ─────────────────────────────── 上传路径 ───────────────────────────────

def library_upload_to(instance, filename: str) -> str:
    ext = Path(filename).suffix.lower()
    now = datetime.utcnow()
    return f"library/{now:%Y/%m/%d}/{uuid.uuid4().hex}{ext}"


def canvas_edit_upload_to(instance, filename: str) -> str:
    """image-edit 源图。meired 用 UserDatedUploadPath(按 user 隔离);Canvex 单工作区
    无 user,退化为纯 date 路径。"""
    ext = Path(filename).suffix.lower()
    now = datetime.utcnow()
    return f"canvas/edits/{now:%Y/%m/%d}/{uuid.uuid4().hex}{ext}"


def canvas_edit_intermediate_upload_to(instance, filename: str) -> str:
    """cutout 两段流水 stage1 的白底中间图。"""
    ext = Path(filename).suffix.lower()
    now = datetime.utcnow()
    return f"canvas/edits/intermediate/{now:%Y/%m/%d}/{uuid.uuid4().hex}{ext}"


# ─────────────────────────── 供应商端点校验 ───────────────────────────

def validate_endpoint_url(value: str) -> None:
    """供应商 base_url 的校验: 只要求是一个能发出请求的 http(s) 地址。

    刻意**不用** django 的 URLValidator —— 它只特例了 `localhost`, 别的单段主机名一律
    判非法, 而 compose 里另一个容器的地址正好是单段的 (`http://ollama:11434`)。这个项目
    是自部署工具, 接本机 / 同网段的推理服务是主线场景, 不是要防的东西。

    空串直接放行: 聊天通道留空 = 走 OpenAI 官方端点 (builder 里
    `channel.base_url or None` 就是这个语义, 迁移 0015 导进来的那条存的也是空串)。
    「哪些 kind 允许留空」是 ImageProviderSerializer.validate 的事, 不是这里 ——
    这个校验器只回答"填了的话是不是一个能发出请求的地址"。
    """
    if not (value or "").strip():
        return
    try:
        # 两处都会抛 ValueError, 都得接住, 否则一个手滑的输入变成 500:
        #   - urlsplit 本身 —— 方括号不配对的 IPv6 (`http://[::1`)
        #   - .port —— 端口非数字 / 越界, 要到取值时才验
        # 顺带用 hostname 而不是 netloc: `http://:8080` 的 netloc 非空但 hostname 是
        # None, 只看 netloc 会放它进库, 直到发请求时才炸成 requests.InvalidURL。
        parts = urlsplit((value or "").strip())
        host, _port = parts.hostname, parts.port
    except ValueError as exc:
        raise ValidationError("这个地址解析不了, 检查一下主机名和端口") from exc
    if parts.scheme not in ("http", "https") or not host:
        raise ValidationError("请填一个 http:// 或 https:// 开头的地址")


# ─────────────────────────── 素材库(Canvex 自有,保留)───────────────────────────
# meired 用独立 apps/library 的 Asset/Folder;Canvex 决策复用自己的 DataAsset/DataFolder
# 作为 canvas 结果与附件的存储层(见 services/agent/tools 的落库适配)。

class DataFolder(models.Model):
    """表示素材库中的文件夹节点，支持层级嵌套。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=255)
    parent = models.ForeignKey(
        "self",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="children",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]
        unique_together = (("parent", "name"),)

    def __str__(self) -> str:
        return self.name

    def clean(self):
        node = self.parent
        while node is not None:
            if node.id == self.id:
                raise ValidationError("Cannot move folder into its own descendant")
            node = node.parent


class DataAsset(models.Model):
    """表示素材库中的单个文件资源及其元数据。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    folder = models.ForeignKey(DataFolder, on_delete=models.CASCADE, null=True, blank=True, related_name="assets")
    file = models.ImageField(upload_to=library_upload_to)
    filename = models.CharField(max_length=255)
    mime_type = models.CharField(max_length=100, blank=True)
    size_bytes = models.BigIntegerField(default=0)
    checksum_sha256 = models.CharField(max_length=64, blank=True)
    width = models.IntegerField(null=True, blank=True)
    height = models.IntegerField(null=True, blank=True)
    alt_text = models.CharField(max_length=255, blank=True)
    tags = models.JSONField(default=list, blank=True)
    is_public = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        unique_together = (("folder", "filename"),)

    def __str__(self) -> str:
        return self.filename


# ─────────────────────── Canvas(从 meired apps/canvas port)───────────────────────
# 已剥:organization / user FK(单工作区)、credit_event(无计费)。
# asset FK 指向上面的 DataAsset(非 meired 的 library.Asset)。

class Scene(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    title = models.CharField(max_length=255, blank=True)
    data = models.JSONField(default=dict, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "canvas_scenes"
        verbose_name = "Canvas Scene"
        verbose_name_plural = "Canvas Scenes"
        ordering = ["-updated_at"]

    def __str__(self):
        return self.title or f"Scene {self.id}"


class ChatMessage(models.Model):
    class Role(models.TextChoices):
        USER = "user", "User"
        ASSISTANT = "assistant", "Assistant"
        SYSTEM = "system", "System"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    scene = models.ForeignKey(Scene, on_delete=models.CASCADE, related_name="chat_messages")
    role = models.CharField(max_length=16, choices=Role.choices)
    content = models.TextField()

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "canvas_chat_messages"
        verbose_name = "Canvas Chat Message"
        verbose_name_plural = "Canvas Chat Messages"
        ordering = ["created_at"]
        indexes = [
            models.Index(fields=["scene", "created_at"], name="canvas_chat_scene_ts_idx"),
        ]

    def __str__(self):
        return f"{self.role}: {self.content[:40]}"


class ImageProvider(models.Model):
    """一个生图供应商端点 —— 用户在前端配的「一把 key + 一个 base_url + 一套请求参数」。

    存在的理由: 生图参数以前只能写在后端 env 里, 固定两条通道 (PRIMARY / FALLBACK),
    只有部署者能改。用户想这张图用 Google、下张用豆包就做不到。现在通道进库、由前端配。

    `defaults` 是那 16 个请求参数的默认值; 具体某个模型可以在 ImageModel.overrides 里
    覆盖任意一项 —— 同一把聚合商 key 下面挂的豆包和 Google 就需要不同的 size_mode。
    键名与 ImageChannel 的字段名一致 (image_field / poll_enabled / …), 解析时直接展开。

    api_key 明文存储: 这是本地单机开源项目, 加密密钥只能放 env、和库在同一台机器同一个
    人手里, 加了等于没加, 却要付一个"加密密钥必须存在"的 env 依赖。只要求它不要进日志
    和错误响应 —— 用户会把报错贴到 GitHub issue 求助。
    """

    class Kind(models.TextChoices):
        # 通用生图接口 ({base_url}/images/generations, Bearer 认证)。Image / Split 用。
        IMAGE = "image", "Image generation"
        # fal.run 的视角重渲染 —— 模型名在 URL 路径里、认证是 `Key`、请求体是相机
        # 坐标而不是自由 prompt。Angle tab 用。
        ANGLE = "angle", "Camera angle re-render"
        # 文/图生视频 ({base_url}/videos/generations 提交 → 拿 task_id → 长轮询)。
        # 请求体由 video.py 自己拼, 所以它只读连接超时 + 那套轮询参数。Video tab 用。
        VIDEO = "video", "Video generation"
        # 聊天 agent 的 LLM (OpenAI 兼容 chat completions)。**必须支持 tools 参数** ——
        # 不支持的代理会静默忽略 tools、回一段 markdown 而不是 tool_call, 于是画布上
        # 什么都不会发生。所以它跟生图那把 key 刻意分开, 别指同一个聚合商端点。
        CHAT = "chat", "Chat agent LLM"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    label = models.CharField(max_length=100)
    # 供应商的接口形状。同一张表装两种形状而不是各开一张: 两边真正需要的字段
    # (label / base_url / api_key + 挂在下面的模型行) 完全重合, 差别只在请求怎么拼,
    # 那是 kind 一个字段能表达的事。前端据此决定显不显示那 13 个生图参数。
    kind = models.CharField(
        max_length=16, choices=Kind.choices, default=Kind.IMAGE, db_index=True,
    )
    # 允许私有地址 (http://host.docker.internal:11434 这类本机推理服务) —— 不做 SSRF
    # 公网校验, 那会把"接本地模型"这个自部署项目最有价值的场景整个砍掉。
    #
    # CharField + 自己的校验器而不是 URLField: django 的 URLValidator 只特例了
    # `localhost`, 任何**单段主机名**都被判非法 —— 而 compose 里另一个容器的地址正是
    # 单段的 (`http://ollama:11434` / `http://comfyui:8188`)。用 URLField 会把这次改造
    # 最想支持的那个场景挡在"请输入合法的 URL"后面。
    #
    # blank=True 只是为了聊天通道: 留空 = 走 OpenAI 官方端点 (builder 里
    # `channel.base_url or None`, 迁移 0015 存的就是空串)。其余 kind 必填 ——
    # 那一条在 ImageProviderSerializer.validate 里按 kind 判, 因为字段级校验看不到 kind。
    base_url = models.CharField(max_length=500, blank=True, validators=[validate_endpoint_url])
    api_key = models.CharField(max_length=500, blank=True)
    defaults = models.JSONField(default=dict, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "canvas_image_providers"
        verbose_name = "Canvas Image Provider"
        verbose_name_plural = "Canvas Image Providers"
        ordering = ["label"]

    def __str__(self):
        return f"ImageProvider({self.label})"


class ImageModel(models.Model):
    """供应商下面的一个可选模型 —— 工具栏模型选择器里的一项。

    `model` 是那家供应商要的模型字符串原文。**刻意不建别名映射表**
    (`gemini-2.5 → 各家叫什么`): 穷举「所有供应商 × 所有模型」的命名差异是无底洞,
    每条记录自己声明它那家的写法就够了。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    provider = models.ForeignKey(
        ImageProvider, on_delete=models.CASCADE, related_name="models",
    )
    label = models.CharField(max_length=100)
    model = models.CharField(max_length=200)
    # 只存与 provider.defaults 不同的项; 解析 = {**provider.defaults, **overrides}
    overrides = models.JSONField(default=dict, blank=True)
    enabled = models.BooleanField(default=True)
    sort_order = models.IntegerField(default=0)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "canvas_image_models"
        verbose_name = "Canvas Image Model"
        verbose_name_plural = "Canvas Image Models"
        ordering = ["sort_order", "label"]

    def __str__(self):
        return f"ImageModel({self.label} @ {self.provider_id})"


class ImageEditJob(models.Model):
    class Status(models.TextChoices):
        QUEUED = "QUEUED", "Queued"
        RUNNING = "RUNNING", "Running"
        SUCCEEDED = "SUCCEEDED", "Succeeded"
        FAILED = "FAILED", "Failed"

    class Resolution(models.TextChoices):
        # 画质档位(像素面积). 1K=1024×1024, 2K=2048×2048 (默认), 4K=4096×4096.
        # 1K 主要给 apimart 主通道; 火山 fallback 最低 ~2K, _volc_size 会把 1K 抬到 2K.
        ONE_K = "1K", "1K"
        TWO_K = "2K", "2K"
        FOUR_K = "4K", "4K"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    scene = models.ForeignKey(Scene, on_delete=models.CASCADE, related_name="image_edit_jobs")

    prompt = models.TextField()
    size = models.CharField(max_length=32, default="1024x1024", blank=True)
    resolution = models.CharField(
        max_length=4, choices=Resolution.choices, default=Resolution.TWO_K,
    )
    num_images = models.PositiveSmallIntegerField(default=1)
    # 用户在工具栏选中的模型。**必须落在 job 行上**, 因为这条路径是异步的 —— 请求早就
    # 返回了, celery worker 之后才捞这条记录去跑, 光靠请求参数传不到那时候。
    # 空 = 没选 / 老任务 → 退到库里第一条启用的通道。SET_NULL: 用户删了一个
    # 模型配置不该把历史任务一起删掉。
    image_model = models.ForeignKey(
        "ImageModel", on_delete=models.SET_NULL, null=True, blank=True, related_name="+",
    )
    # cutout=True 切到 rembg(去背景);否则是 refine/edit
    is_cutout = models.BooleanField(default=False)
    # Split: 一次 split 起两条 leg(background inpaint + cutout subject),互填 split_partner.
    # Canvex 无计费,不做原子退款;split_partner 仍保留用于前端把两腿配对显示。
    split_partner = models.ForeignKey(
        "self",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
        db_index=True,
    )
    # Nullable: 显式 POST /image-edit/ 带 multipart;chat agent 的 generate_image 是
    # text-to-image 无源文件。
    source_image = models.ImageField(
        upload_to=canvas_edit_upload_to, null=True, blank=True,
    )
    # 多图(marquee)路径;与 source_image 互斥。
    source_images = models.JSONField(default=list, blank=True)
    # cutout 两段流水 stage1 输出(LLM 抠主体留纯白底,stage2 rembg 把白底转 alpha)。
    intermediate_image = models.ImageField(
        upload_to=canvas_edit_intermediate_upload_to, null=True, blank=True,
    )

    status = models.CharField(
        max_length=16, choices=Status.choices, default=Status.QUEUED, db_index=True
    )
    error = models.TextField(blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "canvas_image_edit_jobs"
        verbose_name = "Canvas Image Edit Job"
        verbose_name_plural = "Canvas Image Edit Jobs"
        ordering = ["-created_at"]

    def __str__(self):
        return f"ImageEditJob({self.id}, {self.status})"


class ImageEditResult(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    job = models.ForeignKey(ImageEditJob, on_delete=models.CASCADE, related_name="results")
    asset = models.ForeignKey(
        DataAsset,
        on_delete=models.CASCADE,
        related_name="canvas_image_edit_results",
    )
    order = models.PositiveSmallIntegerField(default=0)

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "canvas_image_edit_results"
        verbose_name = "Canvas Image Edit Result"
        verbose_name_plural = "Canvas Image Edit Results"
        ordering = ["order", "created_at"]

    def __str__(self):
        return f"Result({self.job_id}, #{self.order})"


class VideoJob(models.Model):
    class Status(models.TextChoices):
        QUEUED = "QUEUED", "Queued"
        RUNNING = "RUNNING", "Running"
        SUCCEEDED = "SUCCEEDED", "Succeeded"
        FAILED = "FAILED", "Failed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    scene = models.ForeignKey(Scene, on_delete=models.CASCADE, related_name="video_jobs")

    prompt = models.TextField()
    image_urls = models.JSONField(default=list, blank=True)
    duration = models.PositiveSmallIntegerField(default=10)  # seconds
    aspect_ratio = models.CharField(max_length=16, default="16:9")

    # 用户在 Video tab 选的通道。这条路径是异步的 (提交完就返回, worker 之后才捞这行去
    # 长轮询), 所以选择必须落在行上而不是留在请求里。空 = 退到库里第一条 video 通道。
    # SET_NULL: 删一个模型配置不该把历史任务一起删掉。
    image_model = models.ForeignKey(
        "ImageModel", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="video_jobs",
    )

    # 外部 provider 的 task id,用于 long-poll
    task_id = models.CharField(max_length=128, blank=True)
    result_url = models.TextField(blank=True)
    thumbnail_url = models.TextField(blank=True)

    status = models.CharField(
        max_length=16, choices=Status.choices, default=Status.QUEUED, db_index=True
    )
    error = models.TextField(blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "canvas_video_jobs"
        verbose_name = "Canvas Video Job"
        verbose_name_plural = "Canvas Video Jobs"
        ordering = ["-created_at"]

    def __str__(self):
        return f"VideoJob({self.id}, {self.status})"


class AngleJob(models.Model):
    """图片相机视角重渲染 job —— 调 fal.ai Qwen-Image-Edit-2511-Multiple-Angles-LoRA.

    和 ImageEditJob 区别:只带一个公网 image URL(LoRA provider 自己 fetch),参数是
    相机坐标(horizontal / vertical / zoom)而非自由 prompt,provider 专一 fal.ai。
    共通:结果落 DataAsset + AngleResult 行,前端 pin 逻辑和 image-edit 一致;num_images 1-4。
    """

    class Status(models.TextChoices):
        QUEUED = "QUEUED", "Queued"
        RUNNING = "RUNNING", "Running"
        SUCCEEDED = "SUCCEEDED", "Succeeded"
        FAILED = "FAILED", "Failed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    scene = models.ForeignKey(Scene, on_delete=models.CASCADE, related_name="angle_jobs")

    # 输入公网 URL —— 经 absolute_media_url() + is_public_http_url() 过滤后存
    source_image_url = models.TextField()

    # fal.ai 相机坐标: horizontal 0-360°, vertical -30-90°, zoom 0-10 (0=wide/10=close)
    horizontal_angle = models.FloatField(default=0.0)
    vertical_angle = models.FloatField(default=0.0)
    zoom = models.FloatField(default=5.0)

    # 可选提示词附加到 LoRA 默认 prompt 之后
    additional_prompt = models.TextField(blank=True)
    num_images = models.PositiveSmallIntegerField(default=1)

    # 用户在 Angle tab 选的通道 (kind=angle 的那些)。同 ImageEditJob.image_model:
    # 这条路径是异步的, 选择必须落在行上, worker 之后才捞。空 = 退到库里第一条。
    image_model = models.ForeignKey(
        "ImageModel", on_delete=models.SET_NULL, null=True, blank=True, related_name="+",
    )

    # provider 返的 seed,存下来用户要复现同一角度时可传回
    seed = models.BigIntegerField(null=True, blank=True)

    status = models.CharField(
        max_length=16, choices=Status.choices, default=Status.QUEUED, db_index=True
    )
    error = models.TextField(blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "canvas_angle_jobs"
        verbose_name = "Canvas Angle Job"
        verbose_name_plural = "Canvas Angle Jobs"
        ordering = ["-created_at"]

    def __str__(self):
        return f"AngleJob({self.id}, {self.status})"


class AngleResult(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    job = models.ForeignKey(AngleJob, on_delete=models.CASCADE, related_name="results")
    asset = models.ForeignKey(
        DataAsset,
        on_delete=models.CASCADE,
        related_name="canvas_angle_results",
    )
    order = models.PositiveSmallIntegerField(default=0)

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "canvas_angle_results"
        verbose_name = "Canvas Angle Result"
        verbose_name_plural = "Canvas Angle Results"
        ordering = ["order", "created_at"]

    def __str__(self):
        return f"AngleResult({self.job_id}, #{self.order})"


class Skill(models.Model):
    """一个装好的 SKILL.md —— agent 的可选 SOP, 用户在前端传 / 编 / 停用。

    存在的理由: skill 以前只能是磁盘上 `services/agent/skills/<slug>/SKILL.md` 的一个
    目录, 想加一条自己的 SOP 得进容器改文件再重启。现在进库, 前端传个 .md 就装上了。

    **磁盘那份变成出厂种子**: 迁移 0018 把它导进这张表, 此后运行时只认库。磁盘文件留着
    是为了新装的人一上来就有两条能用的 SOP, 不再是运行时真相 —— 别再去改那些文件, 改了
    不生效。

    `content` 是 SKILL.md 全文(含 frontmatter), 是唯一真相。`name` / `description` 是
    存盘时从 frontmatter 里解析出来的**冗余列**: name 要做唯一约束 + 当 store 的 key,
    description 要给列表和 popover 用 —— 每次 GET 都重新 yaml 解析一遍全部 skill 太蠢。
    两列只由 SkillSerializer 那一条通路写, 跟 content 不会飘。

    `source=builtin` 的行**能停用、不能删**: 删了磁盘上还在, 重建容器又长回来, 那种
    "删不掉"最难跟用户解释。用户装的 (`source=user`) 才是真能删的。

    `enabled=False` = 不往 store 里放 = agent 完全看不见。这跟 ChatOverlay 那个
    SkillSelector 是两回事: 那个是**单条消息**的临时跳过, 这个是持久的装/不装。
    """

    class Source(models.TextChoices):
        # 随代码库发的出厂 SOP, 由数据迁移导入。可停用, 不可删。
        BUILTIN = "builtin", "Built-in"
        # 用户自己传上来的。
        USER = "user", "User-installed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # frontmatter 里的 name。agentskills 规范要求它等于所在目录名, 而我们的目录名就是
    # 由它生成的 (`/{name}/SKILL.md`), 所以天然满足。max_length 跟 deepagents 的
    # MAX_SKILL_NAME_LENGTH 对齐。
    name = models.CharField(max_length=64, unique=True)
    # frontmatter 里的 description。progressive disclosure 靠它 —— agent 系统提示里只有
    # 这一段, 它决定 agent 要不要把整篇 SKILL.md 读进来。
    description = models.TextField()
    content = models.TextField()
    source = models.CharField(
        max_length=16, choices=Source.choices, default=Source.USER, db_index=True,
    )
    enabled = models.BooleanField(default=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "canvas_skills"
        verbose_name = "Canvas Skill"
        verbose_name_plural = "Canvas Skills"
        ordering = ["name"]

    def __str__(self):
        return f"Skill({self.name})"
