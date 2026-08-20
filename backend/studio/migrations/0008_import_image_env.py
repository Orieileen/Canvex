# 把 env 里现有的 CANVAS_IMAGE_PRIMARY / _FALLBACK 配置导入成库记录, 只导一次。
#
# 为什么放数据迁移而不是管理命令: 现有部署 env 里配好的东西不能因为这次改造就失效, 而
# "起来之后记得跑一条命令"必然会被忘。migrate 在容器启动命令里, 走这条路等于自动完成。
#
# 幂等: 库里已经有任何 provider 就整个跳过 —— 用户后来在前端配的东西, 不该被一次
# re-migrate 覆盖或加倍。env 没配则什么也不做 (全新部署直接在前端配)。

from django.db import migrations

from studio.services.listings_utils import env, env_bool, env_int

_PREFIXES = ("CANVAS_IMAGE_PRIMARY", "CANVAS_IMAGE_FALLBACK")

# env 后缀 → (JSON 字段名, 读取函数)。一张表 + 一个循环, 三种类型只差读法。
#
# 读取函数直接复用 listings_utils 的那三个 —— channel_from_env 用的就是它们, 自己再
# 抄一遍必然分叉 (这里原本多认了一个 "on", 意味着同一份 env 在迁移前后表现相反)。它们
# 是纯函数、不碰模型, 所以"迁移不该 import 应用代码"那条规矩在这里不适用。
#
# 这张表**不能**直接换成调用 channel_from_env: 那个会把每个字段的默认值都算出来, 而
# 这里只想写用户**显式设过**的键 —— 没设的项留空, 将来 ImageChannel 改了默认值, 老配置
# 才会跟着走。
_FIELDS = {
    "IMAGE_FIELD": ("image_field", env),
    "RESPONSE_FORMAT": ("response_format", env),
    "QUALITY": ("quality", env),
    "SIZE_MODE": ("size_mode", env),
    "POLL_URL": ("poll_url", env),
    "IMAGE_AS_SINGLE": ("image_as_single", env_bool),
    "INLINE_IMAGE": ("inline_image", env_bool),
    "POLL_ENABLED": ("poll_enabled", env_bool),
    # 未设 → 不写这一项 (下发时用供应商默认), 设了才显式 true/false。这跟其他 bool
    # 同一个规则, 不需要单独一段。
    "WATERMARK": ("watermark", env_bool),
    "TIMEOUT": ("timeout", env_int),
    "POLL_MAX_ATTEMPTS": ("poll_max_attempts", env_int),
    "POLL_INTERVAL": ("poll_interval", env_int),
    "POLL_TIMEOUT": ("poll_timeout", env_int),
}


def _defaults_for(prefix: str) -> dict:
    """只收 env 里**显式设过**的键。"""
    out: dict = {}
    for suffix, (field, read) in _FIELDS.items():
        key = f"{prefix}_{suffix}"
        if not env(key):
            continue
        # env_int 需要一个 default; 走到这里说明这个键非空, 但可能不是数字 ——
        # env_int 对非数字返回 default, 用哨兵识别出来并跳过, 跟没设过一样。
        value = read(key, -1) if read is env_int else read(key)
        if read is env_int and value == -1:
            continue
        out[field] = value
    return out


def import_env(apps, schema_editor):
    ImageProvider = apps.get_model("studio", "ImageProvider")
    ImageModel = apps.get_model("studio", "ImageModel")

    if ImageProvider.objects.exists():
        return  # 用户已经在前端配过了, 不碰

    for order, prefix in enumerate(_PREFIXES):
        model_name = env(f"{prefix}_MODEL")
        base_url = env(f"{prefix}_BASE_URL") or env("OPENAI_BASE_URL")
        api_key = env(f"{prefix}_API_KEY") or env("OPENAI_API_KEY")
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
