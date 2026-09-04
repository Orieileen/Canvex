"""Scene lookup helper (Canvex 独立版,单工作区).

从上游 apps/canvas/services/scenes.py port:上游多租户要查 membership 并按
organization / user 过滤(防跨租户泄漏),Canvex 单工作区没有这一面 —— 直接按 id
取 scene,无 membership 校验,返回 (scene, None) 维持调用方的二元解包契约。
"""
from django.shortcuts import get_object_or_404

from ..models import Scene


def get_scene_and_org(user, scene_id):
    """Return `(scene, None)` for the given scene id.

    单工作区:无 organization,第二个返回值恒为 None(调用方按 (scene, org) 解包,
    org 永远不被使用)。`user` 参数保留以对齐上游签名,但不参与过滤。
    - 404 if scene doesn't exist.
    """
    scene = get_object_or_404(Scene, id=scene_id)
    return scene, None
