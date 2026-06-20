from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BASE_DIR.parent

# Load both backend/.env and project-root .env (root .env takes priority in compose flow)
load_dotenv(BASE_DIR / ".env")
load_dotenv(PROJECT_ROOT / ".env")


def _as_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _as_list(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", "change-me-in-production")
DEBUG = _as_bool(os.getenv("DJANGO_DEBUG"), True)
ALLOWED_HOSTS = _as_list(os.getenv("DJANGO_ALLOWED_HOSTS")) or ["*"]

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.staticfiles",
    "corsheaders",
    "rest_framework",
    "studio",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {"context_processors": ["django.template.context_processors.request"]},
    },
]

WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.getenv("POSTGRES_DB", "canvex"),
        "USER": os.getenv("POSTGRES_USER", "canvex"),
        "PASSWORD": os.getenv("POSTGRES_PASSWORD", "canvex"),
        "HOST": os.getenv("POSTGRES_HOST", "postgres"),
        "PORT": os.getenv("POSTGRES_PORT", "5432"),
    }
}

AUTH_PASSWORD_VALIDATORS = []

LANGUAGE_CODE = "en-us"
TIME_ZONE = os.getenv("DJANGO_TIME_ZONE", "UTC")
USE_I18N = True
USE_TZ = True

STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# CORS
CORS_ALLOW_CREDENTIALS = False
CORS_ALLOW_ALL_ORIGINS = _as_bool(os.getenv("CORS_ALLOW_ALL_ORIGINS"), True)
if not CORS_ALLOW_ALL_ORIGINS:
    CORS_ALLOWED_ORIGINS = _as_list(os.getenv("CORS_ALLOWED_ORIGINS"))

CORS_ALLOW_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
CORS_ALLOW_HEADERS = [
    "accept",
    "accept-encoding",
    "content-type",
    "dnt",
    "origin",
    "user-agent",
    "x-csrftoken",
    "x-requested-with",
    "ngrok-skip-browser-warning",
]

REST_FRAMEWORK = {
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.AllowAny",
    ],
    "DEFAULT_AUTHENTICATION_CLASSES": [],
    "UNAUTHENTICATED_USER": None,
    "UNAUTHENTICATED_TOKEN": None,
}

REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
CELERY_BROKER_URL = os.getenv("CELERY_BROKER_URL", REDIS_URL)
CELERY_RESULT_BACKEND = os.getenv("CELERY_RESULT_BACKEND", REDIS_URL)
CELERY_TASK_DEFAULT_QUEUE = "excalidraw"
CELERY_TASK_ALWAYS_EAGER = _as_bool(os.getenv("CELERY_TASK_ALWAYS_EAGER"), False)
CELERY_TASK_EAGER_PROPAGATES = True

# canvas.* 长任务走独立 queue, 不挤占默认 excalidraw worker。worker_canvas /
# worker_canvas_cpu service 在 docker-compose.yml 定义。未列出的 task 仍走默认
# CELERY_TASK_DEFAULT_QUEUE='excalidraw'。
CELERY_TASK_ROUTES = {
    # canvas: LLM agent + 图/视频生成（IO 密集; gevent worker_canvas）
    "canvas.image_edit_job": {"queue": "canvas"},
    "canvas.video_job": {"queue": "canvas"},
    "canvas.angle_job": {"queue": "canvas"},
    # cutout 2-stage 流水 stage 1 (LLM 抠主体留白底). IO-bound → 同 canvas queue.
    "canvas.cutout_llm_step": {"queue": "canvas"},
    # cutout 2-stage 流水 stage 2 (rembg 白转 alpha, CPU 密集) → canvas_cpu (prefork)。
    "canvas.image_edit_cutout_job": {"queue": "canvas_cpu"},
}

# Upload guards
DATA_UPLOAD_MAX_MEMORY_SIZE = int(os.getenv("DATA_UPLOAD_MAX_MEMORY_SIZE", str(20 * 1024 * 1024)))
FILE_UPLOAD_MAX_MEMORY_SIZE = int(os.getenv("FILE_UPLOAD_MAX_MEMORY_SIZE", str(20 * 1024 * 1024)))

# 媒体公网基址. canvas 图像/视频生成走第三方 API, source_image URL 必须公网可达;
# 生成产物回写也用它拼绝对 URL。dev 默认 localhost。studio.services.agent.tools.common
# 软读 settings.PUBLIC_MEDIA_BASE (回落 os.getenv)。
PUBLIC_MEDIA_BASE = os.getenv("PUBLIC_MEDIA_BASE", "http://localhost:28000")
# 容器内互调基址 (worker → backend 拉源图时绕公网)。
INTERNAL_MEDIA_BASE = os.getenv("INTERNAL_MEDIA_BASE", "http://backend:8000")

# ── Canvas (LLM Agent + 媒体生成) ─────────────────────────────────────────────
# 长任务走独立 queue canvas / canvas_cpu (见 CELERY_TASK_ROUTES + docker-compose
# worker_canvas / worker_canvas_cpu)。
CANVAS_CELERY_QUEUE = os.getenv("CANVAS_CELERY_QUEUE", "canvas")

# Chat router (deepagents) —— 独立 slot, 不复用 OPENAI_*. agent 必须走支持 `tools`
# 参数的 provider; 混用会让 agent 拿到 inline markdown 而不是 tool_call。不显式设
# CANVAS_CHAT_API_KEY 则 build_canvas_agent 会炸 (比静默接错 provider 好调试)。
CANVAS_CHAT_API_KEY = os.getenv("CANVAS_CHAT_API_KEY", "")
CANVAS_CHAT_BASE_URL = os.getenv("CANVAS_CHAT_BASE_URL", "")  # 空则走 OpenAI 默认
CANVAS_CHAT_MODEL = os.getenv("CANVAS_CHAT_MODEL", "gpt-4o-mini")

# deepagents /memories/ 后端. "memory" (默认) = InMemoryStore (单进程, 重启丢);
# "postgres" 跨 web/worker 可见 + 持久, 需 langgraph-checkpoint-postgres 包 + DSN。
CANVAS_AGENT_STORE_BACKEND = os.getenv("CANVAS_AGENT_STORE_BACKEND", "memory")
CANVAS_AGENT_STORE_DSN = os.getenv("CANVAS_AGENT_STORE_DSN", "")

# 视频生成 provider 凭据 (OpenAI 兼容 /videos/generations HTTP). 缺任一项 worker
# 跑到就 raise 把 job 标 FAILED。
CANVAS_VIDEO_BASE_URL = os.getenv("CANVAS_VIDEO_BASE_URL", "")
CANVAS_VIDEO_API_KEY = os.getenv("CANVAS_VIDEO_API_KEY", "")
CANVAS_VIDEO_MODEL = os.getenv("CANVAS_VIDEO_MODEL", "")

# 视频长轮询: 20s 起指数退避, 单次封顶 180s, 上限 9 轮 (累计 ~24 分钟)。
CANVAS_VIDEO_POLL_MAX_ATTEMPTS = int(os.getenv("CANVAS_VIDEO_POLL_MAX_ATTEMPTS", "9") or 9)
CANVAS_VIDEO_POLL_INITIAL_SECONDS = int(os.getenv("CANVAS_VIDEO_POLL_INITIAL_SECONDS", "20") or 20)
CANVAS_VIDEO_POLL_MAX_SECONDS = int(os.getenv("CANVAS_VIDEO_POLL_MAX_SECONDS", "180") or 180)
# 视频 HTTP 调用本身的 timeout (和 poll 间隔无关)。
CANVAS_VIDEO_SUBMIT_TIMEOUT = int(os.getenv("CANVAS_VIDEO_SUBMIT_TIMEOUT", "60") or 60)
CANVAS_VIDEO_POLL_HTTP_TIMEOUT = int(os.getenv("CANVAS_VIDEO_POLL_HTTP_TIMEOUT", "30") or 30)

# Credit cost (Canvex 独立版 billing 为 no-op stub, 实际成本见 studio.constants;
# 这几项保留对齐 meired 契约)。
CANVAS_CREDIT_COST_IMAGE = int(os.getenv("CANVAS_CREDIT_COST_IMAGE", "1") or 1)
CANVAS_CREDIT_COST_VIDEO = int(os.getenv("CANVAS_CREDIT_COST_VIDEO", "10") or 10)
CANVAS_CREDIT_COST_ANGLE = int(os.getenv("CANVAS_CREDIT_COST_ANGLE", "1") or 1)

# fal.ai angle provider (Qwen-Image-Edit Multiple-Angles LoRA). sync endpoint
# `fal.run/{model}` 单次 POST 阻塞返图。BASE_URL / MODEL 出厂默认即可; API_KEY 必填。
CANVAS_ANGLE_FAL_BASE_URL = os.getenv("CANVAS_ANGLE_FAL_BASE_URL", "https://fal.run")
CANVAS_ANGLE_FAL_API_KEY = os.getenv("CANVAS_ANGLE_FAL_API_KEY", "")
CANVAS_ANGLE_FAL_MODEL = os.getenv(
    "CANVAS_ANGLE_FAL_MODEL", "fal-ai/qwen-image-edit-2511-multiple-angles"
)
CANVAS_ANGLE_FAL_TIMEOUT = int(os.getenv("CANVAS_ANGLE_FAL_TIMEOUT", "180") or 180)

# 图片生成通道复用 studio.services.image_client.ImageClient。环境变量走
# CANVAS_IMAGE_PRIMARY_* / CANVAS_IMAGE_FALLBACK_* 前缀, 由 build_image_client(prefix)
# 直接从 os.environ 读取 (回落 OPENAI_API_KEY / OPENAI_BASE_URL), settings 不映射。
