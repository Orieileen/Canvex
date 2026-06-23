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
  - **Edit** — restyle / change anything by prompt (text-to-image and image-to-image).
  - **Cutout** — one-click background removal to a transparent subject (rembg).
  - **Split** — two stacked results from one image: a transparent subject + a clean subject-removed background (atomic — both or neither).
  - **Angle** — drag a 3D cube to re-render the shot from a new camera viewpoint (fal.ai LoRA).
  - **Video** — animate a still into a clip.
  - **Mockup** — wrap a design onto another image using depth, with Depth / Mask / Opacity controls.
  - **Merge / Adjust / Download / Send to chat** — flatten a selection locally, a Lightroom-style color panel, export the canvas, or attach an image as a chat reference.
- **Box & arrow annotations** — draw a box, arrow, or text label over an image to point the AI at a region. Marks become spatial coordinates in the prompt, so the source image stays clean and the annotations never appear in the result.
- **Skills** — built-in playbooks the agent follows (e.g. `image-prompt-sop` for high-quality single images, `amazon-listing-pack-sop` for a coordinated 7-image listing set). Toggle any skill off per message from the chat box.
- **Scenes** — multiple independent canvases in the sidebar: create, rename, delete, **pin to top**, quick switching; edits autosave.
- **Media library** — every generated image / video, grouped per canvas; click a thumbnail to drop it back onto the current board.
- **Resolution tiers** — 1K / 2K / 4K for image generation and editing.

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

Set at least the chat and image-provider keys (see the table below). `.env.example` is the full, commented reference — including the optional fallback provider, async-polling, and field-mapping knobs.

### 3) Run (Docker)

Prerequisites: Docker + Docker Compose.

```bash
docker compose up -d --build
```

This starts Postgres, Redis, the backend (which runs migrations on startup), three Celery workers, and the frontend dev server.

- Frontend: http://localhost:5173
- Backend API: http://localhost:28000

## Environment variables

Minimum to get started (full list and tuning knobs in [.env.example](./.env.example)):

| Variable | Required | Notes |
| --- | --- | --- |
| `CANVAS_CHAT_API_KEY` | ✅ chat | LLM key for the agent. Must support OpenAI-style tool calling. Does **not** fall back to `OPENAI_*`. |
| `CANVAS_CHAT_BASE_URL` | – | Chat endpoint; empty = OpenAI default. |
| `CANVAS_CHAT_MODEL` | – | Default `gpt-4o-mini`. |
| `CANVAS_IMAGE_PRIMARY_API_KEY` | ✅ images | Key for image generation / editing. Falls back to `OPENAI_API_KEY` if unset. |
| `CANVAS_IMAGE_PRIMARY_BASE_URL` | – | Image endpoint (OpenAI-compatible `/images/generations`). Falls back to `OPENAI_BASE_URL`. |
| `CANVAS_IMAGE_PRIMARY_MODEL` | ✅ images | Image model name. |
| `CANVAS_VIDEO_API_KEY` / `_BASE_URL` / `_MODEL` | ✅ video | Required to use the Video feature (OpenAI-compatible `POST {base}/videos/generations` + poll). |
| `CANVAS_ANGLE_FAL_API_KEY` | ✅ angle | [fal.ai](https://fal.ai) key; required for the Angle (camera-viewpoint) feature. |
| `PUBLIC_MEDIA_BASE` | ⚠️ | Public URL of this backend (default `http://localhost:28000`). Must be reachable by the providers for image-to-image / video / angle (they fetch the source image) — use a tunnel/CDN in prod. Pure text-to-image doesn't need it. |
| `CANVAS_AGENT_STORE_BACKEND` | – | `memory` (default, in-process) or `postgres` (persistent agent memory). |
| `POSTGRES_DB` / `_USER` / `_PASSWORD` | – | Default all `canvex`. |
| `BACKEND_PORT` / `FRONTEND_PORT` | – | Host ports, default `28000` / `5173`. |
| `VITE_API_URL` | – | Backend URL the frontend calls; default `http://localhost:28000`. |

Notes:

- The image channel also accepts a fallback provider (`CANVAS_IMAGE_FALLBACK_*`) plus per-provider field-mapping / async-polling knobs (`CANVAS_IMAGE_PRIMARY_IMAGE_FIELD`, `_RESPONSE_FORMAT`, `_POLL_ENABLED`, `_POLL_MAX_ATTEMPTS`, `_POLL_INTERVAL`, …) so it works with non-OpenAI gateways. See [.env.example](./.env.example).
- Chat and image/video can share one provider (set the matching `*_BASE_URL` and keys).
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

- **Image / video looks wrong or errors** — verify the provider model name, base URL, and the `CANVAS_IMAGE_PRIMARY_*` / `CANVAS_VIDEO_*` keys.
- **Image-to-image / video / angle never returns** — the provider must be able to fetch your source image; set `PUBLIC_MEDIA_BASE` to a publicly reachable URL.
- **Frontend requests blocked by CORS** — keep `CORS_ALLOW_ALL_ORIGINS=true` (default) or list your origin in `CORS_ALLOWED_ORIGINS`.
