from rest_framework import serializers

from .models import (
    AngleJob,
    AngleResult,
    ChatMessage,
    ImageEditJob,
    ImageEditResult,
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


class _AssetResultSerializerBase(serializers.ModelSerializer):
    """共享的 canvas 结果行序列化形状 (order + asset_id + url).

    返相对 /media URL 而非 `request.build_absolute_uri`: Vite proxy changeOrigin
    把 Host 改成 docker 内网 `web:8000`, 浏览器解析不了. 若 MEDIA_URL 指 S3/CDN
    (绝对 URL), FieldFile.url 原样就是绝对, 透传即可.
    具体子类只要设 `Meta.model`; 结果模型必须有 (order, asset) 两个字段.
    asset 指向 studio.models.DataAsset (Canvex 自有素材库)。
    """

    url = serializers.SerializerMethodField()
    asset_id = serializers.UUIDField(source="asset.id", read_only=True)

    class Meta:
        fields = ("order", "asset_id", "url")
        read_only_fields = fields

    def get_url(self, obj):
        # ValueError: FieldFile without a saved file; AttributeError: asset is None
        try:
            return obj.asset.file.url
        except (ValueError, AttributeError):
            return ""


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
