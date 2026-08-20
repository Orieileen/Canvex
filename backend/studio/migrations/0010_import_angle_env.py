# 把 env 里现有的 CANVAS_ANGLE_FAL_* 配置导入成一条 kind=angle 的库记录, 只导一次。
#
# 跟 0008 同一个理由: 现有部署 env 里配好的 angle 通道不能因为这次改造就失效, 而"起来
# 之后记得跑一条命令"必然会被忘。migrate 在容器启动命令里, 走这条路等于自动完成。
#
# 幂等按 kind 分开判断 (而不是 0008 那句 `ImageProvider.objects.exists()`): 到这一步
# 库里几乎一定已经有 0008 导进来的生图 provider 了, 用总数判断会让 angle 永远导不进来。

from django.db import migrations

from studio.services.listings_utils import env, env_int

_DEFAULT_BASE_URL = "https://fal.run"
_DEFAULT_MODEL = "fal-ai/qwen-image-edit-2511-multiple-angles"


def import_angle_env(apps, schema_editor):
    ImageProvider = apps.get_model("studio", "ImageProvider")
    ImageModel = apps.get_model("studio", "ImageModel")

    if ImageProvider.objects.filter(kind="angle").exists():
        return  # 用户已经在前端配过 angle 通道了, 不碰

    # api_key 是唯一没有默认值的一项 —— 没有它这条通道就是没配, base_url / model
    # 有默认值反而说明不了什么。
    api_key = env("CANVAS_ANGLE_FAL_API_KEY")
    if not api_key:
        return

    model_name = env("CANVAS_ANGLE_FAL_MODEL") or _DEFAULT_MODEL
    timeout = env_int("CANVAS_ANGLE_FAL_TIMEOUT", 180)
    provider = ImageProvider.objects.create(
        label="Angle 通道",
        kind="angle",
        base_url=(env("CANVAS_ANGLE_FAL_BASE_URL") or _DEFAULT_BASE_URL).rstrip("/"),
        api_key=api_key,
        # angle 的请求体是相机坐标 (前端立方体在控), 唯一可调的就是超时。
        defaults={"timeout": timeout},
    )
    ImageModel.objects.create(
        provider=provider, label=model_name.rsplit("/", 1)[-1], model=model_name,
    )


def noop_reverse(apps, schema_editor):
    """不自动删: 回滚迁移时把用户可能已经编辑过的配置删掉, 比留着危险得多。"""


class Migration(migrations.Migration):

    dependencies = [
        ("studio", "0009_anglejob_image_model_imageprovider_kind"),
    ]

    operations = [
        migrations.RunPython(import_angle_env, noop_reverse),
    ]
