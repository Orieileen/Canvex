# 把 env 里现有的 CANVAS_CHAT_* 配置导入成一条 kind=chat 的库记录, 只导一次。
#
# 跟 0008 / 0010 / 0013 同一个理由: 现有部署 env 里配好的聊天模型不能因为这次改造就失效,
# 而"起来之后记得跑一条命令"必然会被忘。migrate 在容器启动命令里, 走这条路等于自动完成。
#
# 这条尤其不能漏: 聊天没配 = agent 直接抛 RuntimeError, 整个聊天框不可用。前三个 kind
# 至少还能各自独立降级。

from django.db import migrations

from studio.services.listings_utils import env, env_int

_DEFAULT_MODEL = "gpt-4o-mini"


def import_chat_env(apps, schema_editor):
    ImageProvider = apps.get_model("studio", "ImageProvider")
    ImageModel = apps.get_model("studio", "ImageModel")

    if ImageProvider.objects.filter(kind="chat").exists():
        return  # 用户已经在前端配过聊天通道了, 不碰

    # api_key 是唯一没有默认值的一项 —— 原来的 build_canvas_agent 也正是只硬要求它
    # (base_url 空 = 走 OpenAI 默认, model 有默认值), 所以判据保持一致。
    api_key = env("CANVAS_CHAT_API_KEY")
    if not api_key:
        return

    model_name = env("CANVAS_CHAT_MODEL") or _DEFAULT_MODEL
    provider = ImageProvider.objects.create(
        label="聊天模型",
        kind="chat",
        # base_url 空是合法的 (走 OpenAI 官方端点), 库字段是 CharField 不是 URLField,
        # 存空串即可 —— builder 里 `channel.base_url or None` 会把它还原成"用默认"。
        base_url=(env("CANVAS_CHAT_BASE_URL") or "").rstrip("/"),
        api_key=api_key,
        # 原来 ChatOpenAI 的 timeout 是写死的 120, 跟 KIND_SPECS 里 chat 的默认值一致,
        # 所以不用往 defaults 里写 —— 写了反而会把以后改默认值这件事变成改两处。
        # 跟 0008 / 0013 同一个哨兵套路: env_int 只认 isdigit, "60s" 会静默拿到 default
        # 并被写进库 —— 那是把一个手滑的值伪装成用户的选择。-1 认出来当没设过。
        defaults={} if env_int("CANVAS_CHAT_TIMEOUT", -1) < 0 else {
            "timeout": env_int("CANVAS_CHAT_TIMEOUT", -1),
        },
    )
    ImageModel.objects.create(
        provider=provider, label=model_name.rsplit("/", 1)[-1], model=model_name,
    )


def noop_reverse(apps, schema_editor):
    """不自动删: 回滚迁移时把用户可能已经编辑过的配置删掉, 比留着危险得多。"""


class Migration(migrations.Migration):

    dependencies = [
        ("studio", "0014_chat_channel"),
    ]

    operations = [
        migrations.RunPython(import_chat_env, noop_reverse),
    ]
