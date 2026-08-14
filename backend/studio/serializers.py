from rest_framework import serializers

from .models import (
    AngleJob,
    AngleResult,
    ChatMessage,
    ImageEditJob,
    ImageEditResult,
    ImageModel,
    ImageProvider,
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
    # 用户在工具栏选中的生图模型 (ImageModel.id)。跟 attachments 一样是每轮透传:
    # 生成是异步的, 这个值最终会落到 ImageEditJob 行上。空/未知 id → 回退 env 通道,
    # 所以这里不校验存在性 (校验会让"刚删掉一个配置"变成整轮聊天失败)。
    image_model_id = serializers.CharField(
        required=False, allow_blank=True, default="", max_length=64,
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
    # 工具栏模型选择器。可空 = 用 env 默认通道。用 PrimaryKeyRelatedField 是要它在
    # 这里就报"配置不存在", 而不是等到 worker 里静默回退 —— 显式选择失败该显式说。
    image_model = serializers.PrimaryKeyRelatedField(
        queryset=ImageModel.objects.filter(enabled=True),
        required=False, allow_null=True, default=None,
    )

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
# 生图供应商配置 (用户在前端配, 取代 env 里写死的 PRIMARY/FALLBACK)
# ---------------------------------------------------------------------------

# defaults / overrides 里允许出现的值类型。ImageChannel 是 frozen dataclass 且被当作
# build_image_client 的 lru_cache 键, 一个 list/dict 值会让它 unhashable —— 炸点在几
# 分钟后的 worker 里 (TypeError: unhashable type), 而不是用户按下保存的这一刻。
_TUNABLE_VALUE_TYPES = (str, bool, int, float)


def _validate_tunables(value):
    """校验 defaults / overrides 这类自由 JSON: 必须是对象, 值必须是标量。

    键名不校验 —— channel_for_model 会把不认识的键丢掉并记 warning, 一个拼错的键不该
    让保存失败。但值的**类型**必须拦在入口, 理由见 _TUNABLE_VALUE_TYPES。
    """
    if not isinstance(value, dict):
        raise serializers.ValidationError("必须是一个 JSON 对象")
    bad = sorted(
        k for k, v in value.items()
        if v is not None and not isinstance(v, _TUNABLE_VALUE_TYPES)
    )
    if bad:
        raise serializers.ValidationError(
            f"这些项的值必须是字符串 / 数字 / 布尔: {', '.join(bad)}"
        )
    return value


class ImageModelSerializer(serializers.ModelSerializer):
    # 显式声明成可写。ModelSerializer 默认把主键做成 read_only (id 是
    # UUIDField(primary_key=True, editable=False)), 那样嵌套写时 id 根本进不到
    # validated_data, _sync_models 就永远走"新建"分支 —— 每次保存都把模型行删掉重建,
    # 换一批新 id: 历史 ImageEditJob.image_model 被 SET_NULL 抹掉, 前端存在
    # localStorage 里的粘性选择也变成一个死 id。
    id = serializers.UUIDField(required=False)

    class Meta:
        model = ImageModel
        fields = ("id", "label", "model", "overrides", "enabled", "sort_order")

    def validate_overrides(self, value):
        return _validate_tunables(value)


class ImageProviderSerializer(serializers.ModelSerializer):
    """供应商 + 它下面的模型, 一次读写。

    模型嵌在里面而不是单独一套 CRUD: 前端配置页就是"一个供应商一张卡片, 里面几行模型",
    一次 PUT 带全量 models 数组比让前端管两套增删改简单得多。

    api_key 明文返回 —— 本地单机项目, 配置页要能回显用户填过什么、直接改。见设计文档
    「key 的处理」。
    """

    models = ImageModelSerializer(many=True, required=False)

    class Meta:
        model = ImageProvider
        fields = ("id", "label", "base_url", "api_key", "defaults", "models",
                  "created_at", "updated_at")
        read_only_fields = ("id", "created_at", "updated_at")

    def validate_defaults(self, value):
        return _validate_tunables(value)

    def _sync_models(self, provider, models_data):
        """全量替换: 请求里没出现的模型行删掉, 带 id 的更新, 不带 id 的新建。

        保留 id 而不是"删光重建"是为了 ImageEditJob.image_model 的外键 —— 重建会把历史
        任务的关联 SET_NULL 抹掉。
        """
        # 成员判定一次查完, 别在循环里每行一次 exists()
        existing = set(provider.models.values_list("id", flat=True))
        keep_ids = []
        for order, item in enumerate(models_data):
            model_id = item.pop("id", None)
            item.setdefault("sort_order", order)
            if model_id in existing:
                ImageModel.objects.filter(id=model_id).update(**item)
                keep_ids.append(model_id)
            else:
                keep_ids.append(ImageModel.objects.create(provider=provider, **item).id)
        provider.models.exclude(id__in=keep_ids).delete()

    def create(self, validated_data):
        models_data = validated_data.pop("models", [])
        provider = ImageProvider.objects.create(**validated_data)
        self._sync_models(provider, models_data)
        return provider

    def update(self, instance, validated_data):
        models_data = validated_data.pop("models", None)
        for k, v in validated_data.items():
            setattr(instance, k, v)
        instance.save()
        if models_data is not None:
            self._sync_models(instance, models_data)
        return instance


class ImageModelChoiceSerializer(serializers.ModelSerializer):
    """工具栏模型选择器拉的列表 —— 只有展示需要的字段, 不含 key/base_url。"""

    provider_label = serializers.CharField(source="provider.label", read_only=True)

    class Meta:
        model = ImageModel
        fields = ("id", "label", "provider_label", "sort_order")
