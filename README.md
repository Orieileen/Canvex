<div align="center">
  <h1>Canvex</h1>
  <p>Canvex is an infinite-canvas LLM agent that can chat, use skills, generate, and edit images and videos. With scene management, you can organize multiple canvases for different projects.</p>
  <p>
    <a href="https://react.dev"><img src="https://img.shields.io/badge/Frontend-React%20%2B%20Vite-61DAFB" alt="Frontend"></a>
    <a href="https://www.djangoproject.com/"><img src="https://img.shields.io/badge/Backend-Django%20%2B%20DRF-092E20" alt="Backend"></a>
    <a href="https://www.postgresql.org/"><img src="https://img.shields.io/badge/Database-PostgreSQL-4169E1" alt="Database"></a>
    <a href="https://redis.io/"><img src="https://img.shields.io/badge/Queue-Celery%20%2B%20Redis-DC382D" alt="Queue"></a>
    <a href="https://github.com/langchain-ai/deepagents"><img src="https://img.shields.io/badge/Agent-deepagents-1C3C3C" alt="Agent"></a>
  </p>
</div>

Language: [中文](./README.zh-CN.md)

## Features

- **Chat to create** — type a prompt in the canvas chat box; the agent generates one or more images (or a video) and pins them onto the board.
- **AI toolbar on any image** — select an image to get a floating toolbar:
  - **Edit** — restyle / change anything by prompt.
  - **Cutout** — one-click background removal to a transparent subject.
  - **Split** — two stacked results from one image: a transparent subject + a clean subject-removed background.
  - **Angle** — drag a 3D cube to re-render the shot from a new camera viewpoint (fal.ai LoRA).
  - **Video** — animate a still into a clip.
  - **Mockup** — wrap a design image onto another image using depth, with Depth / Mask / Opacity controls.
  - **Merge / Adjust / Download / Send to chat** — flatten a selection locally, a Lightroom-style color panel, export the canvas, or attach an image as a reference for the LLM agent.
- **Box & arrow annotations** — fine-grained image editing: draw a box, arrow, or text label over an image to point the AI at a region.
- **Skills** — built-in playbooks the agent follows (e.g. `image-prompt-sop` for high-quality single images, `amazon-listing-pack-sop` for a coordinated 7-image listing set). Toggle any skill off per message from the chat box. You can add or remove skills yourself.
- **Scenes** — multiple independent canvases in the sidebar: create, rename, delete, **pin to top**, quick switching; edits autosave.
- **Media library** — saves every image / video you generate, grouped per canvas; click a thumbnail to drop it back onto the current board.
- **Resolution tiers** — 1K / 2K / 4K for image generation and editing (subject to provider and model support).
- **Bring your own providers** — endpoint, key, model name and per-provider request knobs live in the UI, not in `.env`. Configure as many channels as you like (image, Angle, video, and the chat LLM), then pick which one runs each generation from the toolbar — Google for this image, GPT for the next.

## Architecture at a glance

```mermaid
flowchart LR
  subgraph FE["Frontend — React + Excalidraw"]
    Chat["Chat box"]
    Bar["AI toolbar"]
  end
  subgraph BE["Backend — Django + DRF"]
    Agent["deepagents agent<br/>(skills + tools)"]
    API["job endpoints"]
  end
  Q[["Celery queues<br/>canvas · canvas_cpu"]]
  Prov["image / video / fal.ai providers"]

  Chat -->|"POST /chat/ (NDJSON)"| Agent
  Agent -->|"generate_image · generate_video"| Q
  Bar -->|"edit · cutout · split · angle · video"| API --> Q
  Q --> Prov --> Q
  Q -->|"poll job → pin result"| FE
```

- The chat agent is **deepagents** (`create_deep_agent`) with two tools (`generate_image`, `generate_video`), a per-scene memory file, and progressively-disclosed **SKILL.md** skills. Chat history is replayed from the database each turn (no separate memory store required).
- Every generation is an async **job**: the API creates a `QUEUED` row and enqueues a Celery task on commit; the frontend polls the job until the result is ready, then pins it. Cutout runs as a 2-stage chain (LLM white-out → CPU rembg alpha).

## Setup

### 1) Clone

```bash
git clone https://github.com/Orieileen/Canvex.git
cd Canvex
```

### 2) Configure

```bash
cp .env.example .env
```

The defaults work as-is for a local run — **no API keys go in here.** Providers are configured in the app (step 4). `.env` only holds infrastructure settings: ports, database, and `PUBLIC_MEDIA_BASE` (see the table below).

### 3) Run (Docker)

Prerequisites: Docker + Docker Compose.

- Docker Desktop: [https://www.docker.com/products/docker-desktop/](https://www.docker.com/products/docker-desktop/)
- Docker Compose install docs: [https://docs.docker.com/compose/install/](https://docs.docker.com/compose/install/)

```bash
docker compose up -d --build
```

This starts Postgres, Redis, the backend (which runs migrations on startup), three Celery workers, and the frontend dev server.

- Frontend: http://localhost:5173
- Backend API: http://localhost:28000

### 4) Add your channels

Open http://localhost:5173 and click **Channels** in the left sidebar. Nothing works until there is at least one channel, so start here:

1. **Chat** — required first; the chat box is dead without it. Point it at a provider that supports OpenAI-style **tool calling** — one that doesn't will reply with markdown and quietly do nothing on the canvas, so don't reuse an image-only key. Leave Base URL blank to use OpenAI's own endpoint.
2. **Image generation** — needed for the Image / Split tools and for images the agent creates.
3. *(optional)* **Angle** — a [fal.ai](https://fal.ai) key, for the 3D-cube viewpoint tool.
4. *(optional)* **Video**.

Paste a provider's example `curl` into **Import from a curl example** and Canvex fills in the Base URL, model and request shape for you. The ⚡ button next to a model sends one real minimal generation and shows the provider's raw error if something is off.

## Environment variables

Minimum to get started (full list and tuning knobs in [.env.example](./.env.example)):

| Variable | Required | Notes |
| --- | --- | --- |
| `PUBLIC_MEDIA_BASE` | ⚠️ | Public URL of this backend (default `http://localhost:28000`). Must be reachable by the providers for image-to-image / video / angle (they fetch the source image) — use a tunnel/CDN in prod. Pure text-to-image doesn't need it. |
| `CANVAS_AGENT_STORE_BACKEND` | – | `memory` (default, in-process) or `postgres` (persistent agent memory). |
| `POSTGRES_DB` / `_USER` / `_PASSWORD` | – | Default all `canvex`. |
| `BACKEND_PORT` / `FRONTEND_PORT` | – | Host ports, default `28000` / `5173`. |
| `VITE_API_URL` | – | Backend URL the frontend calls; default `http://localhost:28000`. |

Notes:

- **No provider is configured here** — chat, image generation, Angle and video all get their endpoint, API key, model name and per-provider request knobs from the UI, under **Channels** in the left sidebar. Add as many providers and models as you like and switch between them from the toolbar when you generate.
- **Start by adding a Chat channel** (see step 4) — the chat box is dead without one (the agent raises "还没有配置聊天模型"). It must point at a provider that supports OpenAI-style tool calling; one that doesn't will reply with markdown and quietly do nothing on the canvas, so don't reuse your image key for it. Leave its Base URL blank to use OpenAI's own endpoint.
- The **Angle** (multi-viewpoint) feature runs on [fal.ai](https://fal.ai): sign up, create an API key, and add it as an Angle provider in that same panel. No fal.ai account is needed for the other features.
- Upgrading from an older version: your existing `CANVAS_CHAT_*` / `CANVAS_IMAGE_PRIMARY_*` / `CANVAS_IMAGE_FALLBACK_*` / `CANVAS_ANGLE_FAL_*` / `CANVAS_VIDEO_*` values are imported into the database once by migrations `0008` / `0010` / `0013` / `0015`. After that they are no longer read and can be deleted from `.env`.
- The product is free and single-workspace: there is no auth, and billing is a no-op stub (`CANVAS_CREDIT_COST_*` are inert).

## API

All routes are under `/api/v1/canvas/`.

| Purpose | Endpoint |
| --- | --- |
| Scenes (CRUD) | `GET/POST /scenes/`, `GET/PATCH/DELETE /scenes/{id}/` |
| Chat (NDJSON stream) | `POST /scenes/{id}/chat/` |
| Image edit / generate | `POST /scenes/{id}/image-edit/` → `GET /image-edit-jobs/{job_id}/` |
| Split (subject + background) | `POST /scenes/{id}/split/` |
| Video | `POST /scenes/{id}/video/` → `GET /video-jobs/{job_id}/` |
| Angle (fal.ai) | `POST /scenes/{id}/angle/` → `GET /angle-jobs/{job_id}/` |
| Active jobs (resume polling) | `GET /scenes/{id}/active-jobs/` |
| Send-to-chat upload | `POST /scenes/{id}/upload-attachment/` |
| Media library | `GET /media-library/folders/`, `GET /media-library/folders/{scene_id}/items/` |
| Skills | `GET /skills/` |

The chat endpoint streams **NDJSON** (one JSON object per line; event types: `user_created`, `tool_call`, `tool_result`, `assistant_final`, `assistant`, `error`, `done`), not SSE.

## Backend

Tech stack: **Django + DRF + Celery + Redis + PostgreSQL + deepagents** (LangChain / LangGraph under the hood).

```
backend/
├── config/                      # Django project (settings, celery, urls, wsgi/asgi)
└── studio/                      # Main app, mounted at /api/v1/canvas/
    ├── models.py                # Scene, ChatMessage, ImageEditJob/Result,
    │                            #   VideoJob, AngleJob/Result, DataFolder/DataAsset
    ├── views.py  serializers.py  urls.py
    ├── tasks.py                 # Celery: canvas.image_edit_job / image_edit_cutout_job
    │                            #   / video_job / angle_job / cutout_llm_step
    └── services/
        ├── image.py video.py angle.py        # job creation + provider calls
        ├── image_client.py                   # OpenAI-compatible image client (prefix-configurable)
        ├── attachments.py scenes.py billing.py (no-op) http_retry.py listings_utils.py
        └── agent/
            ├── builder.py        # create_deep_agent (model, tools, skills, memory, store)
            ├── skills.py  context.py
            ├── tools/            # common.py, image.py (generate_image), video.py (generate_video)
            └── skills/           # image-prompt-sop/SKILL.md, amazon-listing-pack-sop/SKILL.md
```

### Async job pipeline

A generation request creates a `QUEUED` job in a transaction and enqueues a Celery task on commit (returns `202` with `{job_id, status}`). Tasks run on dedicated queues:

| Queue (worker) | Pool | Tasks |
| --- | --- | --- |
| `canvas` (`worker_canvas`) | gevent | `image_edit_job`, `video_job`, `angle_job`, `cutout_llm_step` |
| `canvas_cpu` (`worker_canvas_cpu`) | prefork | `image_edit_cutout_job` (rembg alpha, CPU-bound) |
| `excalidraw` (`worker`) | prefork | default queue |

Cutout / Split is a 2-stage chain: stage 1 (LLM, on `canvas`) produces a white-background image, stage 2 (rembg, on `canvas_cpu`) turns white → transparent alpha. The frontend polls the job endpoints (or `/active-jobs/`) and pins results when ready. Image/video tools invoked by the chat agent create the same jobs — the agent returns a "queued" confirmation and does not block on the render.

## FAQ

- **Check logs** for a failed job — include all three workers:

  ```bash
  docker compose logs -f backend worker worker_canvas worker_canvas_cpu
  ```

- **Image looks wrong or errors** — check the provider's base URL, key and model name under **Channels** in the sidebar; the panel has a test button. Video is configured the same way.
- **Image-to-image / video / angle never returns** — the provider must be able to fetch your source image; set `PUBLIC_MEDIA_BASE` to a publicly reachable URL.
- **Frontend requests blocked by CORS** — keep `CORS_ALLOW_ALL_ORIGINS=true` (default) or list your origin in `CORS_ALLOWED_ORIGINS`.
