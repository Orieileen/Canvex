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
    # ChatUserRateThrottle(scope="canvas_chat") 是从 meired port 过来的, 但 rate 没带过来
    # —— 缺这条会让每次 chat POST 在 check_throttles 阶段直接 500 (ImproperlyConfigured),
    # 表现为"一发消息就 Chat failed"。单工作区无登录, UserRateThrottle 按 IP 限流。
    "DEFAULT_THROTTLE_RATES": {
        "canvas_chat": "60/min",
    },
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

# 媒体基址 —— **给浏览器的**, 不是给供应商的。用在「发到聊天」的附件 URL, 以及把相对
# /media/... 归一成能存进 job 行的绝对地址。供应商不会来拉它: 源图在提交那一刻由
# services.agent.tools.common.source_for_channel 内联成 base64 或推给供应商。
# 详见那个模块里 absolute_media_url 的 docstring。dev 默认 localhost。
PUBLIC_MEDIA_BASE = os.getenv("PUBLIC_MEDIA_BASE", "http://localhost:28000")
# (这里原来还有一个 INTERNAL_MEDIA_BASE, 用途是"worker → backend 拉源图时绕公网"。
#  那条流程随内联/上传一起没了, 而它定义之后全仓再无第二处引用 —— 已删。)

# ── Canvas (LLM Agent + 媒体生成) ─────────────────────────────────────────────
# 长任务走独立 queue canvas / canvas_cpu (见 CELERY_TASK_ROUTES + docker-compose
# worker_canvas / worker_canvas_cpu)。
CANVAS_CELERY_QUEUE = os.getenv("CANVAS_CELERY_QUEUE", "canvas")

# 聊天模型的端点 / key / 模型名现在住在库里 (侧栏「配置供应商」里的 kind=chat 一条),
# 原来的 CANVAS_CHAT_* 由迁移 0015 一次性导入。它仍然刻意跟生图那把 key 分开 —— agent
# 必须走支持 `tools` 参数的 provider, 接错了会拿到 inline markdown 而不是 tool_call。

# deepagents /memories/ 后端. "memory" (默认) = InMemoryStore (单进程, 重启丢);
# "postgres" 跨 web/worker 可见 + 持久, 需 langgraph-checkpoint-postgres 包 + DSN。
CANVAS_AGENT_STORE_BACKEND = os.getenv("CANVAS_AGENT_STORE_BACKEND", "memory")
CANVAS_AGENT_STORE_DSN = os.getenv("CANVAS_AGENT_STORE_DSN", "")

# 视频通道的配置(端点 / key / 模型 / 轮询参数)现在住在库里, 由用户在侧栏「配置供应商」
# 里配一条 kind=video 的记录。原来的 CANVAS_VIDEO_* 由迁移 0013 一次性导入。

# Credit cost (Canvex 独立版 billing 为 no-op stub, 实际成本见 studio.constants;
# 这几项保留对齐 meired 契约)。
CANVAS_CREDIT_COST_IMAGE = int(os.getenv("CANVAS_CREDIT_COST_IMAGE", "1") or 1)
CANVAS_CREDIT_COST_VIDEO = int(os.getenv("CANVAS_CREDIT_COST_VIDEO", "10") or 10)
CANVAS_CREDIT_COST_ANGLE = int(os.getenv("CANVAS_CREDIT_COST_ANGLE", "1") or 1)

# 生图 / angle 的供应商配置**不在这里** —— 端点、密钥、模型名、请求参数全部存库
# (ImageProvider / ImageModel), 由前端「配置供应商」面板增删改。老部署 env 里的
# CANVAS_IMAGE_PRIMARY_* / CANVAS_IMAGE_FALLBACK_* / CANVAS_ANGLE_FAL_* 由迁移
# 0008 / 0010 一次性导进库, 之后这些变量不再被读取。
