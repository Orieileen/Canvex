"""共享 requests Session, 自动重试 transient 5xx / 429 错误。

外部 LLM / 媒体 API (tu-zi.com / fal.ai 等) 经常 503/502/504 抖动 ~1 次/天.
没有 retry 时, 一次抖动 → task FAILED → Sentry 告警 + Stage 4 退 credit + 用户
看见错误. 加 retry 把 transient 错误在 client 层吸收掉, 用户无感.

不重试的:
- 4xx 业务错误 (400 invalid prompt / 401 bad key / 404 model not found): 重试
  也是同样错误, 浪费配额.
- POST 在 5xx 之外的错误: provider 可能已部分处理 (扣了配额 / 创了任务) → 不
  retry 防双扣. urllib3 Retry 默认 allowed_methods 已排除 POST, 我们显式加回来
  只对 5xx/429 — 这些状态码意味着 server 没接收 / 没处理, 重试安全.
"""
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# transient HTTP 状态: 上游过载 / 限流 / 网关问题, 重试通常能成
RETRY_STATUS_FORCELIST = (429, 500, 502, 503, 504)

# 1s -> 2s -> 4s, 总共最多 ~7s 等待 + 4 次 attempt. 比 task FAILED + Sentry
# 上报 + 用户 retry 链路短得多.
RETRY_TOTAL = 3
RETRY_BACKOFF_FACTOR = 1

# urllib3 默认 pool_maxsize=10. worker_pipeline 是 gevent c=20 → 20 greenlets 抢
# 1 个 Session, 默认 10 槽不够会让 11+ 阻塞等待空闲 connection. 32 给最大 worker
# 并发 (20) + 一些 burst headroom, 不浪费内存 (~100KB/conn).
POOL_MAXSIZE = 32


def make_retry_session(
    *,
    total: int = RETRY_TOTAL,
    backoff_factor: float = RETRY_BACKOFF_FACTOR,
    status_forcelist: tuple[int, ...] = RETRY_STATUS_FORCELIST,
    pool_maxsize: int = POOL_MAXSIZE,
) -> requests.Session:
    """构建一个挂了 Retry adapter 的 Session, http(s) 都会自动重试 transient 错误。"""
    session = requests.Session()
    retry = Retry(
        total=total,
        backoff_factor=backoff_factor,
        status_forcelist=status_forcelist,
        # POST 默认不在 allowed_methods 里 (担心非幂等); 但 5xx/429 表示 server
        # 没接收, 重试 POST 安全 (如果 server 接收且部分处理, 通常会返 4xx 而不是 5xx).
        allowed_methods=frozenset(["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"]),
        raise_on_status=False,  # 让 resp.raise_for_status() 在调用方决定怎么处理
    )
    adapter = HTTPAdapter(max_retries=retry, pool_maxsize=pool_maxsize)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session
