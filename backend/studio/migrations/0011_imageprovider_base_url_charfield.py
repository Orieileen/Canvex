# base_url: URLField → CharField + 自己的 http(s) 校验器。
#
# 原因: django 的 URLValidator 只把 `localhost` 当特例, 别的**单段主机名**一律判非法 ——
# 而 compose 里另一个容器的地址正好是单段的 (`http://ollama:11434` /
# `http://comfyui:8188`)。用 URLField 会把"接本机 / 同网段推理服务"这个自部署项目最想
# 支持的场景挡在"请输入合法的 URL"后面。
#
# 库层面是同一个 varchar(500), 这条只是把 django 的字段状态对齐。

import studio.models
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("studio", "0010_import_angle_env"),
    ]

    operations = [
        migrations.AlterField(
            model_name="imageprovider",
            name="base_url",
            field=models.CharField(
                max_length=500, validators=[studio.models.validate_endpoint_url],
            ),
        ),
    ]
