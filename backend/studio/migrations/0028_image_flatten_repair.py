"""给会把透明压平成黑底的模型补上 flatten_repair=True。

apimart 转发 gpt-image-2 时, 模型返回的透明 PNG 到我们手上变成了 RGB 黑底 —— 实测三张
样本 54% / 54% / 72% 的像素是**比特级全零**, 主体边缘是一条平滑爬升的斜坡。那是 RGBA
合成到黑底的指纹, 不是模型画出来的。表现: 用户拿一张白底产品图去编辑, 回来是黑底。

同 0023 / 0024 / 0025: 预设只在建通道时套用一次, 存量行不会自己长出这个覆盖。

**不需要 schema 迁移** —— 旋钮存在 ImageModel.overrides 这个 JSONField 里,
ImageChannel 只是个 dataclass。这条纯粹是给已经建好的行补数据。

⚠️ 认这家用的是 _HOSTS(新旧域名都认), **不是** 0023 / 0025 里那句
`"apimart" in base_url` —— 0027 把域名换成 apib.ai 之后那个写法永远匹配不到了。
"""
from django.db import migrations

#: 跟 image_channels._APIMART_IMAGE_ALPHA_FLATTENED 同一份名单。这里写死一份而不是
#: import: 迁移记录的是**当时**的事实, 而那张表会随着实测继续加模型 —— import 的话,
#: 这条迁移的行为会在半年后被一次无关的改动悄悄改掉。
_FLATTENED = frozenset({"gpt-image-2"})

#: 同 0027 的 _HOSTS。apib.ai 是 apimart 的大陆可访问域名, 两个都要认。
_HOSTS = ("api.apib.ai", "api.apimart.ai")


def _forward(apps, schema_editor):
    ImageModel = apps.get_model("studio", "ImageModel")
    for m in ImageModel.objects.filter(provider__kind="custom_image").select_related("provider"):
        base_url = m.provider.base_url or ""
        if m.model not in _FLATTENED or not any(h in base_url for h in _HOSTS):
            continue
        overrides = dict(m.overrides or {})
        # `in` 而不是 `.get()`: 用户显式关掉 (False) 是一个决定, 不是"还没配"。
        if "flatten_repair" in overrides:
            continue
        overrides["flatten_repair"] = True
        m.overrides = overrides
        m.save(update_fields=["overrides"])


def _backward(apps, schema_editor):
    ImageModel = apps.get_model("studio", "ImageModel")
    for m in ImageModel.objects.filter(provider__kind="custom_image"):
        overrides = dict(m.overrides or {})
        if m.model in _FLATTENED and overrides.get("flatten_repair") is True:
            overrides.pop("flatten_repair")
            m.overrides = overrides
            m.save(update_fields=["overrides"])


class Migration(migrations.Migration):

    dependencies = [("studio", "0027_apimart_to_apib_domain")]

    operations = [migrations.RunPython(_forward, _backward)]
