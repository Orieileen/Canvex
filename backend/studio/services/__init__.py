"""Canvas services — shared helpers + per-domain job orchestration (Canvex 独立版).

从上游 apps/canvas/services/__init__.py port。上游用 UserDatedUploadPath 按
user 隔离上传源图;Canvex 单工作区无 user → 复用 models.canvas_edit_upload_to 的纯
date 路径函数(同一棵 canvas/edits/ 子树),不再引 apps.common.upload_paths。
"""
from django.core.files.storage import default_storage

from studio.models import canvas_edit_upload_to


def save_canvas_source_image(uploaded) -> str:
    """Persist `uploaded` to default_storage; return storage-relative path.

    上游的签名是 (user, uploaded);Canvex 剥掉 user(单工作区)。落点走
    models.canvas_edit_upload_to → `canvas/edits/<Y/m/d>/<uuid>.<ext>`,和
    ImageEditJob.source_image 的 upload_to 同一棵树(storage 迁移 / 清理一次扫到)。
    instance 参数 upload_to 函数没用到,传 None 即可。
    """
    relative = canvas_edit_upload_to(None, uploaded.name)
    return default_storage.save(relative, uploaded)
