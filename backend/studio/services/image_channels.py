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


def _scalar_type(f: dataclasses.Field) -> type | None:
    """这个旋钮接受的标量类型。`bool | None` (watermark) → bool; 认不出 → None。

    同样从 dataclass 派生而不是手抄: 加一个旋钮时表会自己跟上, 校验不会悄悄漏掉它。
    """
    args = [a for a in typing.get_args(f.type) if a is not type(None)]
    if args:
        return args[0] if isinstance(args[0], type) else None
    if isinstance(f.type, type):
        return f.type
    # `from __future__ import annotations` 会让 f.type 变成字符串, 那时退到默认值的类型
    return type(f.default) if f.default is not None else None


# 旋钮名 → 它接受的标量类型。serializers._validate_tunables 用它在**保存的那一刻**
# 拦下类型不对的值 —— 否则 poll_enabled="false" (非空字符串, 真值) 会静默打开轮询,
# size_mode=123 会在几分钟后的 worker 里炸 AttributeError。
TUNABLE_TYPES: dict[str, type] = {
    f.name: t
    for f in dataclasses.fields(ImageChannel)
    if f.name in _TUNABLE_FIELDS and (t := _scalar_type(f)) is not None
}


def channel_for_model(model: ImageModel) -> ImageChannel:
    """把一条 ImageModel (含其 provider) 压成一个可直接调用的通道。

    合并规则: provider.defaults 打底, model.overrides 覆盖。未知键**丢弃而不是报错** ——
    配置是用户手填的 JSON, 一个拼错的键不该让整次生成失败; 记一条 warning 就够, 行为
    等同于"没配这项"(用 ImageChannel 的字段默认值)。
    """
    provider = model.provider
    merged = {**(provider.defaults or {}), **(model.overrides or {})}

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


def channel_for_model_id(model_id, kind: str = ImageProvider.Kind.IMAGE) -> ImageChannel | None:
    """任务行上的选择 → 通道; 找不到 / 已禁用 → None, 由调用方回退到默认通道。

    与 resolve_model_id 的区别只是返回什么: 那个在入队前把 id 择干净, 这个在 worker
    里把它变成可调用的通道。中间隔着一段真实的时间 —— 配置可能在排队期间被删掉。
    """
    model = _enabled_model(model_id, kind)
    return channel_for_model(model) if model is not None else None


def default_channel(kind: str = ImageProvider.Kind.IMAGE) -> ImageChannel | None:
    """库里配好的第一条启用模型 —— 调用方没带选择时的兜底; 一条都没有则 None。

    现在只有两种情况会走到这: 任务排队期间选中的那条被删了, 或者调用方(老的入队路径 /
    agent 没传 model 参数)本来就没带选择。前端的选择器会自动落位到列表第一项, 所以正常
    使用不会依赖这里。排序跟选择器一致 (sort_order, label), 两边"第一条"是同一条。
    """
    model = (
        ImageModel.objects.filter(enabled=True, provider__kind=kind)
        .select_related("provider")
        .first()
    )
    return channel_for_model(model) if model is not None else None


def channel_or_default(raw, kind: str = ImageProvider.Kind.IMAGE) -> ImageChannel | None:
    """「选中的那条, 没选/已失效就退到库里第一条」—— 生图和 angle 用的是同一条阶梯。

    写成一个函数而不是在两处各拼一遍 `channel_for_model_id(...) or default_channel(...)`:
    两份抄写已经开始分叉一次了 (一边补了"是哪个通道挂的"的报错文案, 另一边没有)。
    """
    return channel_for_model_id(raw, kind) or default_channel(kind)
