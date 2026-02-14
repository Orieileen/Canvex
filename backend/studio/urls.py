from django.urls import path
from rest_framework import routers

from .views import (
    DataAssetViewSet,
    DataFolderViewSet,
    ExcalidrawImageEditJobView,
    ExcalidrawImageEditView,
    ExcalidrawSceneChatView,
    ExcalidrawSceneImageEditJobListView,
    ExcalidrawSceneVideoJobListView,
    ExcalidrawSceneViewSet,
    ExcalidrawVideoGenerateView,
    ExcalidrawVideoJobView,
)

router = routers.DefaultRouter()
router.register(r"library/folders", DataFolderViewSet, basename="data-folder")
router.register(r"library/assets", DataAssetViewSet, basename="data-asset")
router.register(r"excalidraw/scenes", ExcalidrawSceneViewSet, basename="excalidraw-scene")

urlpatterns = router.urls + [
    path("excalidraw/scenes/<uuid:scene_id>/chat/", ExcalidrawSceneChatView.as_view()),
    path("excalidraw/scenes/<uuid:scene_id>/image-edit/", ExcalidrawImageEditView.as_view()),
    path("excalidraw/scenes/<uuid:scene_id>/image-edit-jobs/", ExcalidrawSceneImageEditJobListView.as_view()),
    path("excalidraw/scenes/<uuid:scene_id>/video/", ExcalidrawVideoGenerateView.as_view()),
    path("excalidraw/scenes/<uuid:scene_id>/video-jobs/", ExcalidrawSceneVideoJobListView.as_view()),
    path("excalidraw/image-edit-jobs/<uuid:job_id>/", ExcalidrawImageEditJobView.as_view()),
    path("excalidraw/video-jobs/<uuid:job_id>/", ExcalidrawVideoJobView.as_view()),
]
