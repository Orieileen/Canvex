"""给已经建好的 apimart 视频通道补上 `upload_path`。

新加的通道会从预设里带上它 (image_channels 里 apimart_video 那条的 defaults), 但预设只
在**建通道时**套用一次 —— 已经存在的那条不会自己长出新字段, 表现是升级之后图生视频
照旧失败, 而用户根本不知道要去配置面板里填一个没见过的格子。

只动符合三个条件的行 (kind=custom_video + base_url 指向 apimart + 还没配过 upload_path),
所以对自己改过配置的人是无操作。反向迁移把它去掉。
"""
from django.db import migrations

_PATH = "/uploads/images"


def _forward(apps, schema_editor):
    ImageProvider = apps.get_model("studio", "ImageProvider")
    for p in ImageProvider.objects.filter(kind="custom_video"):
        if "apimart" not in (p.base_url or ""):
            continue
        defaults = dict(p.defaults or {})
        if defaults.get("upload_path"):
            continue
        defaults["upload_path"] = _PATH
        p.defaults = defaults
        p.save(update_fields=["defaults"])


def _backward(apps, schema_editor):
    ImageProvider = apps.get_model("studio", "ImageProvider")
    for p in ImageProvider.objects.filter(kind="custom_video"):
        defaults = dict(p.defaults or {})
        if defaults.pop("upload_path", None) == _PATH:
            p.defaults = defaults
            p.save(update_fields=["defaults"])


class Migration(migrations.Migration):

    dependencies = [("studio", "0021_videojob_resolution")]

    operations = [migrations.RunPython(_forward, _backward)]
