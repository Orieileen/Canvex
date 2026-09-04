"""Canvas billing —— 独立版 Canvex 的 NO-OP stub(无钱包 / 无 credit)。

上游的 canvas 代码处处调 billing.reserve/commit/rollback/...。Canvex 免费,
这里保留与上游完全一致的函数签名但全部空操作,让 port 过来的 services / tasks /
agent 代码零改动即可运行。将来 Canvex 若要接计费,只换这一个文件。

对应上游 apps/canvas/services/billing.py 的公开 API。
"""
from __future__ import annotations


# 上游的 services/tasks 里有 `except InsufficientCredits / SubscriptionLocked`,
# port 后这些 import 要有落点(免费版永不抛,但 import 不能崩)。
class InsufficientCredits(Exception):
    """Canvex 免费:永不抛,仅为 port 代码的 except 子句保留符号。"""


class SubscriptionLocked(Exception):
    """同上。"""


def reserve(job):
    """免费:不预留 credit、不建 UsageEvent。返 None(与上游 cost<=0 短路同形)。"""
    return None


def cost_credits(job) -> int:
    """无计费,恒 0。"""
    return 0


def commit(job):
    """task 成功时调:no-op。"""
    return None


def rollback(job, *, reason: str = ""):
    """task 失败 / 跳过时调:no-op。"""
    return None


def partial_refund(job, *, refund_credits: int = 0, reason: str = ""):
    """产出 < 声明数量时退差额:no-op(没扣过钱)。"""
    return None


def reserve_or_friendly_message(job, *, action_label: str = "") -> str | None:
    """chat agent tool 用:免费 → 永远放行(返 None = 无错误,agent 照常执行)。"""
    return None
