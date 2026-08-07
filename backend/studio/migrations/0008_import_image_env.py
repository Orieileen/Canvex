# 把 env 里现有的 CANVAS_IMAGE_PRIMARY / _FALLBACK 配置导入成库记录, 只导一次。
#
# 为什么放数据迁移而不是管理命令: 现有部署 env 里配好的东西不能因为这次改造就失效, 而
# "起来之后记得跑一条命令"必然会被忘。migrate 在容器启动命令里, 走这条路等于自动完成。
#
# 幂等: 库里已经有任何 provider 就整个跳过 —— 用户后来在前端配的东西, 不该被一次
# re-migrate 覆盖或加倍。env 没配则什么也不做 (全新部署直接在前端配)。

import os

from django.db import migrations

_PREFIXES = ("CANVAS_IMAGE_PRIMARY", "CANVAS_IMAGE_FALLBACK")

# env 后缀 → ImageChannel/JSON 字段名 + 类型。与 image_client.channel_from_env 保持一致。
_STR_FIELDS = {
    "IMAGE_FIELD": "image_field",
    "RESPONSE_FORMAT": "response_format",
    "QUALITY": "quality",
    "SIZE_MODE": "size_mode",
    "POLL_URL": "poll_url",
}
_BOOL_FIELDS = {
    "IMAGE_AS_SINGLE": "image_as_single",
    "INLINE_IMAGE": "inline_image",
    "POLL_ENABLED": "poll_enabled",
}
_INT_FIELDS = {
    "TIMEOUT": "timeout",
    "POLL_MAX_ATTEMPTS": "poll_max_attempts",
    "POLL_INTERVAL": "poll_interval",
    "POLL_TIMEOUT": "poll_timeout",
}


def _env(key: str) -> str:
    return (os.getenv(key) or "").strip()


def _as_bool(raw: str) -> bool:
    return raw.lower() in ("1", "true", "yes", "on")


def _defaults_for(prefix: str) -> dict:
    out: dict = {}
    for suffix, field in _STR_FIELDS.items():
        if (v := _env(f"{prefix}_{suffix}")):
            out[field] = v
    for suffix, field in _BOOL_FIELDS.items():
        if (v := _env(f"{prefix}_{suffix}")):
            out[field] = _as_bool(v)
    for suffix, field in _INT_FIELDS.items():
        if (v := _env(f"{prefix}_{suffix}")):
            try:
                out[field] = int(v)
            except ValueError:
                pass
    # tri-state: 未设 → 不写这一项 (下发时用供应商默认); 设了才显式 true/false
    if (v := _env(f"{prefix}_WATERMARK")):
        out["watermark"] = _as_bool(v)
    return out


def import_env(apps, schema_editor):
    ImageProvider = apps.get_model("studio", "ImageProvider")
    ImageModel = apps.get_model("studio", "ImageModel")

    if ImageProvider.objects.exists():
        return  # 用户已经在前端配过了, 不碰

    for order, prefix in enumerate(_PREFIXES):
        model_name = _env(f"{prefix}_MODEL")
        base_url = _env(f"{prefix}_BASE_URL") or _env("OPENAI_BASE_URL")
        api_key = _env(f"{prefix}_API_KEY") or _env("OPENAI_API_KEY")
        if not (model_name and base_url and api_key):
            continue  # 这条通道没配全 (fallback 常常就没配), 跳过

        label = "主通道" if prefix.endswith("PRIMARY") else "备用通道"
        provider = ImageProvider.objects.create(
            label=label, base_url=base_url, api_key=api_key, defaults=_defaults_for(prefix),
        )
        ImageModel.objects.create(
            provider=provider, label=model_name, model=model_name, sort_order=order,
        )


def noop_reverse(apps, schema_editor):
    """不自动删: 回滚迁移时把用户可能已经编辑过的配置删掉, 比留着危险得多。"""


class Migration(migrations.Migration):

    dependencies = [
        ("studio", "0007_image_provider_config"),
    ]

    operations = [
        migrations.RunPython(import_env, noop_reverse),
    ]
