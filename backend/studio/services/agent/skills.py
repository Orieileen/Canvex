"""List skills currently exposed to the canvas agent (Canvex 独立版).

Source of truth for the frontend's "Skills" popover. The agent itself
discovers skills lazily via deepagents' SkillsMiddleware; this helper just
enumerates what's been seeded into the shared store so the UI can render
a checkbox per skill with the same name + description the LLM sees.

Both this view and SkillsMiddleware delegate parsing to
`deepagents.middleware.skills._list_skills` so frontend + agent can't drift
on edge cases (whitespace, size limits, name validation). Result is cached
at module level because skills are immutable per-process (editing a
SKILL.md requires a web restart, matching how SkillsMiddleware scans
frontmatter once at agent init).

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

Future skill-control features should follow the same rule: default to
subtraction; only do addition if you can answer "is this critical enough
to be a workflow step instead of a skill?" with yes.
"""
import logging

from deepagents.backends import StoreBackend
from deepagents.middleware.skills import _list_skills

from .builder import SKILLS_NAMESPACE, _skills_namespace, get_store

logger = logging.getLogger(__name__)

# user-facing path prefix the frontend will display + the agent's system
# prompt references (e.g. `/skills/image-prompt-sop/SKILL.md`). Store-internal
# keys don't carry this prefix because CompositeBackend strips it on route
# (see builder._seed_skills_into_store docstring).
_PUBLIC_PREFIX = "/skills"

# Process-level cache. Skills are seeded once per process from disk; restart
# required to pick up SKILL.md edits, matching SkillsMiddleware's own behavior.
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


def _reset_cache_for_tests() -> None:
    """Test-only: clear module cache so reseeded store is re-read."""
    global _cached
    _cached = None
