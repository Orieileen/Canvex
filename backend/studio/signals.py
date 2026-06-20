import logging

from django.core.files.storage import default_storage
from django.db.models.signals import post_delete
from django.dispatch import receiver

from .models import ImageEditJob

logger = logging.getLogger(__name__)


@receiver(post_delete, sender=ImageEditJob)
def delete_image_edit_source_image(sender, instance, **kwargs):
    """ImageEditJob 删除后(scene 级联 / 直接删)清 source_image.

    用户上传作 LLM 编辑/cutout 输入的图; 不是所有 job 都有 (text-to-image 路径
    走 generate_image tool 时 source_image 为空, multi-image marquee 路径用
    JSONField source_images, 都不走这条 ImageField)。

    Canvex 独立版无 apps.common.storage_cleanup 异步队列, 改为同步
    default_storage.delete; 失败只记日志, 不让删 job 的事务因清文件出错而回滚。
    """
    if instance.source_image:
        name = instance.source_image.name
        try:
            default_storage.delete(name)
        except Exception:
            logger.exception(
                "delete_image_edit_source_image: failed to delete %s", name
            )
