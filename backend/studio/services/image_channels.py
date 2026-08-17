"""库里的供应商配置 → ImageChannel。

`image_client.ImageChannel` 是「一次生图调用需要的全部参数」, 而**唯一来源**是用户在
前端配的 ImageProvider / ImageModel 两层记录 —— 本模块负责把它们压成一个通道。
(早先还有一路 env 前缀 `CANVAS_IMAGE_PRIMARY_*`, 连同工具栏的「后端默认」一起去掉了;
老部署的值由迁移 0008 / 0010 一次性导进库。)

下游 (`_single_generation` / `build_image_client`) 只认那个 dataclass, 不关心配置从哪
来。所以这一层是唯一需要理解「两层记录如何合并」的地方。
"""
import dataclasses
import logging
import typing
import uuid as uuid_lib

from studio.models import ImageModel, ImageProvider
from studio.services.image_client import ImageChannel

logger = logging.getLogger(__name__)

# base_url / api_key / model / label 有各自的来源, 不走 JSON 合并; ImageChannel 上
# 其余的字段就是可调项。从 dataclass 派生而不是手抄一份 —— 手抄的那份会在有人给
# ImageChannel 加旋钮时悄悄落后, 表现是"在界面上配了却不生效", 而且没有任何报错。
_NON_TUNABLE_FIELDS = frozenset({"base_url", "api_key", "model", "label"})
_TUNABLE_FIELDS = frozenset(
    f.name for f in dataclasses.fields(ImageChannel)
) - _NON_TUNABLE_FIELDS


def _scalar_type(annotation) -> type | None:
    """这个旋钮接受的标量类型。`bool | None` (watermark) → bool; 认不出 → None。

    同样从 dataclass 派生而不是手抄: 加一个旋钮时表会自己跟上, 校验不会悄悄漏掉它。

    取注解走 `typing.get_type_hints` 而不是 `Field.type`: 后者在 image_client 哪天加上
    `from __future__ import annotations` 之后会变成字符串, 于是这里认不出**任何**类型,
    TUNABLE_TYPES 静默变空 —— 校验全体失效, 而且没有任何报错。get_type_hints 两种写法
    都解析成真实类型。
    """
    args = [a for a in typing.get_args(annotation) if a is not type(None)]
    if args:
        return args[0] if isinstance(args[0], type) else None
    return annotation if isinstance(annotation, type) else None


# 旋钮名 → 它接受的标量类型。serializers._validate_tunables 用它在**保存的那一刻**
# 拦下类型不对的值 —— 否则 poll_enabled="false" (非空字符串, 真值) 会静默打开轮询,
# size_mode=123 会在几分钟后的 worker 里炸 AttributeError。
TUNABLE_TYPES: dict[str, type] = {
    name: t
    for name, annotation in typing.get_type_hints(ImageChannel).items()
    if name in _TUNABLE_FIELDS and (t := _scalar_type(annotation)) is not None
}


@dataclasses.dataclass(frozen=True)
class _KindSpec:
    """一种通道类型读哪些旋钮、以及它自己更合适的默认值。"""

    tunables: frozenset[str]
    # 只在跟 ImageChannel 的字段默认值**不同**时才写。既用于表单的占位符, 也真的在
    # channel_for_model 里垫在 provider.defaults 底下 —— 两处同一份, 不会各说一套。
    defaults: dict[str, object] = dataclasses.field(default_factory=dict)


# 每种 kind 真正会读的旋钮。
#
# angle 只读 timeout: 它的"参数"是相机坐标 (画布上那个立方体在控), 请求体由 submit_angle
# 自己拼, 剩下的一个都不看。这条规则以前只写在前端 (一个 ANGLE_TUNABLE_KEYS 集合), 于是
# 后端照样接收、校验、入库、合并那 12 项 —— 用户在 angle 通道上配了 poll_enabled, 存得
# 下去、静默不生效; 反过来 angle 哪天要加旋钮, 后端改完在界面上也不会出现。现在判定只此
# 一处, 并且随 schema 一起下发给前端。
#
# video 是"提交 → 拿 task_id → 长轮询", 所以它读连接超时 + 整套轮询, 但不读任何生图的
# 请求形状旋钮 (image_field / response_format / watermark … 它的请求体是 video.py 自己拼的)。
# 它的默认值跟生图差很远: 生图 60 次 × 5 秒 = 5 分钟内敲 60 下, 而视频要跑 1-5 分钟 ——
# 所以 9 次 × 20 秒起步、退避到 180 秒, 这几个数就是原来 CANVAS_VIDEO_* 的默认值。
KIND_SPECS: dict[str, _KindSpec] = {
    ImageProvider.Kind.IMAGE: _KindSpec(tunables=_TUNABLE_FIELDS),
    ImageProvider.Kind.ANGLE: _KindSpec(tunables=frozenset({"timeout"})),
    ImageProvider.Kind.VIDEO: _KindSpec(
        tunables=frozenset({
            "timeout", "poll_url", "poll_max_attempts",
            "poll_interval", "poll_max_interval", "poll_timeout",
        }),
        defaults={
            "timeout": 60,
            "poll_max_attempts": 9,
            "poll_interval": 20,
            "poll_max_interval": 180,
        },
    ),
}

# 标量类型 → 前端控件。派生而不是让前端自己猜: 前端只认得 JSON 的 string/number/boolean,
# 而 "这个字段是 int 还是 str" 是 ImageChannel 说了算。
_CONTROLS: dict[type, str] = {str: "text", int: "number", bool: "bool"}


def tunables_for_kind(kind: str) -> frozenset[str]:
    """这种 kind 会读的旋钮名。未知 kind 按 image 处理(新增 kind 时默认全给, 而不是全砍)。"""
    return _kind_spec(kind).tunables


def _kind_spec(kind: str) -> _KindSpec:
    return KIND_SPECS.get(kind) or _KindSpec(tunables=_TUNABLE_FIELDS)


def tunable_schema() -> dict[str, list[dict]]:
    """前端配置表单的字段表, 按 kind 分好 —— 从 ImageChannel 的字段声明派生。

    存在的理由: 这张表以前在前端手抄了一份 (13 项, 含控件类型和占位符), i18n 又各一份。
    本模块顶上那条注释警告的正是"手抄的那份会悄悄落后, 表现是在界面上配了却不生效, 而且
    没有任何报错" —— 而那份手抄就是它自己。现在前端照着渲染, 加一个旋钮只需在 ImageChannel
    上加一行 (再补两条翻译)。

    **按 kind 分组下发而不是给每项标一串 kinds**: 占位符是随 kind 变的 (video 的
    poll_interval 默认 20 秒, 生图是 5 秒), 一项一份占位符表达不了; 而且前端拿到就能直接
    渲染, 不用自己再过滤一遍。

    只下发**结构**, 不下发文案: label / hint 是翻译, 留在前端按 key 查, 查不到就退回显示
    key 本身 —— 漏一条翻译只是标签难看, 而不是整个控件消失。
    """
    fields_by_name = {f.name: f for f in dataclasses.fields(ImageChannel)}
    annotations = typing.get_type_hints(ImageChannel)
    out: dict[str, list[dict]] = {}
    for kind, spec in KIND_SPECS.items():
        rows = []
        # 顺序 = dataclass 里的声明顺序 = 表单里的顺序。
        for name, f in fields_by_name.items():
            control = _CONTROLS.get(TUNABLE_TYPES.get(name))
            if control is None or name not in spec.tunables:
                continue
            # 占位符 = 这种 kind 下"不填会得到什么": 优先 kind 自己的默认值, 其次字段默认值。
            # size_mode 这种默认值本身是空、但有个典型取值的, 用 metadata["example"] 覆盖。
            placeholder = spec.defaults.get(
                name, f.metadata.get("example", dataclasses.MISSING),
            )
            if placeholder is dataclasses.MISSING:
                placeholder = f.default
            rows.append({
                "key": name,
                "control": control,
                # False / "" / None / 0 都不值得显示成占位符 —— 空占位符比 "false" 干净。
                "placeholder": "" if placeholder in (None, "", False, 0) else str(placeholder),
                # `bool | None` 的"不填"= 不下发该字段(由供应商自己决定), 其余 = 用我们的
                # 默认。这个区分以前是前端在 watermark 上硬写的一个 emptyKey。
                "empty_label": (
                    "dont_send" if type(None) in typing.get_args(annotations[name]) else "unset"
                ),
            })
        out[str(kind)] = rows
    return out


def channel_for_model(model: ImageModel) -> ImageChannel:
    """把一条 ImageModel (含其 provider) 压成一个可直接调用的通道。

    合并规则: kind 的默认值垫底 → provider.defaults → model.overrides。未知键**丢弃而不是
    报错** —— 配置是用户手填的 JSON, 一个拼错的键不该让整次生成失败; 记一条 warning 就够,
    行为等同于"没配这项"(用 ImageChannel 的字段默认值)。

    最底下那层 kind 默认值是给 video 这种"数量级不同"的通道用的: 它不填轮询参数时该拿到
    9 次 × 20 秒退避到 180 秒, 而不是生图那套 60 次 × 5 秒。表单里的占位符显示的就是这一层
    (同一份 KIND_SPECS.defaults), 所以"界面上看到的灰字"和"真的会用的值"必然一致。
    """
    provider = model.provider
    merged = {
        **_kind_spec(provider.kind).defaults,
        **(provider.defaults or {}),
        **(model.overrides or {}),
    }

    unknown = set(merged) - _TUNABLE_FIELDS
    if unknown:
        logger.warning(
            "image channel %s: 忽略无法识别的配置项 %s",
            model.label, ", ".join(sorted(unknown)),
        )
    known = {k: v for k, v in merged.items() if k in _TUNABLE_FIELDS}

    return ImageChannel(
        base_url=provider.base_url,
        api_key=provider.api_key,
        model=model.model,
        label=f"{provider.label} · {model.label}",
        **known,
    )


def _enabled_model(raw, kind: str) -> ImageModel | None:
    """随请求/随任务行传进来的模型 id → 一条**存在且启用**的记录, 否则 None。

    「哪个模型算可用」的唯一判定处。刻意不抛: 用户随时可能删掉或停用一个配置, 而这个
    id 可能来自前端 localStorage 里的粘性选择, 也可能来自一条早就排好队的任务行。这两种
    情况下"退回默认通道生成"都比"整件事 500"合理。

    `kind` 不是可选的过滤条件而是正确性的一部分: 两种接口形状同住一张表, 不筛的话一个
    angle 通道 (模型名在 URL 路径里、认证是 `Key`) 会被交给生图路径当普通模型用, 请求
    发出去必然失败, 而且失败得莫名其妙。

    UUID 先行解析是必需的而不是防御性的: 不合法的字符串直接进 `.filter(id=...)` 会抛
    django 的 ValidationError, 那就把"选择已失效"变成了一个 500。
    """
    if not raw:
        return None
    try:
        parsed = raw if isinstance(raw, uuid_lib.UUID) else uuid_lib.UUID(str(raw))
    except (AttributeError, TypeError, ValueError):
        logger.warning("image channel: 模型 id %r 格式非法, 回退默认通道", raw)
        return None
    model = (
        ImageModel.objects.filter(id=parsed, enabled=True, provider__kind=kind)
        .select_related("provider")
        .first()
    )
    if model is None:
        logger.warning(
            "image channel: 模型配置 %s 不存在/已禁用/不是 %s 通道, 回退默认通道", parsed, kind,
        )
    return model


def resolve_model_id(raw, kind: str = ImageProvider.Kind.IMAGE) -> uuid_lib.UUID | None:
    """写进 job 行的 `image_model_id` 之前的那一道 —— 必须在**写库前**过。

    前端的选择是粘的 (存 localStorage), 所以一个被删掉的模型 id 会一直跟着每一次请求
    发过来。直接塞进 FK 列的话: 合法 UUID 撞外键约束 → IntegrityError, 不合法字符串 →
    ValidationError, 两种都是把"选择已失效"变成整轮聊天 500。
    """
    model = _enabled_model(raw, kind)
    return model.id if model is not None else None


def channel_or_default(raw, kind: str = ImageProvider.Kind.IMAGE) -> ImageChannel | None:
    """「选中的那条, 没选/已失效就退到库里第一条」—— 生图和 angle 走的是同一条阶梯。

    一个函数而不是在两处各拼一遍: 那两份抄写已经分叉过一次 (一边补了"是哪个通道挂的"
    报错文案, 另一边没有)。

    退到第一条只有两种触发: 任务排队期间选中的那条被删了, 或者调用方(老的入队路径 /
    agent 没传 model 参数)本来就没带选择。前端选择器会自动落位到列表第一项, 所以正常
    使用不依赖它。排序跟选择器一致 (sort_order, label), 两边的"第一条"是同一条。
    """
    model = _enabled_model(raw, kind) or (
        ImageModel.objects.filter(enabled=True, provider__kind=kind)
        .select_related("provider")
        .first()
    )
    return channel_for_model(model) if model is not None else None
