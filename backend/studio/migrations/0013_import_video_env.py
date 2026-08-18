# 把 env 里现有的 CANVAS_VIDEO_* 配置导入成一条 kind=video 的库记录, 只导一次。
#
# 跟 0008 / 0010 同一个理由: 现有部署 env 里配好的视频通道不能因为这次改造就失效, 而
# "起来之后记得跑一条命令"必然会被忘。migrate 在容器启动命令里, 走这条路等于自动完成。
#
# 幂等按 kind 判断 (而不是总数): 到这一步库里几乎一定已经有 0008 / 0010 导进来的 image /
# angle provider 了, 用总数判断会让 video 永远导不进来。
#
# 只写**显式设过**的 env: 那几个轮询参数的默认值现在住在 image_channels.KIND_SPECS 里
# (video 那条 defaults), 在这里再抄一份数字进 defaults JSON 会让"以后改默认值"变成改两处,
# 而库里那份还会静默盖住新的。

from django.db import migrations

from studio.services.listings_utils import env, env_int

# env 名 → ImageChannel 上的字段名。名字不是一一对应的, 所以显式写出来:
#   SUBMIT_TIMEOUT     提交那一发的超时      → timeout
#   POLL_INITIAL_SECONDS 首轮等待           → poll_interval
#   POLL_MAX_SECONDS    退避上限            → poll_max_interval
#   POLL_HTTP_TIMEOUT   单次轮询请求的超时   → poll_timeout
_POLL_FIELDS = (
    ("CANVAS_VIDEO_SUBMIT_TIMEOUT", "timeout"),
    ("CANVAS_VIDEO_POLL_MAX_ATTEMPTS", "poll_max_attempts"),
    ("CANVAS_VIDEO_POLL_INITIAL_SECONDS", "poll_interval"),
    ("CANVAS_VIDEO_POLL_MAX_SECONDS", "poll_max_interval"),
    ("CANVAS_VIDEO_POLL_HTTP_TIMEOUT", "poll_timeout"),
)


def import_video_env(apps, schema_editor):
    ImageProvider = apps.get_model("studio", "ImageProvider")
    ImageModel = apps.get_model("studio", "ImageModel")

    if ImageProvider.objects.filter(kind="video").exists():
        return  # 用户已经在前端配过 video 通道了, 不碰

    # 这三项都没有默认值 —— 缺任意一个, 原来的 _require_config 就会抛"missing env",
    # 也就是说这个部署本来就没在用视频功能, 不该给它凭空造一条半配的记录。
    base_url = env("CANVAS_VIDEO_BASE_URL")
    api_key = env("CANVAS_VIDEO_API_KEY")
    model_name = env("CANVAS_VIDEO_MODEL")
    if not (base_url and api_key and model_name):
        return

    defaults = {}
    for env_name, field in _POLL_FIELDS:
        if not env(env_name):  # 只搬显式设过的, 没设的交给 KIND_SPECS 的默认值
            continue
        # 跟 0008 用同一个哨兵套路: 走到这里说明这个键非空, 但可能不是数字 (env_int 只
        # 认 isdigit, "60s" / "sixty" 都会拿到 default)。用 -1 认出来并跳过, 当没设过。
        # 不能拿 0 当 default —— 那会把一个手滑的值写成 `timeout: 0`, 而 urllib3 见到
        # <= 0 的超时直接抛 ValueError: 视频功能从此每次都 FAILED, 报错跟 .env 毫无关系。
        value = env_int(env_name, -1)
        if value < 0:
            continue
        defaults[field] = value

    provider = ImageProvider.objects.create(
        label="视频通道",
        kind="video",
        base_url=base_url.rstrip("/"),
        api_key=api_key,
        defaults=defaults,
    )
    ImageModel.objects.create(
        provider=provider, label=model_name.rsplit("/", 1)[-1], model=model_name,
    )


def noop_reverse(apps, schema_editor):
    """不自动删: 回滚迁移时把用户可能已经编辑过的配置删掉, 比留着危险得多。"""


class Migration(migrations.Migration):

    dependencies = [
        ("studio", "0012_video_channel"),
    ]

    operations = [
        migrations.RunPython(import_video_env, noop_reverse),
    ]
