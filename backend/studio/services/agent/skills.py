"""列出 agent 当前看得见的 skill, 以及运行时的装 / 卸。

前端有两个消费方, 问的是两个不同的问题, 所以走两条不同的路:

- **`GET /skills/`** (本模块的 `list_skills`) —— "agent **现在**看得见什么?"
  读的是 store, 跟 SkillsMiddleware 同源, 所以 popover 里列的和 agent 系统提示里
  的不可能飘。ChatOverlay 的 SkillSelector 用它。
- **`GET /skill-library/`** (SkillViewSet, 读 `Skill` 表) —— "库里装了什么?"
  含停用的行和 SKILL.md 全文, 管理面板用它。

**别把 `/skills/` 改成读库。** 它读 store 是唯一能暴露**同步代码自己出错**的地方 ——
`skill_key` 拼错了、`resync_skills` 漏删了一个 key, 库那边永远是对的, 只有去问 store
才看得出来。而这两个面板就挨着(popover 和技能库), 对不上用户一眼能看见。改成读库之后
这两个端点就成了同一条查询的两种拼法, 同步坏了没有任何人会知道。

(这里以前写的理由是"多进程时说实话"。那条站不住: 多 worker 时 GET 落在哪个进程是随机
的, 报的是"负载均衡碰巧选中的那个 worker", 也预测不了下一条聊天 POST 会落到谁身上。
真正的理由是上面那条。)

**这里也不能有进程级缓存。** 验证的前提是每次都去问 store; 缓存一加, 读到的就既不是
store 也不是库, 而是"这个进程上次碰巧读到的东西"。见 `list_skills` 的注释。

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

from langgraph.store.base import BaseStore

from deepagents.backends import StoreBackend
from deepagents.backends.utils import create_file_data
from deepagents.middleware.skills import _list_skills

from studio.models import Skill

from .builder import SKILLS_NAMESPACE, _skills_namespace, get_store

logger = logging.getLogger(__name__)

# user-facing path prefix the frontend will display + the agent's system
# prompt references (e.g. `/skills/image-prompt-sop/SKILL.md`). Store-internal
# keys don't carry this prefix because CompositeBackend strips it on route
# (see builder._seed_skills_into_store docstring).
_PUBLIC_PREFIX = "/skills"


def list_skills() -> list[dict]:
    """Return one dict per loaded skill: {name, description, path}.

    Delegates parsing to deepagents' own `_list_skills` so any SKILL.md the
    agent accepts is also visible to the UI, and vice versa.

    **每次都重新读 store, 不缓存。** 以前这里有个进程级 cache, 前提是"skill 是进程内
    常量"; 现在 skill 随时能装/卸, 那个前提没了。一个靠"每个写入口都记得调 invalidate"
    维系的缓存, 在多进程下必然错: 进程 A 装的 skill 只清得掉 A 自己那份, B 手里的会一直
    旧到重启 —— 而把 store 换成 postgres 做多进程部署恰恰是推荐路径, store 共享救不了
    这个缓存。

    代价实测过: 4 篇 skill / 23 KB 时一次 1.3 ms, 24 篇 / 184 KB 时 4 ms (九成花在
    frontmatter 的 yaml.safe_load 上, 跟 store 后端无关)。而这个函数只在开页面和改完
    skill 之后调 —— SkillSelector 拿的是 props, 开 popover 不发请求。省这几毫秒不值得
    换一类查不出来的 bug。
    """
    # Explicit `store=` because this runs outside graph execution (HTTP view)
    # — StoreBackend's default `get_store()` only works inside langgraph.
    backend = StoreBackend(store=get_store(), namespace=_skills_namespace)
    # source_path="/" because store-internal keys have no /skills/ prefix
    # (CompositeBackend strips it before forwarding; see builder docstring).
    metas = _list_skills(backend, "/")
    return sorted(
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


def skill_key(name: str) -> str:
    """某个 skill 在 store 里的 key。**只有这一个地方定义它** —— 拼错的表现是"装上了但
    agent 看不见", 没有任何报错。"""
    return f"/{name}/SKILL.md"


# `BaseStore.search` 的 limit 默认是 **10**, 不传就静默截断。分页翻完。
_STORE_PAGE = 100


def _store_keys(store: BaseStore) -> set[str]:
    """store 里当前有哪些 key。"""
    keys: set[str] = set()
    offset = 0
    while True:
        page = store.search(SKILLS_NAMESPACE, limit=_STORE_PAGE, offset=offset)
        keys.update(item.key for item in page)
        if len(page) < _STORE_PAGE:
            return keys
        offset += _STORE_PAGE


def resync_skills(store: BaseStore | None = None) -> None:
    """把 store 里的 skill 集合**整个从库里重新推导一遍**: enabled 的行全 put 进去,
    不在这个集合里的 key 全删掉。

    为什么是重新推导而不是打增量补丁: "store 里装着哪些 skill"这条规则以前写了两遍 ——
    一遍是进程启动时的 seed, 一遍是 SkillViewSet.perform_update 里那段
    「改名了就删旧 key / 停用了也删 / 启用着就写」的三分支。两遍就会有分叉, 而分叉的
    表现是 agent 看见一个面板上不存在的 skill, 用户删都删不掉。

    重新推导还顺带解决了三件事:
    - **自愈**: 任何来源造成的漂移(半失败的写、别的 worker 动过的 postgres store、
      迁移 0018 直接写库没同步)都会在下一次写操作时被抹平。
    - **改名不再需要顺序技巧**: 旧 key 不在 wanted 里, 自然会被删, 不用先记住旧名字。
    - seed 和 sync 变成同一个函数, `_seed_skills_into_store` 只剩下一层容错包装。

    N 是个位数, 一次全量推导是一条 values_list 加一次 namespace 列举 —— 比维护一份
    正确的增量便宜得多。

    **不吞异常**: SkillViewSet 的三个写路径都是 `@transaction.atomic`, 这里抛出去正好
    让库写一起回滚, 结果是"什么都没发生"。要优雅降级的只有进程启动那一次, 那一层的
    try/except 在 `builder.get_store` 里。
    """
    store = store or get_store()
    rows = dict(Skill.objects.filter(enabled=True).values_list("name", "content"))
    wanted = {skill_key(name) for name in rows}
    for name, content in rows.items():
        store.put(SKILLS_NAMESPACE, skill_key(name), create_file_data(content))
    stale = _store_keys(store) - wanted
    for key in stale:
        store.delete(SKILLS_NAMESPACE, key)
    logger.info(
        "canvas agent: skills resynced: enabled=%d, removed=%d", len(rows), len(stale),
    )
