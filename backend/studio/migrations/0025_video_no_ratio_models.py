"""给"整页没有比例参数"的四个模型补上 ratio_param="" (= 一个比例键都不发)。

MiniMax-Hailuo-02 / -2.3 / -2.3-Fast / wan2.6-i2v-flash 的文档里只有 resolution 一档
旋钮, 根本没有 aspect_ratio / size。发了只是多一个被丢掉的键, 而工具栏上那个比例下拉是
纯装饰 —— 用户选了 9:16, 出来永远是模型自己的画幅, 没有任何提示。

同 0023 / 0024: 预设只在建通道时套用一次, 存量行不会自己长出这个覆盖。

这条**不需要**像 0024 那样先补模板 —— 它是"少发一个键", 模板里有没有那个占位符都不影响
(渲染成空 = 键消失)。
"""
from django.db import migrations

_NO_RATIO = frozenset({
    "MiniMax-Hailuo-02", "MiniMax-Hailuo-2.3", "MiniMax-Hailuo-2.3-Fast",
    "wan2.6-i2v-flash",
})


def _forward(apps, schema_editor):
    ImageModel = apps.get_model("studio", "ImageModel")
    for m in ImageModel.objects.filter(provider__kind="custom_video").select_related("provider"):
        if m.model not in _NO_RATIO or "apimart" not in (m.provider.base_url or ""):
            continue
        overrides = dict(m.overrides or {})
        # `in` 而不是 `.get()`: 这一项的合法值就是空串, 用真假判会把已经配好的当成没配。
        if "ratio_param" in overrides:
            continue
        overrides["ratio_param"] = ""
        m.overrides = overrides
        m.save(update_fields=["overrides"])


def _backward(apps, schema_editor):
    ImageModel = apps.get_model("studio", "ImageModel")
    for m in ImageModel.objects.filter(provider__kind="custom_video"):
        overrides = dict(m.overrides or {})
        if m.model in _NO_RATIO and overrides.get("ratio_param", "sentinel") == "":
            overrides.pop("ratio_param")
            m.overrides = overrides
            m.save(update_fields=["overrides"])


class Migration(migrations.Migration):

    dependencies = [("studio", "0024_video_ratio_param")]

    operations = [migrations.RunPython(_forward, _backward)]
