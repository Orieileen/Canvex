"""给已经建好的视频通道补上「比例发到哪个键」。

背景: apimart 一半视频模型的比例参数叫 `aspect_ratio`, 另一半叫 `size`
(seedance-2.0 那页的对比表:「1.5 Pro: aspect_ratio | 2.0: **size**」)。起点模板一直只
写了前者, 所以后一半模型的比例下拉**一直是死旋钮** —— 不是被忽略, 是键名不对, 它们始终
按自己的默认出片, 而界面上完全看不出来。

**两件事必须一起做, 顺序不能反**:
  1. 往通道的 request_template.body 里补一个 `"size": "{{size}}"`
  2. 给那 11 个模型的 overrides 写上 `ratio_param: "size"`
只做 2 不做 1 的话, 模板里没有那个占位符 = 渲染不出来 = 比例键**整个消失**, 比现在还糟。
所以下面对每条通道先补模板, **补成功了才**动它底下的模型; 认不出形状的通道整条跳过。

只动 kind=custom_video、body 里有 `{{aspect_ratio}}` 且还没有 `size` 键的通道 —— 自己
改过模板的人不受影响。反向迁移把两样都撤掉。
"""
from django.db import migrations

# 跟 image_channels._APIMART_VIDEO_SIZE_MODELS 同一份名单。这里写死一份而不是 import:
# 迁移是历史快照, 跟着那张表漂会让"这次迁移当时做了什么"变得不可复现。
_SIZE_MODELS = frozenset({
    "seedance-2.0", "seedance-2.0-fast", "seedance-2.0-mini",
    "seedance-2.0-face", "seedance-2.0-fast-face",
    "wan2.5-preview", "wan2.7", "pixverse-v6",
    "happyhorse-1.0", "happyhorse-1.1", "grok-imagine-1.5-video-apimart",
})


def _forward(apps, schema_editor):
    ImageProvider = apps.get_model("studio", "ImageProvider")
    ImageModel = apps.get_model("studio", "ImageModel")
    for p in ImageProvider.objects.filter(kind="custom_video"):
        tpl = dict(p.request_template or {})
        body = tpl.get("body")
        if not isinstance(body, dict):
            continue
        if body.get("aspect_ratio") != "{{aspect_ratio}}" or "size" in body:
            continue  # 不是我们那个起点的形状, 或者已经有了 —— 别碰别人的模板
        body = {**body, "size": "{{size}}"}
        tpl["body"] = body
        p.request_template = tpl
        p.save(update_fields=["request_template"])
        # 模板补好了, 现在才敢让模型指向 size。
        for m in ImageModel.objects.filter(provider_id=p.id):
            if m.model not in _SIZE_MODELS:
                continue
            overrides = dict(m.overrides or {})
            if overrides.get("ratio_param"):
                continue
            overrides["ratio_param"] = "size"
            m.overrides = overrides
            m.save(update_fields=["overrides"])


def _backward(apps, schema_editor):
    ImageProvider = apps.get_model("studio", "ImageProvider")
    ImageModel = apps.get_model("studio", "ImageModel")
    # 名单和取值都要对上才动 —— 反向迁移只该撤掉**这条迁移写进去的**那些, 不该顺手抹掉
    # 用户自己在别的模型上手配的 ratio_param (同 0025 的 _backward)。
    for m in ImageModel.objects.filter(provider__kind="custom_video"):
        if m.model not in _SIZE_MODELS:
            continue
        overrides = dict(m.overrides or {})
        if overrides.pop("ratio_param", None) == "size":
            m.overrides = overrides
            m.save(update_fields=["overrides"])
    for p in ImageProvider.objects.filter(kind="custom_video"):
        tpl = dict(p.request_template or {})
        body = tpl.get("body")
        if isinstance(body, dict) and body.get("size") == "{{size}}":
            body = {k: v for k, v in body.items() if k != "size"}
            tpl["body"] = body
            p.request_template = tpl
            p.save(update_fields=["request_template"])


class Migration(migrations.Migration):

    dependencies = [("studio", "0023_video_ratio_scope")]

    operations = [migrations.RunPython(_forward, _backward)]
