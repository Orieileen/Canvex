"""通道健康 —— 「这条通道上一次真的被调用时, 供应商应答了吗」。

存在的理由: 一条配好的通道会在**没有任何人操作**的情况下坏掉 —— key 过期、额度打光、
供应商换端点。在此之前, 唯一的发现方式是"下一次生成失败", 而那条报错落在画布上一张图
的红字里, 关掉就没了; 回到配置面板, 这条通道看起来和配好的第一天一模一样。本项目里真
发生过一次: 内置生图通道坏了很久, 每次都以为是这一张图的问题。

写什么: `ImageProvider.last_status / last_checked_at / last_error` 三个字段, 见那边的
注释。这里只负责**在哪些时刻写**。

「在哪些时刻写」是这个模块唯一的设计决定, 而且它是关于**诚实**的:

  只在**确知是供应商没应答**的地方记。一个红点必须意味着"换一条通道或者去充值", 不能
  意味着"可能是你本地的事"。所以下面这些**刻意不算**:

  - 源图拉不到 (PUBLIC_MEDIA_BASE 配错 / 隧道断了) —— angle 和生图两条路径都特意把
    源图准备放在通道调用之外, 同一个理由: 换十个供应商也修不好一张拉不到的源图。
  - 抠图 (rembg) / 存盘 / 建 DataAsset 失败 —— 那是我们这边。
  - agent 的图跑挂了 —— 一次聊天里工具报错和 LLM 报错都会变成同一个
    CanvasAgentInvocationError, 分不出是谁的责任, 所以聊天走的是 LLM 回调
    (on_llm_error), 不是那个异常。

  反过来, 用 `watch()` 包住的那几处都恰好是"一次供应商往返"的完整边界。

写入用 `queryset.update()` 而不是 `save()`, **有意跳过 `updated_at` 的 auto_now**:
`updated_at` 的含义是"这份配置改过", 而一次生成不是配置改动 —— 让它跳动会把"我上次改了
什么"这条线索淹掉。

绝不抛: 健康记录是副作用, 一次写库失败不该把一次成功的生成变成失败。
"""
import logging
from contextlib import contextmanager

from django.utils import timezone

from studio.models import ImageProvider

logger = logging.getLogger(__name__)

# 跟 ImageProviderTestView 那条错误回传同一个上限 —— 用户看到的是同一份东西
# (「测试」按钮的 toast 和卡片上的红字), 两处该一样长。
MAX_ERROR_CHARS = 2000


def record(provider_id: str, label: str, ok: bool, error: str = "") -> None:
    """把一次供应商往返的结果记到通道行上。

    收 `provider_id` + `label` 两个字符串而不是一个 ImageChannel: 聊天通道没有
    ImageChannel 可给 —— 它在 builder 里被压成了 lru_cache 的几个键 (刻意的, 见那边),
    到回调手上只剩下 id 和模型名。

    **空的 provider_id 直接跳过**, 那是向导里还没保存的探针通道 (库里根本没有这一行)。

    成功时清空 `last_error`: 留着上一次的报错会让一条已经修好的通道永远挂着一段红字。
    """
    if not provider_id:
        return
    try:
        ImageProvider.objects.filter(pk=provider_id).update(
            last_status=ImageProvider.Health.OK if ok else ImageProvider.Health.ERROR,
            last_checked_at=timezone.now(),
            # 带上通道名 (生成路径给的是"供应商 · 模型")。粒度是供应商 (一张卡片一个点),
            # 所以同一把 key 下面只有一个模型名写错时, 这句是用户判断"红的是哪一行"的
            # 唯一线索。
            last_error="" if ok else f"[{label}] {error}"[:MAX_ERROR_CHARS],
        )
    except Exception:  # noqa: BLE001 — 副作用不该掀翻主流程
        logger.warning("channel health: 写入失败 provider=%s", provider_id, exc_info=True)


@contextmanager
def watch(channel):
    """包住一次供应商往返: 正常出去记 ok, 抛异常记 error 后**原样重抛**。

    重抛是关键 —— 这个上下文管理器不改变任何控制流, 它只是在旁边记一笔。调用方原来怎么
    处理异常, 加了它之后一模一样。

    **别嵌套。** 现在的五个调用点 (生图 / 生图探针 / angle / angle 探针 / 视频) 互不
    包含 —— 生图探针走 `_single_generation` 而不是 `_generate_on_channel`, angle 探针不
    经过 `run_angle_job` —— 所以这里不做深度计数。真要在里层再包一个的话先想清楚谁写在
    后面: 内层的成功会覆盖外层的失败 (angle 探针正是这个形状 —— submit 通了, 但结果里
    没有图)。
    """
    try:
        yield
    except Exception as exc:  # noqa: BLE001 — 记一笔再原样重抛
        # 跟「测试」按钮回传给前端的是同一种写法 (`类型: 报文`)。**不要**把 channel 或
        # 请求头拼进来 —— 那里面有 api_key, 而这段字符串会进库、会显示在界面上。
        record(channel.provider_id, channel.label, False, f"{type(exc).__name__}: {exc}")
        raise
    record(channel.provider_id, channel.label, True)
