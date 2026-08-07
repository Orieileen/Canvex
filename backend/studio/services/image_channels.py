"""库里的供应商配置 → ImageChannel。

`image_client.ImageChannel` 是「一次生图调用需要的全部参数」。它有两个来源:

- `image_client.channel_from_env(prefix)` —— 老路径, env 里的 PRIMARY / FALLBACK
- 本模块 `channel_for_model(model)` —— 用户在前端配的 ImageProvider / ImageModel

下游 (`_single_generation` / `build_image_client`) 只认那个 dataclass, 不知道也不关心
配置从哪来。所以这一层是唯一需要理解「两层记录如何合并」的地方。
"""
import logging

from studio.models import ImageModel
from studio.services.image_client import ImageChannel

logger = logging.getLogger(__name__)

# ImageChannel 里由 provider.defaults / model.overrides 提供的字段。base_url /
# api_key / model / label 不在其中 —— 它们有各自的来源, 不走 JSON 合并。
_TUNABLE_FIELDS = frozenset({
    "image_field", "image_as_single", "response_format", "quality", "watermark",
    "inline_image", "timeout", "size_mode",
    "poll_enabled", "poll_url", "poll_max_attempts", "poll_interval", "poll_timeout",
})


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


def channel_for_model_id(model_id) -> ImageChannel | None:
    """按 id 取通道; 找不到 / 已禁用 → None, 由调用方回退到 env 通道。

    刻意不抛: 用户可能删掉了一个模型配置, 而某个老任务行上还存着它的 id (FK 是
    SET_NULL, 但 agent 路径的 id 是随请求传的, 不受约束)。这种情况下"用默认通道生成"
    比"整次任务失败"合理。
    """
    if not model_id:
        return None
    model = (
        ImageModel.objects.filter(id=model_id, enabled=True)
        .select_related("provider")
        .first()
    )
    if model is None:
        logger.warning("image channel: 模型配置 %s 不存在或已禁用, 回退默认通道", model_id)
        return None
    return channel_for_model(model)
