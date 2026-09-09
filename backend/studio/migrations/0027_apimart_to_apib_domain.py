"""存量通道的 api.apimart.ai → api.apib.ai。

apib.ai 是 apimart 的**大陆可访问域名** —— 同一家、同一套接口、同一把 key,
而 api.apimart.ai 在墙内连不上。这个项目的用户主要在大陆, 所以预设改成了 apib.ai
(见 image_channels 的 apimart_image / apimart_video)。

但预设**只在建通道时套用一次**, 已经建好的行不会自己改域名 —— 那些用户会继续对着
一个连不上的地址发请求, 表现是超时/DNS 失败, 而不是一句"域名不对"。

换的是**域名而不是整个 URL**: 路径原样留着, 所以 `/v1` 和 curl 导入的轮询地址
(`.../v1/tasks/{{task_id}}?language=zh`) 都不会坏。`request_template` 和 `defaults`
一起过一遍 —— 轮询地址是存在模板里的, 只改 base_url 会留下一半旧域名。

对外仍然叫 **apimart**(UI 的 label、README):那是这家公司的名字, 变的只是域名。

⚠️ 给后来写迁移的人: 0023 / 0025 里那种 `"apimart" in provider.base_url` 的判断,
在这条跑完之后**永远匹配不到**了 —— "apib.ai" 里没有 "apimart" 这个子串。要认这家,
用下面的 _HOSTS(新旧都认), 不要再抄那个写法。
"""
import json

from django.db import migrations

_OLD_HOST = "api.apimart.ai"
_NEW_HOST = "api.apib.ai"

#: 认这家的正确方式 —— 新旧域名都算。
_HOSTS = (_NEW_HOST, _OLD_HOST)

_JSON_FIELDS = ("defaults", "request_template")


def _swap(provider, old, new):
    """把 provider 上所有出现的 old 域名换成 new。返回改过的字段名。"""
    touched = []

    if old in (provider.base_url or ""):
        provider.base_url = provider.base_url.replace(old, new)
        touched.append("base_url")

    for field in _JSON_FIELDS:
        value = getattr(provider, field, None)
        if not value:
            continue
        # 走 JSON 文本做替换, 而不是递归遍历: 域名可能出现在任意深度的任意键上
        # (轮询 URL、上传端点、header 里的 referer...), 遍历写法会漏。
        text = json.dumps(value)
        if old not in text:
            continue
        setattr(provider, field, json.loads(text.replace(old, new)))
        touched.append(field)

    return touched


def _rewrite(apps, old, new):
    ImageProvider = apps.get_model("studio", "ImageProvider")
    for provider in ImageProvider.objects.all():
        touched = _swap(provider, old, new)
        if touched:
            provider.save(update_fields=touched)


def _forward(apps, schema_editor):
    _rewrite(apps, _OLD_HOST, _NEW_HOST)


def _backward(apps, schema_editor):
    _rewrite(apps, _NEW_HOST, _OLD_HOST)


class Migration(migrations.Migration):

    dependencies = [("studio", "0026_image_job_resolution_free_form")]

    operations = [migrations.RunPython(_forward, _backward)]
