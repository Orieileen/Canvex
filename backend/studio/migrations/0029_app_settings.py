"""全局偏好表, 外加把 flatten_repair 从通道覆盖项里搬过来。

0028 把 `flatten_repair` 写进了 apimart gpt-image-2 的 ImageModel.overrides —— 当时它是
一条"这个模型有这个毛病"的 per-model 事实。现在它变成了**全局偏好**(侧栏上一个默认打开
的开关), 因为:

- 会压平 alpha 的是**中转层**, 不是模型本身。今天只在 gpt-image-2 上见到, 明天换一家
  中转就可能出现在别的模型上, 而用户不该为此去逐个模型打开一个勾。
- 识别本身很挑剔 (比特级全零 + 连到边界 + 占比够), 认不出就一个字节都不动 —— 所以
  "对所有模型都检查一下"的代价只是每张图几十毫秒, 而收益是这个毛病再也不用配置。

留在 overrides 里的那一项现在没有任何代码会读, 顺手清掉 —— 留着的话, 下一个人会以为
通道那边还有一个开关, 然后花时间找它为什么不起作用。
"""
from django.db import migrations, models


def _drop_channel_override(apps, schema_editor):
    ImageModel = apps.get_model("studio", "ImageModel")
    for m in ImageModel.objects.filter(overrides__has_key="flatten_repair"):
        overrides = dict(m.overrides or {})
        overrides.pop("flatten_repair", None)
        m.overrides = overrides
        m.save(update_fields=["overrides"])


def _noop(apps, schema_editor):
    """不可逆但无损: 0028 会在回滚到它之前重新写上。"""


class Migration(migrations.Migration):

    dependencies = [
        ('studio', '0028_image_flatten_repair'),
    ]

    operations = [
        migrations.CreateModel(
            name='AppSetting',
            fields=[
                ('id', models.PositiveSmallIntegerField(default=1, editable=False, primary_key=True, serialize=False)),
                ('flatten_repair', models.BooleanField(default=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'verbose_name': 'Canvas App Setting',
                'verbose_name_plural': 'Canvas App Settings',
                'db_table': 'canvas_app_settings',
            },
        ),
        migrations.RunPython(_drop_channel_override, _noop),
    ]
