import logging

from django.utils import timezone
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
    Skill,
    VideoJob,
)
from .services.agent.skill_md import SkillMdError, parse_skill_md
from .services.image_channels import KIND_SPECS, POSITIVE_TUNABLES, TUNABLE_TYPES

logger = logging.getLogger(__name__)


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
    # 生成是异步的, 这个值最终会落到 ImageEditJob 行上。空/未知 id → 退到库里第一条,
    # 所以这里不校验存在性 (校验会让"刚删掉一个配置"变成整轮聊天失败)。
    image_model_id = serializers.CharField(
        required=False, allow_blank=True, default="", max_length=64,
    )
    # 同上, Video tab 选的通道 (kind=video)。generate_video 建 job 时写到行上。
    video_model_id = serializers.CharField(
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


def _channel_choice_field(kind: str):
    """工具栏模型选择器写回来的那一项。

    两件事都不是可选的:
    - **queryset 按 kind 限死** —— 两种接口形状同住一张表, 把 angle 通道送进生图路径
      (或反过来) 发出去必然失败, 且失败得莫名其妙。在这里筛掉。
    - **用 PrimaryKeyRelatedField 而不是 CharField** —— 要它当场报"配置不存在", 而不是
      等到 worker 里静默回退成别的模型。显式选择失败该显式说。

    可空 = 用户没选 → 退到库里第一条启用的通道。
    """
    return serializers.PrimaryKeyRelatedField(
        queryset=ImageModel.objects.filter(enabled=True, provider__kind=kind),
        required=False, allow_null=True, default=None,
    )


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
    image_model = _channel_choice_field(ImageProvider.Kind.IMAGE)

    def validate(self, data):
        # cutout 算法 (rembg / LLM 同) 都是单图操作, n>1 没有"多个抠图变体"语义.
        # 不拦截就会扣 n credit 但只产 1 张, 用户付了钱拿不到对应数量的图.
        if data.get("cutout") and data.get("n", 1) > 1:
            raise serializers.ValidationError({
                "n": ["Cutout mode produces exactly 1 image; n must be 1."],
            })
        return data


class SplitJobCreateSerializer(serializers.Serializer):
    """POST /scenes/<id>/split/ — the `image` file is pulled from request.FILES.

    只校验 image_model —— split 的两条 leg 跟 image-edit 走同一个 runner, 所以工具栏
    选的模型必须同样送达, 也必须同样在这里就报"配置不存在"。

    region / resolution 保持宽松 (CharField + create_split_jobs 里的档位兜底) 而不是
    收成 ChoiceField: 它们本来就接受任意字符串并各自有兜底, 收紧会把原先能生成的请求
    变成 400, 那是这次改动之外的行为变化。
    """

    region = serializers.CharField(required=False, allow_blank=True, default="")
    resolution = serializers.CharField(required=False, allow_blank=True, default="")
    image_model = _channel_choice_field(ImageProvider.Kind.IMAGE)


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
    image_model = _channel_choice_field(ImageProvider.Kind.VIDEO)


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
    image_model = _channel_choice_field(ImageProvider.Kind.ANGLE)


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

_TRUE_WORDS = {"true", "1", "yes", "on"}
_FALSE_WORDS = {"false", "0", "no", "off"}


def _coerce_tunable(key: str, raw):
    """把一个旋钮的值归一成它声明的标量类型, 归一不了就抛。

    「是标量」不够: 每个旋钮的类型也得对上。JSON 里一个 `"poll_enabled": "false"` 是非空
    字符串 = 真值, 会**静默打开**轮询; `"size_mode": 123` 会在几分钟后的 worker 里炸
    `AttributeError: 'int' object has no attribute 'lower'`; 一个 `2.5` 的
    poll_max_attempts 会让 `range()` 抛 TypeError。全都是保存时看不见、生成时才炸的。
    """
    expected = TUNABLE_TYPES.get(key)
    if expected is None:
        return raw  # 不认识的键: channel_for_model 会丢掉并记 warning, 这里不拦
    if expected is bool:
        if isinstance(raw, bool):
            return raw
        token = str(raw).strip().lower()
        if token in _TRUE_WORDS:
            return True
        if token in _FALSE_WORDS:
            return False
        raise serializers.ValidationError(f"{key}: 需要 true / false")
    if expected is int:
        if isinstance(raw, bool):
            raise serializers.ValidationError(f"{key}: 需要一个整数")
        try:
            number = int(str(raw).strip())
        except (TypeError, ValueError) as exc:
            raise serializers.ValidationError(f"{key}: 需要一个整数") from exc
        # 负数跟类型错一样是"保存时看不见、生成时才炸": urllib3 见到 timeout=-1 直接抛
        # ValueError (整个 job FAILED, 报错跟这个输入框毫无关系), poll_max_attempts<0
        # 则让 range() 一轮都不转、静默当成"轮询完了没结果"。
        if number < 0:
            raise serializers.ValidationError(f"{key}: 不能是负数")
        # 0 对超时/间隔/轮数这几项跟负数是同一类错误 —— urllib3 拒的是 <= 0 而不是 < 0,
        # sleep(0) 会把轮询变成锤供应商的死循环。名单在 image_channels 里, 跟"哪些旋钮
        # 存在"同住一处 (见 POSITIVE_TUNABLES)。poll_max_interval 的 0 是有定义的, 不在内。
        if number == 0 and key in POSITIVE_TUNABLES:
            raise serializers.ValidationError(f"{key}: 必须大于 0(留空 = 用默认值)")
        return number
    if expected is str:
        if isinstance(raw, str):
            return raw
        raise serializers.ValidationError(f"{key}: 需要一个字符串")
    return raw


def _validate_tunables(value):
    """校验并归一 defaults / overrides 这类自由 JSON。

    键名不校验 —— channel_for_model 会把不认识的键丢掉并记 warning, 一个拼错的键不该
    让保存失败。但值必须是标量 (理由见 _TUNABLE_VALUE_TYPES), 且**认识的键**的值还要
    能归一成它声明的类型 (理由见 _coerce_tunable)。null = 没设这一项, 直接丢掉 ——
    留着会变成 `timeout=None` 这种"永不超时"。
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
    return {k: _coerce_tunable(k, v) for k, v in value.items() if v is not None}


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
        fields = ("id", "label", "kind", "base_url", "api_key", "defaults", "models",
                  "created_at", "updated_at")
        read_only_fields = ("id", "created_at", "updated_at")

    def validate_defaults(self, value):
        return _validate_tunables(value)

    def validate(self, data):
        """按 kind 判两件事: base_url 是不是必填, 以及丢掉这种 kind 读不到的旋钮。

        对象级而不是字段级: 两个判定都要同时看 `kind` 和另一个字段
        (`base_url` / `defaults` / `models[].overrides`), 字段校验器拿不到 kind。

        旋钮**丢弃而不是报错**是刻意的: 把一个已有的 image 供应商改成 angle 是正常操作,
        那 12 个 image 旋钮此刻全都作废 —— 报错会把用户卡在"改不了 kind"上, 而留着它们则
        会存进库、被 channel_for_model 合进通道、然后被 submit_angle 完全忽略, 静默无痕。
        跟 channel_for_model 处理不认识的键同一个态度: 记一条 warning, 当没配过。
        """
        # **通道类型建完就不能改。** 它不是一个设置, 是"这个端点说哪种协议"。放开改的
        # 后果实测过: 下面那段裁剪会把不适用的参数**整组丢掉** (生图的请求形状 + 轮询配置
        # 一次全没, 不可撤销), 而 base_url 原样留着指向旧端点 —— 于是一条本来好好的通道
        # 变成一条必然 404 的通道, 还从它原来那个选择器里消失了。前端也把下拉禁掉了, 但
        # 拦截必须在这里: 界面不是唯一的客户端。
        if self.instance is not None and "kind" in data and data["kind"] != self.instance.kind:
            raise serializers.ValidationError({"kind": [
                "通道类型建好之后不能改 —— 换协议会丢掉这条通道的请求配置。"
                "请新建一条, 确认无误后再删掉旧的。"
            ]})
        kind = data.get("kind") or getattr(self.instance, "kind", ImageProvider.Kind.IMAGE)

        # base_url 留空只对聊天通道合法 (= 走 OpenAI 官方端点, builder 里
        # `channel.base_url or None`; 迁移 0015 导进来的那条存的就是空串)。其余三种
        # 都要靠它拼出端点, 空的话要到几分钟后的 worker 里才炸成 requests.MissingSchema。
        base_url = data.get("base_url", getattr(self.instance, "base_url", ""))
        if not (base_url or "").strip() and KIND_SPECS[kind].requires_base_url:
            raise serializers.ValidationError(
                {"base_url": ["这种通道必须填 Base URL(只有聊天通道可以留空 = 用 OpenAI 官方端点)"]}
            )

        allowed = KIND_SPECS[kind].tunables

        def prune(values, where):
            dropped = sorted(set(values) - allowed)
            if dropped:
                logger.warning(
                    "image provider (%s): %s 里的 %s 不适用于这种通道, 已丢弃",
                    kind, where, ", ".join(dropped),
                )
            return {k: v for k, v in values.items() if k in allowed}

        if "defaults" in data:
            data["defaults"] = prune(data["defaults"], "defaults")
        for m in data.get("models") or []:
            if "overrides" in m:
                m["overrides"] = prune(m["overrides"], f"model {m.get('label', '?')} overrides")
        return data

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
                # queryset.update() 不走 save(), 所以 auto_now 的 updated_at 不会动 ——
                # 不显式带上的话, 一条被改过十次的模型行时间戳永远停在创建那一刻。
                ImageModel.objects.filter(id=model_id).update(
                    updated_at=timezone.now(), **item,
                )
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
    # 前端按它分流: Image / Split 面板只列 image, Angle 面板只列 angle。带在每一项上
    # (而不是让前端按 kind 各拉一次) —— 一次请求、一份 state, 两个选择器各自 filter。
    kind = serializers.CharField(source="provider.kind", read_only=True)

    class Meta:
        model = ImageModel
        fields = ("id", "label", "provider_label", "kind", "sort_order")


class SkillSerializer(serializers.ModelSerializer):
    """装好的 SKILL.md 的增删改查。

    写入面只有两个字段: `content` (SKILL.md 全文) 和 `enabled`。**`name` /
    `description` 都是只读的** —— 它们从 content 的 frontmatter 里解析出来, 让前端
    也能传一份意味着两份可以对不上, 而对不上的那份会成为 store 的 key。想改名就改
    frontmatter 里的 `name`, 这是 skill 唯一的身份来源。

    store 同步不在这里做, 在 SkillViewSet 里 —— 序列化器只管"这篇 SKILL.md 合不合
    格、库里怎么存", 是否推给 agent 是视图那一层的事 (删除也要推, 而删除根本不经过
    序列化器)。
    """

    class Meta:
        model = Skill
        fields = (
            "id", "name", "description", "content", "source", "enabled",
            "created_at", "updated_at",
        )
        read_only_fields = ("id", "name", "description", "source", "created_at", "updated_at")

    def validate(self, data):
        """解析 + 准入 + 把派生列写回。

        整篇只解析一次, 而且刻意**不用** `validate_content` —— 那样得解析两遍 (字段级
        一遍拿报错, `validate` 里再一遍拿 name), 而第二遍能不能成立完全依赖"字段级先跑
        过了"这个隐含前提。哪天字段被设成 `required=False` 或者调用顺序变了, 第二遍就
        会抛 SkillMdError 穿过 DRF 变成 500。一次解析没有这个雷。

        PATCH 只改 enabled 时 content 不在 data 里, 那种情况没有什么要查的。
        """
        raw = data.get("content")
        if raw is None:
            return data
        try:
            content, name, description = parse_skill_md(raw)
        except SkillMdError as exc:
            raise serializers.ValidationError({"content": str(exc)}) from exc

        if self.instance is not None and self.instance.source == Skill.Source.BUILTIN:
            # 内置 skill 的正文只读, 只能停用/启用。允许改的话没有回退路径 —— 出厂那份
            # 在镜像里的 `services/agent/skills/` 下, docker 部署的用户根本够不着, 改坏
            # 了就永久坏了。想要自己的版本就复制一份新装 (面板上有「复制为我的」)。
            raise serializers.ValidationError({
                "content": (
                    f"`{self.instance.name}` 是内置 skill, 正文改不了 —— 改坏了没法还原。"
                    "用「复制为我的」拷一份出来改, 再把内置这条停用。"
                ),
            })

        conflict = Skill.objects.filter(name=name)
        if self.instance is not None:
            conflict = conflict.exclude(pk=self.instance.pk)
        existing = conflict.first()
        if existing is not None:
            if existing.source == Skill.Source.BUILTIN:
                raise serializers.ValidationError({
                    "content": (
                        f"`{name}` 是内置 skill 的名字, 占用了。给你这篇换个 `name` 吧。"
                    ),
                })
            # 带上 id: 前端据此把这个 400 变成一句"这会覆盖已装的 X, 确定吗", 确定之后
            # 直接 PATCH 那一条。**名字必须由后端解析出来** —— 前端自己从 frontmatter 里
            # 抠 name 就是把规则手抄了一份, 抄的那份迟早跟这边分叉。
            raise serializers.ValidationError({
                "content": f"已经装了一个叫 `{name}` 的 skill。",
                "conflict_id": str(existing.pk),
                "conflict_name": name,
            })

        data["content"] = content
        data["name"] = name
        data["description"] = description
        return data
