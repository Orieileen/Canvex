from django.urls import path
from rest_framework.routers import DefaultRouter

from .views import (
    AngleJobRetrieveView,
    ImageEditJobRetrieveView,
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
    VideoJobRetrieveView,
)

router = DefaultRouter()
router.register(r"scenes", SceneViewSet, basename="canvas-scene")

urlpatterns = router.urls + [
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
]
