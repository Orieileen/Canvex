"""库里的供应商配置 → ImageChannel。

`image_client.ImageChannel` 是「一次生图调用需要的全部参数」。它有两个来源:

- `image_client.channel_from_env(prefix)` —— 老路径, env 里的 PRIMARY / FALLBACK
- 本模块 `channel_for_model(model)` —— 用户在前端配的 ImageProvider / ImageModel

下游 (`_single_generation` / `build_image_client`) 只认那个 dataclass, 不知道也不关心
配置从哪来。所以这一层是唯一需要理解「两层记录如何合并」的地方。
"""
import dataclasses
import logging
import uuid as uuid_lib

from studio.models import ImageModel
from studio.services.image_client import ImageChannel

logger = logging.getLogger(__name__)

# base_url / api_key / model / label 有各自的来源, 不走 JSON 合并; ImageChannel 上
# 其余的字段就是可调项。从 dataclass 派生而不是手抄一份 —— 手抄的那份会在有人给
# ImageChannel 加旋钮时悄悄落后, 表现是"在界面上配了却不生效", 而且没有任何报错。
_NON_TUNABLE_FIELDS = frozenset({"base_url", "api_key", "model", "label"})
_TUNABLE_FIELDS = frozenset(
    f.name for f in dataclasses.fields(ImageChannel)
) - _NON_TUNABLE_FIELDS


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


def _enabled_model(raw) -> ImageModel | None:
    """随请求/随任务行传进来的模型 id → 一条**存在且启用**的记录, 否则 None。

    「哪个模型算可用」的唯一判定处。刻意不抛: 用户随时可能删掉或停用一个配置, 而这个
    id 可能来自前端 localStorage 里的粘性选择, 也可能来自一条早就排好队的任务行。这两种
    情况下"退回默认通道生成"都比"整件事 500"合理。

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
        ImageModel.objects.filter(id=parsed, enabled=True)
        .select_related("provider")
        .first()
    )
    if model is None:
        logger.warning("image channel: 模型配置 %s 不存在或已禁用, 回退默认通道", parsed)
    return model


def resolve_model_id(raw) -> uuid_lib.UUID | None:
    """写进 `ImageEditJob.image_model_id` 之前的那一道 —— 必须在**写库前**过。

    前端的选择是粘的 (存 localStorage), 所以一个被删掉的模型 id 会一直跟着每一次请求
    发过来。直接塞进 FK 列的话: 合法 UUID 撞外键约束 → IntegrityError, 不合法字符串 →
    ValidationError, 两种都是把"选择已失效"变成整轮聊天 500。
    """
    model = _enabled_model(raw)
    return model.id if model is not None else None


def channel_for_model_id(model_id) -> ImageChannel | None:
    """任务行上的选择 → 通道; 找不到 / 已禁用 → None, 由调用方回退到默认通道。

    与 resolve_model_id 的区别只是返回什么: 那个在入队前把 id 择干净, 这个在 worker
    里把它变成可调用的通道。中间隔着一段真实的时间 —— 配置可能在排队期间被删掉。
    """
    model = _enabled_model(model_id)
    return channel_for_model(model) if model is not None else None


def default_channel() -> ImageChannel | None:
    """库里配好的第一条启用模型 —— 用户没选、env 也没配时的兜底; 都没有则 None。

    存在的理由: 这次改造的目标是"生图相关的 env 变量为 0"。没有这一步的话, 一个全新
    部署即使在界面上把供应商配得好好的, 只要工具栏停在「后端默认」(默认就是停在这里),
    就会收到一句 `缺少环境变量: CANVAS_IMAGE_PRIMARY_BASE_URL…` —— 一个界面上从头到尾
    没提过的东西。排序跟工具栏选择器一致 (sort_order, label), 所以"默认"就是列表第一项。
    """
    model = ImageModel.objects.filter(enabled=True).select_related("provider").first()
    return channel_for_model(model) if model is not None else None
