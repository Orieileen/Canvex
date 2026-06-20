"""Per-invocation agent context (Canvex 独立版).

Passed to `agent.invoke(..., context=CanvasAgentContext(...))` on every chat call.
Tools read it via `runtime: ToolRuntime[CanvasAgentContext]` to know which scene
to attribute generated assets to.

StoreBackend namespace factory also reads `scene_id` to scope /memories/ files
per-scene (so "scene A's memory" never leaks to "scene B").

解耦自 meired apps/canvas/services/agent/context.py:
- meired 多租户的 org_id / user_id 字段已删 —— Canvex 单工作区, 模型无
  organization / user, 没有跨租户归属面。只保留 scene_id + attachment_urls。
"""
from dataclasses import dataclass, field


@dataclass
class CanvasAgentContext:
    scene_id: str
    # Image URLs attached to this turn via "Send to chat" on ImageEditBar.
    # generate_image / generate_video tools fall back to these when the
    # agent neglects to thread image_urls through itself — gpt-4o-mini
    # frequently hallucinates "I started the generation" without actually
    # calling the tool with the attachments. Empty list = no fallback.
    attachment_urls: list[str] = field(default_factory=list)
