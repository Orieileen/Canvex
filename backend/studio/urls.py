from django.urls import path
from rest_framework.routers import DefaultRouter

from .views import (
    ImageModelChoiceListView,
    ImageProviderCurlImportView,
    ImageProviderSchemaView,
    ImageProviderTestView,
    ImageProviderViewSet,
    AngleJobRetrieveView,
    ImageEditJobRetrieveView,
    MediaLibraryFolderItemsView,
    MediaLibraryFoldersView,
    SceneActiveJobsView,
    SceneAngleGenerateView,
    SceneAngleJobListView,
    SceneAttachmentUploadView,
    SceneChatView,
    SceneImageEditJobListView,
    SceneImageEditView,
    SceneSplitView,
    SceneVideoGenerateView,
    SceneVideoJobListView,
    SceneViewSet,
    SkillListView,
    SkillViewSet,
    VideoJobRetrieveView,
)

router = DefaultRouter()
router.register(r"scenes", SceneViewSet, basename="canvas-scene")
router.register(r"image-providers", ImageProviderViewSet, basename="canvas-image-provider")
# `/skills/` 是"agent 现在看得见什么"(读 store), 这里是"库里装了什么"(读表, 含停用
# 的行和 SKILL.md 全文)。两个名字不一样是因为回答的确实是两个问题 ——
# 见 services/agent/skills.py 的模块文档。
router.register(r"skill-library", SkillViewSet, basename="canvas-skill")

urlpatterns = [
    path(
        "image-providers/<uuid:pk>/test/",
        ImageProviderTestView.as_view(),
        name="canvas-image-provider-test",
    ),
    path(
        "image-providers/import-curl/",
        ImageProviderCurlImportView.as_view(),
        name="canvas-image-provider-import-curl",
    ),
    path(
        "image-providers/schema/",
        ImageProviderSchemaView.as_view(),
        name="canvas-image-provider-schema",
    ),
    path(
        "image-models/",
        ImageModelChoiceListView.as_view(),
        name="canvas-image-models",
    ),
    path(
        "media-library/folders/",
        MediaLibraryFoldersView.as_view(),
        name="canvas-media-folders",
    ),
    path(
        "media-library/folders/<uuid:scene_id>/items/",
        MediaLibraryFolderItemsView.as_view(),
        name="canvas-media-folder-items",
    ),
    path(
        "scenes/<uuid:scene_id>/active-jobs/",
        SceneActiveJobsView.as_view(),
        name="canvas-scene-active-jobs",
    ),
    path(
        "scenes/<uuid:scene_id>/chat/",
        SceneChatView.as_view(),
        name="canvas-scene-chat",
    ),
    path(
        "scenes/<uuid:scene_id>/image-edit/",
        SceneImageEditView.as_view(),
        name="canvas-scene-image-edit",
    ),
    path(
        "scenes/<uuid:scene_id>/image-edit-jobs/",
        SceneImageEditJobListView.as_view(),
        name="canvas-scene-image-edit-jobs",
    ),
    path(
        "scenes/<uuid:scene_id>/split/",
        SceneSplitView.as_view(),
        name="canvas-scene-split",
    ),
    path(
        "scenes/<uuid:scene_id>/video/",
        SceneVideoGenerateView.as_view(),
        name="canvas-scene-video",
    ),
    path(
        "scenes/<uuid:scene_id>/video-jobs/",
        SceneVideoJobListView.as_view(),
        name="canvas-scene-video-jobs",
    ),
    path(
        "image-edit-jobs/<uuid:job_id>/",
        ImageEditJobRetrieveView.as_view(),
        name="canvas-image-edit-job-detail",
    ),
    path(
        "video-jobs/<uuid:job_id>/",
        VideoJobRetrieveView.as_view(),
        name="canvas-video-job-detail",
    ),
    path(
        "scenes/<uuid:scene_id>/angle/",
        SceneAngleGenerateView.as_view(),
        name="canvas-scene-angle",
    ),
    path(
        "scenes/<uuid:scene_id>/angle-jobs/",
        SceneAngleJobListView.as_view(),
        name="canvas-scene-angle-jobs",
    ),
    path(
        "angle-jobs/<uuid:job_id>/",
        AngleJobRetrieveView.as_view(),
        name="canvas-angle-job-detail",
    ),
    path(
        "skills/",
        SkillListView.as_view(),
        name="canvas-skills",
    ),
    path(
        "scenes/<uuid:scene_id>/upload-attachment/",
        SceneAttachmentUploadView.as_view(),
        name="canvas-scene-upload-attachment",
    ),
] + router.urls
# router 的 detail 路由是 `image-providers/<pk>/`, 会把 `image-providers/import-curl/`
# 当成 pk="import-curl" 吃掉 —— 所以显式路径必须排在 router.urls 前面。
