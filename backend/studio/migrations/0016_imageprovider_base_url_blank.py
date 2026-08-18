# base_url 允许留空 —— 只为聊天通道。
#
# 原因: 聊天通道留空 = 走 OpenAI 官方端点 (builder 里 `channel.base_url or None`),
# 迁移 0015 导进来的那条存的正是空串。但字段是 blank=False, 于是 DRF 把它渲染成
# allow_blank=False —— 那条被导进来的记录在配置面板里一按保存就 400, 而按界面提示
# 「留空 = 用 OpenAI 官方的」新建一条聊天通道更是从来就建不出来。
#
# 「哪些 kind 允许留空」不在字段上判 (字段级校验看不到 kind), 由
# ImageProviderSerializer.validate 按 kind 拦: 除 chat 外仍然必填。
#
# 库层面是同一个 varchar(500), 这条只是把 django 的字段状态对齐。

import studio.models
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("studio", "0015_import_chat_env"),
    ]

    operations = [
        migrations.AlterField(
            model_name="imageprovider",
            name="base_url",
            field=models.CharField(
                blank=True, max_length=500,
                validators=[studio.models.validate_endpoint_url],
            ),
        ),
    ]
