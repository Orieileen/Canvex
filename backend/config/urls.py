from django.conf import settings
from django.conf.urls.static import static
from django.urls import include, path

urlpatterns = [
    # studio (canvas) app 挂在 /api/v1/canvas/。studio.urls 内部路由不再带
    # excalidraw/ 前缀, 由这里统一加 canvas/。
    path("api/v1/canvas/", include("studio.urls")),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
