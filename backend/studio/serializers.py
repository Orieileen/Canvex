from rest_framework import serializers

from .models import (
    AngleJob,
    AngleResult,
    ChatMessage,
    ImageEditJob,
    ImageEditResult,
    Robot,
    Scene,
    VideoJob,
)


# ---------------------------------------------------------------------------
# Scene
# ---------------------------------------------------------------------------

class SceneSerializer(serializers.ModelSerializer):
    class Meta:
        model = Scene
        fields = ("id", "title", "data", "created_at", "updated_at")
        read_only_fields = ("id", "created_at", "updated_at")

    def validate_data(self, value):
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise serializers.ValidationError("data must be an object")
        return value


class SceneListSerializer(serializers.ModelSerializer):
    # `data` intentionally dropped — list view defers the heavy JSON blob
    class Meta:
        model = Scene
        fields = ("id", "title", "created_at", "updated_at")
        read_only_fields = fields


class SceneCreateSerializer(serializers.ModelSerializer):
    class Meta:
        model = Scene
        fields = ("title", "data")


# ---------------------------------------------------------------------------
# ChatMessage
# ---------------------------------------------------------------------------

class ChatMessageSerializer(serializers.ModelSerializer):
    class Meta:
        model = ChatMessage
        fields = ("id", "scene", "role", "content", "created_at")
        read_only_fields = ("id", "scene", "created_at")


class ChatAttachmentSerializer(serializers.Serializer):
    """Single canvas image attached to a chat message via "Send to chat".
    Per-turn ephemeral — not persisted, just surfaced to the agent as
    context for the LLM to optionally pass to generate_image/video tools."""
    url = serializers.URLField(max_length=2048)
    width = serializers.IntegerField(min_value=1, max_value=20000)
    height = serializers.IntegerField(min_value=1, max_value=20000)


class ChatMessageCreateSerializer(serializers.Serializer):
    # max_length 防两件事: (1) DoS 单请求塞巨型消息撑爆 LLM 输入, (2) 用户
    # 把几 MB 日志/文档直接贴进来. 8000 chars ≈ 2000 tokens, 对单轮 chat 够用
    content = serializers.CharField(
        trim_whitespace=True, allow_blank=False, max_length=8000,
    )
    # Per-message skill opt-out list. Unknown names accepted silently — avoid
    # coupling frontend cache to backend skill registry. max_length caps
    # DoS / typo storm.
    disabled_skills = serializers.ListField(
        child=serializers.CharField(max_length=64),
        required=False,
        default=list,
        max_length=20,
    )
    # Per-message canvas image attachments (user clicked "Send to chat" on
    # selected canvas image(s)). Each item: {url, width, height}. URLs come
    # from canvas → known CDN host; we don't re-validate beyond shape +
    # length caps because the agent treats them as opaque references it can
    # pass to generate_image(image_urls=[...]).
    attachments = serializers.ListField(
        child=ChatAttachmentSerializer(),
        required=False,
        default=list,
        max_length=10,
    )


# ---------------------------------------------------------------------------
# ImageEditJob
# ---------------------------------------------------------------------------

class ImageEditJobSerializer(serializers.ModelSerializer):
    # `source_image` / `source_images` intentionally omitted — they're internal
    # storage paths the client already owns via its upload; exposing them on
    # retrieve would leak media tree structure without value.
    class Meta:
        model = ImageEditJob
        fields = (
            "id", "scene", "prompt", "size", "resolution", "num_images", "is_cutout",
            "status", "error", "created_at", "updated_at",
        )
        read_only_fields = fields


class ImageEditJobCreateSerializer(serializers.Serializer):
    """POST /scenes/<id>/image-edit/ — the `image` file is pulled from request.FILES."""

    prompt = serializers.CharField(required=False, allow_blank=True, default="")
    cutout = serializers.BooleanField(required=False, default=False)
    size = serializers.CharField(required=False, allow_blank=True, default="1024x1024")
    resolution = serializers.ChoiceField(
        choices=ImageEditJob.Resolution.choices, required=False,
        default=ImageEditJob.Resolution.TWO_K,
    )
    n = serializers.ChoiceField(choices=[1, 2, 4], required=False, default=1)

    def validate(self, data):
        # cutout 算法 (rembg / LLM 同) 都是单图操作, n>1 没有"多个抠图变体"语义.
        # 不拦截就会扣 n credit 但只产 1 张, 用户付了钱拿不到对应数量的图.
        if data.get("cutout") and data.get("n", 1) > 1:
            raise serializers.ValidationError({
                "n": ["Cutout mode produces exactly 1 image; n must be 1."],
            })
        return data


def result_asset_url(obj) -> str:
    """结果行 → 其 asset 文件的相对 /media URL; 缺文件 / asset 为 None → ""。

    返相对 /media URL 而非 `request.build_absolute_uri`: Vite proxy changeOrigin
    把 Host 改成 docker 内网 `web:8000`, 浏览器解析不了 (前端自己补 base)。若
    MEDIA_URL 指 S3/CDN (绝对 URL), FieldFile.url 原样就是绝对, 透传即可。
    ValueError: FieldFile without a saved file; AttributeError: asset is None。
    """
    try:
        return obj.asset.file.url
    except (ValueError, AttributeError):
        return ""


class _AssetResultSerializerBase(serializers.ModelSerializer):
    """共享的 canvas 结果行序列化形状 (order + asset_id + url).

    具体子类只要设 `Meta.model`; 结果模型必须有 (order, asset) 两个字段.
    asset 指向 studio.models.DataAsset (Canvex 自有素材库)。
    """

    url = serializers.SerializerMethodField()
    asset_id = serializers.UUIDField(source="asset.id", read_only=True)

    class Meta:
        fields = ("order", "asset_id", "url")
        read_only_fields = fields

    def get_url(self, obj):
        return result_asset_url(obj)


class ImageEditResultSerializer(_AssetResultSerializerBase):
    class Meta(_AssetResultSerializerBase.Meta):
        model = ImageEditResult


# ---------------------------------------------------------------------------
# VideoJob
# ---------------------------------------------------------------------------

class VideoJobSerializer(serializers.ModelSerializer):
    class Meta:
        model = VideoJob
        fields = (
            "id", "scene", "prompt", "image_urls", "duration", "aspect_ratio",
            "task_id", "result_url", "thumbnail_url",
            "status", "error", "created_at", "updated_at",
        )
        read_only_fields = fields


class VideoJobCreateSerializer(serializers.Serializer):
    """POST /scenes/<id>/video/. Image source: `image_urls` (CDN) OR multipart
    `image` File pulled from request.FILES (view layer). Both may be empty
    when `prompt` carries text-to-video."""

    prompt = serializers.CharField(required=False, allow_blank=True, default="")
    image_urls = serializers.ListField(
        child=serializers.CharField(allow_blank=False),
        required=False,
        default=list,
    )
    duration = serializers.IntegerField(required=False, min_value=1, max_value=60, default=10)
    aspect_ratio = serializers.CharField(required=False, default="16:9")


# ---------------------------------------------------------------------------
# AngleJob
# ---------------------------------------------------------------------------

class AngleJobSerializer(serializers.ModelSerializer):
    class Meta:
        model = AngleJob
        fields = (
            "id", "scene",
            "source_image_url", "horizontal_angle", "vertical_angle", "zoom",
            "additional_prompt", "num_images", "seed",
            "status", "error", "created_at", "updated_at",
        )
        read_only_fields = fields


class AngleJobCreateSerializer(serializers.Serializer):
    """POST /scenes/<id>/angle/. 数值范围与 fal.ai LoRA 一致:
    horizontal 0-360, vertical -30-90 (仰俯), zoom 0-10 (wide→close-up).
    Source: `image_url` OR multipart `image` File (validated in view layer to
    keep DRF's PIL `ImageField` off the multipart hot path)."""

    image_url = serializers.CharField(required=False, allow_blank=False, max_length=2000)
    horizontal_angle = serializers.FloatField(min_value=0, max_value=360, default=0.0)
    vertical_angle = serializers.FloatField(min_value=-30, max_value=90, default=0.0)
    zoom = serializers.FloatField(min_value=0, max_value=10, default=5.0)
    additional_prompt = serializers.CharField(
        required=False, allow_blank=True, default="", max_length=2000,
    )
    num_images = serializers.ChoiceField(choices=[1, 2, 4], required=False, default=1)


class AngleResultSerializer(_AssetResultSerializerBase):
    class Meta(_AssetResultSerializerBase.Meta):
        model = AngleResult


# ---------------------------------------------------------------------------
# Media library (跨全部画布的已生成素材)
# ---------------------------------------------------------------------------

class MediaLibraryImageSerializer(serializers.Serializer):
    """一条已生成的图片素材 —— 输入是 ImageEditResult / AngleResult 结果行
    (两者都有 `.asset` 和 `.job.scene`, 同一个 serializer 通吃)。

    带上所属画布 (scene_id / scene_title), 供前端按画布名分文件夹。
    URL 同 `_AssetResultSerializerBase`: 返相对 /media (前端补 base), 缺文件返 ""。
    `asset_id` 当 dedupKey —— 前端 pinImage 用它防同图重复 pin。
    """

    asset_id = serializers.UUIDField(source="asset.id", read_only=True)
    url = serializers.SerializerMethodField()
    # DataAsset.width/height 是 null=True (无 PIL 抽尺寸时为空); 显式 allow_null
    # 对齐前端 `number | null` 契约。
    width = serializers.IntegerField(source="asset.width", read_only=True, allow_null=True)
    height = serializers.IntegerField(source="asset.height", read_only=True, allow_null=True)
    created_at = serializers.DateTimeField(source="asset.created_at", read_only=True)
    scene_id = serializers.UUIDField(source="job.scene.id", read_only=True)
    scene_title = serializers.CharField(source="job.scene.title", read_only=True)

    def get_url(self, obj):
        return result_asset_url(obj)


class MediaLibraryVideoSerializer(serializers.ModelSerializer):
    """一条已生成的视频 (VideoJob)。result_url 是 provider 外链 (绝对 http),
    前端直接当 <video>/缩略图 src 用; thumbnail_url 可能为空。
    同样带所属画布供分文件夹。"""

    job_id = serializers.UUIDField(source="id", read_only=True)
    url = serializers.CharField(source="result_url", read_only=True)
    scene_id = serializers.UUIDField(source="scene.id", read_only=True)
    scene_title = serializers.CharField(source="scene.title", read_only=True)

    class Meta:
        model = VideoJob
        fields = ("job_id", "url", "thumbnail_url", "created_at", "scene_id", "scene_title")
        read_only_fields = fields


class MediaLibraryFolderSerializer(serializers.Serializer):
    """一个文件夹 = 一个有过生成的画布。输入是 view 拼好的 dict (非 model 实例),
    带 *精确* 计数 + 封面 + 最新时间。cover_url: 图封面为相对 /media (前端补 base),
    视频缩略图封面已是 provider 外链; 可能为 "" → 前端用文件夹图标占位。"""

    scene_id = serializers.UUIDField(read_only=True)
    scene_title = serializers.CharField(read_only=True, allow_blank=True)
    image_count = serializers.IntegerField(read_only=True)
    video_count = serializers.IntegerField(read_only=True)
    cover_url = serializers.CharField(read_only=True, allow_blank=True)
    latest_at = serializers.DateTimeField(read_only=True)


# ---------------------------------------------------------------------------
# Robot (RPA)
# ---------------------------------------------------------------------------

class RobotSerializer(serializers.ModelSerializer):
    class Meta:
        model = Robot
        fields = (
            "id", "scene", "name", "steps", "variables", "allow_writes",
            "created_at", "updated_at",
        )
        read_only_fields = ("id", "scene", "created_at", "updated_at")


class RobotCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=200)
    steps = serializers.ListField(child=serializers.DictField(), allow_empty=True)
    variables = serializers.DictField(required=False, default=dict)
    allow_writes = serializers.BooleanField(required=False, default=False)
