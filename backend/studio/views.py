from __future__ import annotations

import json
import logging
import os
from typing import Any

from django.http import StreamingHttpResponse
from django.shortcuts import get_object_or_404
from rest_framework import parsers, permissions, status, viewsets
from rest_framework.response import Response
from rest_framework.views import APIView

from .graphs import call_llm, chat_graph, load_memory, update_memory
from .models import (
    DataAsset,
    DataFolder,
    ExcalidrawChatMessage,
    ExcalidrawImageEditJob,
    ExcalidrawScene,
    ExcalidrawVideoJob,
)
from .serializers import (
    DataAssetSerializer,
    DataFolderSerializer,
    ExcalidrawChatMessageSerializer,
    ExcalidrawSceneListSerializer,
    ExcalidrawSceneSerializer,
)
from .tasks import run_excalidraw_image_edit_job, run_excalidraw_video_job
from .tools import _abs_url
from .video_script import (
    analyze_video_shooting_script,
    resolve_video_duration_seconds,
)

logger = logging.getLogger(__name__)

DEFAULT_HISTORY_LIMIT = 20
MAX_HISTORY_LIMIT = 50
WORKSPACE_ID = os.getenv("WORKSPACE_ID", "public")

CUTOUT_PROMPT = """
Extract ONLY the actual subject indicated by the user-drawn dashed bounding box.
The dashed bounding box is a guide only and must NOT appear in the output.

Remove and discard all other content, including the dashed bounding box itself.
Set all non-subject pixels to pure white (#FFFFFF).
Output a PNG with a solid pure white background (no transparent pixels).

Do NOT add, hallucinate, reconstruct, or extend any part of the subject.
Do NOT include shadows, gradients, textures, or environmental context.
Preserve the subject's original shape, proportions, colors, and fine details.
Edges must be clean and accurate, with no halos, fringing, or color bleeding.

If the subject touches the dashed bounding box edge, keep only the visible portion and do not complete missing areas.
The final image must contain only the subject on a pure white background.
"""

EDIT_DEFAULT_PROMPT = "Refine the image while preserving content and layout."


# ---------------------------------------------------------------------------
# 公用辅助
# ---------------------------------------------------------------------------

def _error_response(detail: str, code: str, http_status: int) -> Response:
    return Response({"detail": detail, "code": code}, status=http_status)


def _parse_limit(request, default: int = 20, maximum: int = 50) -> int:
    try:
        limit = int(request.query_params.get("limit", default))
    except Exception:
        limit = default
    return max(1, min(maximum, limit))


class SceneMixin:
    def get_scene(self, scene_id):
        return get_object_or_404(ExcalidrawScene, id=scene_id)


# ---------------------------------------------------------------------------
# Data 资产 / 文件夹
# ---------------------------------------------------------------------------

class DataFolderViewSet(viewsets.ModelViewSet):
    permission_classes = [permissions.AllowAny]
    serializer_class = DataFolderSerializer
    queryset = DataFolder.objects.all()

    def get_queryset(self):
        qs = DataFolder.objects.all().order_by("name")
        parent = self.request.query_params.get("parent")
        if parent == "null" or parent == "None":
            qs = qs.filter(parent__isnull=True)
        elif parent:
            qs = qs.filter(parent_id=parent)
        return qs

    def perform_update(self, serializer):
        obj = serializer.save()
        obj.full_clean()


class DataAssetViewSet(viewsets.ModelViewSet):
    permission_classes = [permissions.AllowAny]
    serializer_class = DataAssetSerializer
    queryset = DataAsset.objects.all()
    parser_classes = [parsers.MultiPartParser, parsers.FormParser, parsers.JSONParser]

    def get_queryset(self):
        qs = DataAsset.objects.all().order_by("-created_at")
        folder = self.request.query_params.get("folder")
        if folder == "null" or folder == "None":
            qs = qs.filter(folder__isnull=True)
        elif folder:
            qs = qs.filter(folder_id=folder)
        return qs


# ---------------------------------------------------------------------------
# Excalidraw 画布
# ---------------------------------------------------------------------------

class ExcalidrawSceneViewSet(viewsets.ModelViewSet):
    permission_classes = [permissions.AllowAny]
    queryset = ExcalidrawScene.objects.all().order_by("-updated_at")

    def get_queryset(self):
        queryset = super().get_queryset()
        if self.action == "list":
            return queryset.defer("data")
        return queryset

    def get_serializer_class(self):
        if self.action == "list":
            return ExcalidrawSceneListSerializer
        return ExcalidrawSceneSerializer


# ---------------------------------------------------------------------------
# Excalidraw 聊天
# ---------------------------------------------------------------------------

class ExcalidrawSceneChatView(SceneMixin, APIView):
    permission_classes = [permissions.AllowAny]

    def _wants_stream(self, request) -> bool:
        if request.query_params.get("stream") in ("1", "true", "yes"):
            return True
        accept = request.headers.get("Accept", "")
        return "text/event-stream" in accept

    def _chunk_text(self, text: str, size: int = 24):
        if size <= 0:
            yield text
            return
        for i in range(0, len(text), size):
            yield text[i : i + size]

    @staticmethod
    def _fallback_text_from_tool_results(tool_results: list[dict[str, Any]] | None) -> str | None:
        if not tool_results:
            return None
        has_video_url = False
        has_video_task = False
        has_image_url = False
        has_flowchart = False
        for item in tool_results:
            if not isinstance(item, dict):
                continue
            tool_name = item.get("tool")
            result = item.get("result") if isinstance(item.get("result"), dict) else {}
            if tool_name == "videotool":
                if result.get("url"):
                    has_video_url = True
                elif result.get("task_id") or result.get("job_id") or str(result.get("status", "")).upper() in {"QUEUED", "RUNNING"}:
                    has_video_task = True
            if tool_name == "imagetool" and result.get("url"):
                has_image_url = True
            if tool_name == "mermaid_flowchart" and result.get("mermaid"):
                has_flowchart = True
        if has_video_url:
            return "视频已生成。"
        if has_video_task:
            return "视频任务已提交。"
        if has_image_url:
            return "图片已生成。"
        if has_flowchart:
            return "流程图已生成。"
        return None

    def get(self, request, scene_id):
        scene = self.get_scene(scene_id)
        limit = _parse_limit(request, default=DEFAULT_HISTORY_LIMIT, maximum=MAX_HISTORY_LIMIT)
        qs = ExcalidrawChatMessage.objects.filter(scene=scene).order_by("-created_at")[:limit]
        messages = list(reversed(qs))
        serializer = ExcalidrawChatMessageSerializer(messages, many=True)
        return Response(serializer.data)

    def _build_chat_state(self, scene, user_message):
        qs = ExcalidrawChatMessage.objects.filter(scene=scene).order_by("-created_at")[:DEFAULT_HISTORY_LIMIT]
        history = list(reversed(qs))
        return {
            "scene_id": str(scene.id),
            "workspace_id": WORKSPACE_ID,
            "scene_title": scene.title or "",
            "messages": [
                {"role": msg.role, "content": msg.content}
                for msg in history
                if msg.role in (ExcalidrawChatMessage.Role.USER, ExcalidrawChatMessage.Role.ASSISTANT)
            ],
            "summary_state": {},
            "memory_state": {},
            "last_user": user_message.content,
            "assistant": None,
            "intent": None,
        }

    def post(self, request, scene_id):
        scene = self.get_scene(scene_id)
        content = (request.data or {}).get("content")
        if not isinstance(content, str) or not content.strip():
            return _error_response("content is required", "content_required", status.HTTP_400_BAD_REQUEST)

        user_message = ExcalidrawChatMessage.objects.create(
            scene=scene,
            role=ExcalidrawChatMessage.Role.USER,
            content=content.strip(),
        )

        state = self._build_chat_state(scene, user_message)

        if self._wants_stream(request):
            return self._stream_chat_response(state, scene)

        state.update(load_memory(state))

        result = None
        tool_results = []
        seen_tool_keys = set()
        try:
            for update in chat_graph.stream(state, stream_mode="values"):
                if isinstance(update, dict) and update.get("tool_results"):
                    for item in update.get("tool_results") or []:
                        key = self._tool_result_key(item)
                        if key in seen_tool_keys:
                            continue
                        seen_tool_keys.add(key)
                        tool_results.append(item)
                if isinstance(update, dict) and update.get("assistant"):
                    result = update
        except Exception as exc:
            logger.exception("LLM call failed: %s", exc)
            assistant_content = "LLM 未配置或调用失败，请检查 OPENAI_API_KEY / MEDIA_OPENAI 配置。"
            result = {"assistant": {"role": "assistant", "content": assistant_content}}

        assistant_payload = (result or {}).get("assistant") or {}
        assistant_content = (assistant_payload.get("content") or "").strip()
        if not assistant_content and tool_results:
            assistant_content = self._fallback_text_from_tool_results(tool_results) or ""
        if not assistant_content:
            assistant_content = "LLM 返回为空，请检查模型或网络配置。"

        state["assistant"] = {"role": "assistant", "content": assistant_content}
        try:
            update_memory(state)
        except Exception:
            pass

        assistant_message = ExcalidrawChatMessage.objects.create(
            scene=scene,
            role=ExcalidrawChatMessage.Role.ASSISTANT,
            content=assistant_content,
        )

        serializer = ExcalidrawChatMessageSerializer(assistant_message)
        payload = dict(serializer.data)
        if tool_results:
            payload["tool_results"] = tool_results
        return Response(payload, status=status.HTTP_201_CREATED)

    def _stream_chat_response(self, state, scene):
        state.update(load_memory(state))

        def event_stream():
            assistant_content = ""
            sent_tool_keys = set()
            sent_intents = set()
            tool_results: list[dict[str, Any]] = []
            yield ":\n\n"
            try:
                for update in call_llm(state):
                    if isinstance(update, dict) and update.get("intent"):
                        intent_value = update.get("intent")
                        if intent_value not in sent_intents:
                            sent_intents.add(intent_value)
                            yield f"data: {json.dumps({'intent': intent_value}, ensure_ascii=False, default=str)}\n\n"

                    if isinstance(update, dict) and update.get("tool_results"):
                        for item in update.get("tool_results") or []:
                            key = self._tool_result_key(item)
                            if key in sent_tool_keys:
                                continue
                            sent_tool_keys.add(key)
                            if isinstance(item, dict):
                                tool_results.append(item)
                            payload = {
                                "tool": item.get("tool"),
                                "result": item.get("result"),
                                "tool-result": {
                                    "tool": item.get("tool"),
                                    "result": item.get("result"),
                                },
                            }
                            yield f"data: {json.dumps(payload, ensure_ascii=False, default=str)}\n\n"

                    assistant_payload = (update or {}).get("assistant") or {}
                    content = assistant_payload.get("content") or ""
                    if content and len(content) > len(assistant_content):
                        delta = content[len(assistant_content) :]
                        assistant_content = content
                        for piece in self._chunk_text(delta):
                            yield f"data: {json.dumps({'delta': piece}, ensure_ascii=False, default=str)}\n\n"
            except Exception as exc:
                logger.exception("Stream LLM call failed: %s", exc)
                assistant_content = "LLM 未配置或调用失败，请检查 OPENAI_API_KEY / MEDIA_OPENAI 配置。"

            if not assistant_content.strip():
                if sent_tool_keys:
                    assistant_content = self._fallback_text_from_tool_results(tool_results) or ""
                else:
                    assistant_content = "LLM 返回为空，请检查模型或网络配置。"
            if not assistant_content.strip():
                assistant_content = "LLM 返回为空，请检查模型或网络配置。"

            state["assistant"] = {"role": "assistant", "content": assistant_content.strip()}
            try:
                update_memory(state)
            except Exception:
                pass

            assistant_message = ExcalidrawChatMessage.objects.create(
                scene=scene,
                role=ExcalidrawChatMessage.Role.ASSISTANT,
                content=assistant_content.strip(),
            )
            serializer = ExcalidrawChatMessageSerializer(assistant_message)
            yield f"data: {json.dumps({'done': True, 'message': serializer.data}, ensure_ascii=False, default=str)}\n\n"

        response = StreamingHttpResponse(event_stream(), content_type="text/event-stream")
        response["Cache-Control"] = "no-cache"
        response["X-Accel-Buffering"] = "no"
        return response

    @staticmethod
    def _tool_result_key(item: dict | None) -> str:
        if not item:
            return "empty"
        tool = item.get("tool") or ""
        result = item.get("result") or {}
        asset_id = result.get("asset_id") if isinstance(result, dict) else None
        if asset_id:
            return f"{tool}:{asset_id}"
        try:
            serialized = json.dumps(result, ensure_ascii=False, sort_keys=True, default=str)
        except Exception:
            serialized = str(result)
        return f"{tool}:{serialized}"


# ---------------------------------------------------------------------------
# Excalidraw 图片编辑
# ---------------------------------------------------------------------------

class ExcalidrawImageEditView(SceneMixin, APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request, scene_id):
        scene = self.get_scene(scene_id)
        prompt = (request.data or {}).get("prompt", "")
        prompt = prompt.strip() if isinstance(prompt, str) else ""

        cutout = (request.data or {}).get("cutout")
        if isinstance(cutout, str):
            cutout = cutout.strip().lower() in ("1", "true", "yes", "on")
        cutout = bool(cutout)
        if cutout:
            prompt = CUTOUT_PROMPT
        if not prompt:
            prompt = EDIT_DEFAULT_PROMPT

        image_file = request.FILES.get("image")
        if not image_file:
            return _error_response("image is required", "image_required", status.HTTP_400_BAD_REQUEST)

        size = (request.data or {}).get("size")
        if not isinstance(size, str) or not size.strip():
            size = ""

        num_images = (request.data or {}).get("n", 1)
        try:
            num_images = int(num_images)
        except Exception:
            num_images = 1
        if num_images not in (1, 2, 4):
            num_images = 1

        try:
            job = ExcalidrawImageEditJob.objects.create(
                scene=scene,
                prompt=prompt,
                size=size,
                num_images=num_images,
                is_cutout=cutout,
                source_image=image_file,
                status=ExcalidrawImageEditJob.Status.QUEUED,
            )
            run_excalidraw_image_edit_job.apply_async(args=[str(job.id)], queue="excalidraw")
        except Exception as exc:
            logger.exception("Failed to create image edit job: %s", exc)
            return _error_response("Failed to create image edit job", "image_job_create_failed", status.HTTP_500_INTERNAL_SERVER_ERROR)

        return Response({"job_id": str(job.id), "status": job.status}, status=status.HTTP_202_ACCEPTED)


class ExcalidrawImageEditJobView(APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request, job_id):
        job = get_object_or_404(ExcalidrawImageEditJob, id=job_id)
        payload = {"job_id": str(job.id), "status": job.status}
        if job.error:
            payload["error"] = job.error
        if job.result_asset_id:
            asset = job.result_asset
            payload["result"] = {
                "asset_id": str(asset.id),
                "url": _abs_url(getattr(asset.file, "url", None)),
                "width": asset.width,
                "height": asset.height,
                "mime_type": asset.mime_type,
            }

        results = []
        for item in job.results.select_related("asset").all():
            asset = item.asset
            results.append(
                {
                    "order": item.order,
                    "asset_id": str(asset.id),
                    "url": _abs_url(getattr(asset.file, "url", None)),
                    "width": asset.width,
                    "height": asset.height,
                    "mime_type": asset.mime_type,
                }
            )
        if results:
            payload["results"] = results
        return Response(payload)


class ExcalidrawSceneImageEditJobListView(SceneMixin, APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request, scene_id):
        scene = self.get_scene(scene_id)
        limit = _parse_limit(request)

        qs = ExcalidrawImageEditJob.objects.filter(scene=scene).order_by("-created_at")[:limit]
        data = []
        for job in qs:
            data.append(
                {
                    "id": str(job.id),
                    "status": job.status,
                    "num_images": job.num_images,
                    "error": job.error or None,
                    "created_at": job.created_at.isoformat() if job.created_at else None,
                    "updated_at": job.updated_at.isoformat() if job.updated_at else None,
                }
            )
        return Response(data)


# ---------------------------------------------------------------------------
# Excalidraw 视频生成
# ---------------------------------------------------------------------------

class ExcalidrawVideoGenerateView(SceneMixin, APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request, scene_id):
        scene = self.get_scene(scene_id)
        prompt = (request.data or {}).get("prompt", "")
        prompt = prompt.strip() if isinstance(prompt, str) else ""

        image_urls = (request.data or {}).get("image_urls") or []
        if isinstance(image_urls, str):
            image_urls = [image_urls]
        if not isinstance(image_urls, list):
            image_urls = []
        image_urls = [item for item in image_urls if isinstance(item, str) and item.strip()]

        duration, duration_source = resolve_video_duration_seconds(request.data or {}, prompt)

        # Prompt priority:
        # 1) user prompt -> use directly
        # 2) empty prompt -> derive script via system_prompt (requires at least one image url)
        if not prompt:
            if not image_urls:
                return _error_response(
                    "prompt is required when image_urls is empty",
                    "video_prompt_required",
                    status.HTTP_400_BAD_REQUEST,
                )
            script = analyze_video_shooting_script(image_urls[0], "", duration or 10, duration_source)
            script = script.strip() if isinstance(script, str) else ""
            if not script:
                return _error_response(
                    "failed to generate video script from image",
                    "video_script_generation_failed",
                    status.HTTP_400_BAD_REQUEST,
                )
            prompt = script

        aspect_ratio = (request.data or {}).get("aspect_ratio") or "16:9"
        if not isinstance(aspect_ratio, str) or not aspect_ratio.strip():
            aspect_ratio = "16:9"

        if not os.getenv("MEDIA_VIDEO_MODEL", "").strip():
            return _error_response(
                "video model is not configured; set MEDIA_VIDEO_MODEL",
                "video_model_not_configured",
                status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        try:
            create_kwargs: dict[str, Any] = {
                "scene": scene,
                "prompt": prompt,
                "image_urls": image_urls,
                "aspect_ratio": aspect_ratio,
                "status": ExcalidrawVideoJob.Status.QUEUED,
            }
            if duration is not None:
                create_kwargs["duration"] = duration
            job = ExcalidrawVideoJob.objects.create(**create_kwargs)
            run_excalidraw_video_job.apply_async(args=[str(job.id)], queue="excalidraw")
        except Exception as exc:
            logger.exception("Failed to create video job: %s", exc)
            return _error_response("Failed to create video job", "video_job_create_failed", status.HTTP_500_INTERNAL_SERVER_ERROR)

        return Response({"job_id": str(job.id), "status": job.status}, status=status.HTTP_202_ACCEPTED)


class ExcalidrawVideoJobView(APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request, job_id):
        job = get_object_or_404(ExcalidrawVideoJob, id=job_id)
        payload = {"job_id": str(job.id), "status": job.status}
        if job.error:
            payload["error"] = job.error
        if job.result_url:
            payload["result"] = {
                "url": job.result_url,
                "thumbnail_url": job.thumbnail_url,
                "task_id": job.task_id,
            }
        return Response(payload)


class ExcalidrawSceneVideoJobListView(SceneMixin, APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request, scene_id):
        scene = self.get_scene(scene_id)
        limit = _parse_limit(request)

        qs = ExcalidrawVideoJob.objects.filter(scene=scene).order_by("-created_at")[:limit]
        data = []
        for job in qs:
            data.append(
                {
                    "id": str(job.id),
                    "status": job.status,
                    "result_url": job.result_url,
                    "thumbnail_url": job.thumbnail_url,
                    "task_id": job.task_id,
                    "error": job.error or None,
                    "created_at": job.created_at.isoformat() if job.created_at else None,
                    "updated_at": job.updated_at.isoformat() if job.updated_at else None,
                }
            )
        return Response(data)
