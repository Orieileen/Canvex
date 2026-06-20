"""Canvas 权限 —— 独立版 Canvex 的单工作区 no-op stub。

meired 多租户按 organization / user 过滤 queryset(admin 看全 org,member 看自己)。
Canvex AllowAny 单工作区:所有数据全局可见,这些函数保留 meired 接口签名但不做任何
过滤,让 port 过来的 views / services 零改动。将来若要加鉴权,只换这一个文件。

对应 meired apps/canvas/permissions.py。
"""
from __future__ import annotations


def filter_canvas_for_user(queryset, user, *, user_field: str = "user"):
    """单工作区:不过滤,原样返回 queryset。"""
    return queryset


def filter_scene_chat_for_user(queryset, user):
    """单工作区:不过滤,原样返回 queryset。"""
    return queryset
