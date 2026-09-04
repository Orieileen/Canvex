"""给已经建好的视频通道补上 `ratio_scope`。

新建的通道会从预设里带上它 (image_channels 的 _APIMART_VIDEO_T2V_ONLY → model_overrides),
但预设只在**建通道时**套用一次。不补的话升级之后 viduq3-pro / viduq3-turbo 照旧每次都在
发一个文档明写禁止的组合 (「只要传入 image_urls, 就不能同时设置 aspect_ratio」), 而用户
不知道要去哪个模型的覆盖里手填一个没见过的键。

只动 kind=custom_video + base_url 指向 apimart + 还没配过 ratio_scope 的行, 所以对自己
改过配置的人是无操作。反向迁移把它去掉。
"""
from django.db import migrations

# 跟 image_channels._APIMART_VIDEO_T2V_ONLY 同一份名单。这里写死一份而不是 import ——
# 迁移是历史快照, 跟着那张表一起漂会让"这次迁移当时做了什么"变得不可复现。
_T2V_ONLY = frozenset({
    "viduq3-pro", "viduq3-turbo", "sora-2", "sora-2-pro", "wan2.6", "wan2.5-preview",
})
_SCOPE = "text_only"


def _forward(apps, schema_editor):
    ImageModel = apps.get_model("studio", "ImageModel")
    for m in ImageModel.objects.filter(provider__kind="custom_video").select_related("provider"):
        if m.model not in _T2V_ONLY:
            continue
        if "apimart" not in (m.provider.base_url or ""):
            continue
        overrides = dict(m.overrides or {})
        if overrides.get("ratio_scope"):
            continue
        overrides["ratio_scope"] = _SCOPE
        m.overrides = overrides
        m.save(update_fields=["overrides"])


def _backward(apps, schema_editor):
    ImageModel = apps.get_model("studio", "ImageModel")
    for m in ImageModel.objects.filter(provider__kind="custom_video"):
        overrides = dict(m.overrides or {})
        if overrides.pop("ratio_scope", None) == _SCOPE:
            m.overrides = overrides
            m.save(update_fields=["overrides"])


class Migration(migrations.Migration):

    dependencies = [("studio", "0022_apimart_video_upload_path")]

    operations = [migrations.RunPython(_forward, _backward)]
