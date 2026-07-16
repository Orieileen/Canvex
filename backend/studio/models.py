from __future__ import annotations

import uuid
from datetime import datetime
from pathlib import Path

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


class Robot(models.Model):
    """A saved browser-automation robot (影刀-style RPA): a named, reusable list of
    deterministic DSL steps authored by picking elements on the canvas. Runs WITHOUT
    the LLM (see robot_runner.stream_robot_run); the model only authors / self-heals."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    scene = models.ForeignKey(Scene, on_delete=models.CASCADE, related_name="robots")
    name = models.CharField(max_length=200)
    # Ordered DSL steps (AI-RPA-v1-design.md §4): [{action, target, text, url, ...}].
    steps = models.JSONField(default=list, blank=True)
    # Run-time-prompted values (e.g. credentials) steps reference — never inlined.
    variables = models.JSONField(default=dict, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "canvas_robots"
        verbose_name = "Canvas Robot"
        verbose_name_plural = "Canvas Robots"
        ordering = ["-created_at"]

    def __str__(self):
        return f"Robot({self.id}, {self.name!r}, {len(self.steps or [])} steps)"


class RobotRun(models.Model):
    """One execution of a Robot (run history). Mirrors the job Status pattern."""

    class Status(models.TextChoices):
        QUEUED = "QUEUED", "Queued"
        RUNNING = "RUNNING", "Running"
        SUCCEEDED = "SUCCEEDED", "Succeeded"
        FAILED = "FAILED", "Failed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    robot = models.ForeignKey(Robot, on_delete=models.CASCADE, related_name="runs")
    status = models.CharField(
        max_length=16, choices=Status.choices, default=Status.QUEUED, db_index=True
    )
    error = models.TextField(blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "canvas_robot_runs"
        verbose_name = "Canvas Robot Run"
        verbose_name_plural = "Canvas Robot Runs"
        ordering = ["-created_at"]

    def __str__(self):
        return f"RobotRun({self.id}, robot={self.robot_id}, {self.status})"
