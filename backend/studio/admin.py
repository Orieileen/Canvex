from django.contrib import admin

from .models import (
    DataAsset,
    DataFolder,
    ExcalidrawChatMessage,
    ExcalidrawImageEditJob,
    ExcalidrawImageEditResult,
    ExcalidrawScene,
    ExcalidrawVideoJob,
)

admin.site.register(DataFolder)
admin.site.register(DataAsset)
admin.site.register(ExcalidrawScene)
admin.site.register(ExcalidrawChatMessage)
admin.site.register(ExcalidrawImageEditJob)
admin.site.register(ExcalidrawImageEditResult)
admin.site.register(ExcalidrawVideoJob)
