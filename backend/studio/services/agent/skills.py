"""列出 agent 当前看得见的 skill, 以及运行时的装 / 卸。

前端有两个消费方, 问的是两个不同的问题, 所以走两条不同的路:

- **`GET /skills/`** (本模块的 `list_skills`) —— "agent **现在**看得见什么?"
  读的是 store, 跟 SkillsMiddleware 同源, 所以 popover 里列的和 agent 系统提示里
  的不可能飘。ChatOverlay 的 SkillSelector 用它。
- **`GET /skill-library/`** (SkillViewSet, 读 `Skill` 表) —— "库里装了什么?"
  含停用的行和 SKILL.md 全文, 管理面板用它。

两者理论上会不一致的唯一情形是**多进程 + InMemoryStore**: 装 skill 的那个请求只改到
自己进程的 store, 别的 web 进程要等重启才 seed 到。默认部署是单进程 (runserver),
真要多进程就得把 `CANVAS_AGENT_STORE_BACKEND` 换成 postgres —— 那时 store 本身共享,
问题不存在。让 `/skills/` 读 store 而不是读库, 正是为了在那种情况下**说实话**: 报的
是这个进程的 agent 真实看得见的东西, 而不是库里应该有的东西。

## Design heuristic: subtraction, not addition

The SkillSelector UI offers only ONE action: "uncheck to disable for this
turn". It does NOT offer "force this skill" (pin / require). This is a
deliberate design constraint, not laziness:

- **Subtraction** (user disables X) — agent still runs progressive disclosure
  on the remaining skills, judging for itself whether each matches the user
  intent. Agency is preserved; the capability space just shrinks.
- **Addition** (user pins X = must use) — would force-prepend SKILL.md into
  the system prompt, bypassing progressive disclosure. Agent loses judgment;
  the system degrades from agent → static prompt template.

Per Anthropic's "Building effective agents" framing: workflows are
predefined code paths; agents dynamically direct their own usage. Force-pin
turns deepagents into a workflow engine and wastes its core value (LLM
choosing when to apply each skill based on context). If a skill is so
critical it must run 100% of turns, it doesn't belong as a SKILL.md at
all — extract it to a deterministic middleware / pre-check step that runs
outside the agent.

装一个 skill **不**违反这条: 它扩大候选集, agent 仍然自己判断用不用。被禁的是
"这一轮必须用 X", 不是"让 X 可选"。

Future skill-control features should follow the same rule: default to
subtraction; only do addition if you can answer "is this critical enough
to be a workflow step instead of a skill?" with yes.
"""
import logging

from deepagents.backends import StoreBackend
from deepagents.backends.utils import create_file_data
from deepagents.middleware.skills import _list_skills

from .builder import SKILLS_NAMESPACE, _skill_key, _skills_namespace, get_store

logger = logging.getLogger(__name__)

# user-facing path prefix the frontend will display + the agent's system
# prompt references (e.g. `/skills/image-prompt-sop/SKILL.md`). Store-internal
# keys don't carry this prefix because CompositeBackend strips it on route
# (see builder._seed_skills_into_store docstring).
_PUBLIC_PREFIX = "/skills"

# 进程内缓存。store 只由本模块的 sync/unsync 和一次性的 seed 改动, 两个写入口都会
# 调 `_invalidate()` —— 所以缓存不会比 store 旧。
_cached: list[dict] | None = None


def list_skills() -> list[dict]:
    """Return one dict per loaded skill: {name, description, path}.

    Delegates parsing to deepagents' own `_list_skills` so any SKILL.md the
    agent accepts is also visible to the UI, and vice versa.
    """
    global _cached
    if _cached is not None:
        return _cached
    # Explicit `store=` because this runs outside graph execution (HTTP view)
    # — StoreBackend's default `get_store()` only works inside langgraph.
    backend = StoreBackend(store=get_store(), namespace=_skills_namespace)
    # source_path="/" because store-internal keys have no /skills/ prefix
    # (CompositeBackend strips it before forwarding; see builder docstring).
    metas = _list_skills(backend, "/")
    _cached = sorted(
        (
            {
                "name": m["name"],
                "description": m["description"],
                "path": f"{_PUBLIC_PREFIX}{m['path']}",
            }
            for m in metas
        ),
        key=lambda s: s["name"],
    )
    return _cached


def sync_skill(name: str, content: str) -> None:
    """把一个 skill 放进 store —— 下一轮聊天 agent 就看得见, 不用重启。

    为什么下一轮就生效: SkillsMiddleware 的 `before_agent` 只在 state 里已有
    `skills_metadata` 时才跳过重扫, 而 Canvex 没有 checkpointer、每轮传的 state 只有
    messages —— 于是它**每一轮都重新列一遍 store**。编译好的 graph 不缓存 skill 列表,
    所以这里不需要动 `_agent_for_channel` 的 lru_cache。
    """
    get_store().put(SKILLS_NAMESPACE, _skill_key(name), create_file_data(content))
    _invalidate()
    logger.info("canvas agent: skill synced to store: name=%s", name)


def unsync_skill(name: str) -> None:
    """把一个 skill 从 store 里拿掉 (停用 / 删除 / 改名后的旧名字)。"""
    get_store().delete(SKILLS_NAMESPACE, _skill_key(name))
    _invalidate()
    logger.info("canvas agent: skill removed from store: name=%s", name)


def _invalidate() -> None:
    """丢掉 `list_skills` 的缓存。**每一个改 store 的地方都必须调**, 漏掉的表现是
    面板里装上了、popover 里不出现, 而且刷新页面也不会变 (缓存是进程级的)。"""
    global _cached
    _cached = None
