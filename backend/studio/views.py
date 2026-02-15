from __future__ import annotations

import base64
import io
import json
import logging
import os
from typing import Any

from django.http import StreamingHttpResponse
from django.shortcuts import get_object_or_404
from PIL import Image
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
    ExcalidrawSceneSerializer,
)
from .tasks import run_excalidraw_image_edit_job, run_excalidraw_video_job
from .tools import _abs_url, _resolve_image_bytes, openai_client_for_media

logger = logging.getLogger(__name__)

DEFAULT_HISTORY_LIMIT = 20
MAX_HISTORY_LIMIT = 50
WORKSPACE_ID = os.getenv("WORKSPACE_ID", "public")

EXCALIDRAW_CUTOUT_PROMPT = """
Extract ONLY the actual subject indicated by the user-drawn dashed bounding box.
The dashed bounding box is a guide only and must NOT appear in the output.

Remove and discard all other content, including the dashed bounding box itself.
Place the extracted subject on a solid pure background color (#FFFFFF).

Do NOT add, hallucinate, reconstruct, or extend any part of the subject.
Do NOT include shadows, gradients, textures, or environmental context.
Preserve the subject’s original shape, proportions, colors, and fine details.
Edges must be clean and accurate, with no halos, fringing, or color bleeding.

If the subject touches the dashed bounding box edge, keep only the visible portion and do not complete missing areas.
The final image must contain only the subject on a uniform pure background color.
"""

EXCALIDRAW_EDIT_DEFAULT_PROMPT = "Refine the image while preserving content and layout."


def _flatten_llm_content(raw) -> str:
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw
    if isinstance(raw, dict):
        return json.dumps(raw, ensure_ascii=False)
    if isinstance(raw, list):
        pieces = []
        for item in raw:
            if isinstance(item, str):
                pieces.append(item)
            elif isinstance(item, dict):
                text = item.get("text") or item.get("value") or ""
                if not text and isinstance(item.get("content"), str):
                    text = item["content"]
                if text:
                    pieces.append(str(text))
        return "".join(pieces)
    try:
        return json.dumps(raw, ensure_ascii=False)
    except TypeError:
        return str(raw)


def _read_positive_int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(str(raw).strip())
        if value > 0:
            return value
    except Exception:
        pass
    return default


def _build_inline_image_data_url(image_url: str) -> str | None:
    try:
        image_bytes = _resolve_image_bytes(image_url)
        with Image.open(io.BytesIO(image_bytes)) as original:
            image = original.copy()
    except Exception:
        return None

    max_side = _read_positive_int_env("MEDIA_OPENAI_SCRIPT_IMAGE_MAX_SIDE", 1280)
    width, height = image.size
    if max(width, height) > max_side:
        scale = max_side / float(max(width, height))
        resized_width = max(1, int(round(width * scale)))
        resized_height = max(1, int(round(height * scale)))
        resampling = getattr(Image, "Resampling", Image)
        image = image.resize((resized_width, resized_height), resampling.LANCZOS)

    has_alpha = "A" in image.getbands()
    output = io.BytesIO()
    if has_alpha:
        if image.mode != "RGBA":
            image = image.convert("RGBA")
        image.save(output, format="PNG", optimize=True)
        mime_type = "image/png"
    else:
        if image.mode != "RGB":
            image = image.convert("RGB")
        quality = _read_positive_int_env("MEDIA_OPENAI_SCRIPT_IMAGE_JPEG_QUALITY", 85)
        quality = max(40, min(95, quality))
        image.save(output, format="JPEG", optimize=True, quality=quality)
        mime_type = "image/jpeg"

    encoded = base64.b64encode(output.getvalue()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def _request_video_shooting_script(client: Any, model_name: str, system_prompt: str, user_text: str, image_ref: str) -> str:
    response = client.chat.completions.create(
        model=model_name,
        temperature=0.2,
        messages=[
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_text},
                    {"type": "image_url", "image_url": {"url": image_ref}},
                ],
            },
        ],
    )
    return _flatten_llm_content(response.choices[0].message.content).strip()


def _analyze_video_shooting_script(image_url: str, prompt: str) -> str:
    if not image_url or not isinstance(image_url, str):
        return ""
    if not image_url.lower().startswith(("http://", "https://")):
        return ""

    system_prompt = (
        "你是高级产品视频设计导演。请基于给定图片输出一段高级产品视频拍摄脚本，"
        "包含镜头顺序、景别、机位/运动、时长或节奏提示，并突出产品卖点与质感。"
        "只输出脚本正文，不要添加解释或标题。"
        "脚本需遵循用户的补充需求（若有）。"
    )
    user_text = "请分析这张图片并生成拍摄脚本。"
    if prompt:
        user_text = f"{user_text}\n用户需求：{prompt}"

    model_name = os.getenv("MEDIA_OPENAI_SCRIPT_MODEL", "gpt-4.1-mini")
    try:
        client = openai_client_for_media()
        inline_image_url = _build_inline_image_data_url(image_url)
        image_ref = inline_image_url or image_url
        content = _request_video_shooting_script(client, model_name, system_prompt, user_text, image_ref)

        if not content and inline_image_url:
            # Fallback for providers that reject data URL image payloads.
            content = _request_video_shooting_script(client, model_name, system_prompt, user_text, image_url)

        return content[:1500].strip()
    except Exception as exc:
        logger.warning("MEDIA_OPENAI video script analysis failed: %s", exc, exc_info=True)
        return ""


def _error_response(detail: str, code: str, http_status: int) -> Response:
    return Response({"detail": detail, "code": code}, status=http_status)


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


class ExcalidrawSceneViewSet(viewsets.ModelViewSet):
    permission_classes = [permissions.AllowAny]
    serializer_class = ExcalidrawSceneSerializer
    queryset = ExcalidrawScene.objects.all().order_by("-updated_at")


class ExcalidrawSceneChatView(APIView):
    permission_classes = [permissions.AllowAny]

    def _wants_stream(self, request) -> bool:
        if request.query_params.get("stream") in ("1", "true", "yes"):
            return True
        accept = request.headers.get("Accept", "")
        return "text/event-stream" in accept

    def get_scene(self, scene_id):
        return get_object_or_404(ExcalidrawScene, id=scene_id)

    def _chunk_text(self, text: str, size: int = 24):
        if size <= 0:
            yield text
            return
        for i in range(0, len(text), size):
            yield text[i : i + size]

    def get(self, request, scene_id):
        scene = self.get_scene(scene_id)
        try:
            limit = int(request.query_params.get("limit", DEFAULT_HISTORY_LIMIT))
        except Exception:
            limit = DEFAULT_HISTORY_LIMIT
        limit = max(1, min(MAX_HISTORY_LIMIT, limit))
        qs = ExcalidrawChatMessage.objects.filter(scene=scene).order_by("-created_at")[:limit]
        messages = list(reversed(qs))
        serializer = ExcalidrawChatMessageSerializer(messages, many=True)
        return Response(serializer.data)

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

        qs = ExcalidrawChatMessage.objects.filter(scene=scene).order_by("-created_at")[:DEFAULT_HISTORY_LIMIT]
        history = list(reversed(qs))

        state = {
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

        if self._wants_stream(request):
            return self._stream_chat_response(state, scene)

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
            # 兜底助手回复，避免前端报错
            assistant_content = "LLM 未配置或调用失败，请检查 OPENAI_API_KEY / MEDIA_OPENAI 配置。"
            result = {"assistant": {"role": "assistant", "content": assistant_content}}

        assistant_payload = (result or {}).get("assistant") or {}
        assistant_content = (assistant_payload.get("content") or "").strip()
        if not assistant_content and tool_results:
            assistant_content = "视频已生成。" if any(item.get("tool") == "videotool" for item in tool_results) else "图片已生成。"
        if not assistant_content:
            assistant_content = "LLM 返回为空，请检查模型或网络配置。"

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
            sent_tool_names = set()
            sent_intents = set()
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
                            tool_name = item.get("tool")
                            if tool_name:
                                sent_tool_names.add(tool_name)
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
                    assistant_content = "视频已生成。" if "videotool" in sent_tool_names else "图片已生成。"
                else:
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


class ExcalidrawImageEditView(APIView):
    permission_classes = [permissions.AllowAny]

    def get_scene(self, scene_id):
        return get_object_or_404(ExcalidrawScene, id=scene_id)

    def post(self, request, scene_id):
        scene = self.get_scene(scene_id)
        prompt = (request.data or {}).get("prompt", "")
        prompt = prompt.strip() if isinstance(prompt, str) else ""

        cutout = (request.data or {}).get("cutout")
        if isinstance(cutout, str):
            cutout = cutout.strip().lower() in ("1", "true", "yes", "on")
        cutout = bool(cutout)
        if cutout:
            prompt = EXCALIDRAW_CUTOUT_PROMPT
        if not prompt:
            prompt = EXCALIDRAW_EDIT_DEFAULT_PROMPT

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


class ExcalidrawSceneImageEditJobListView(APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request, scene_id):
        scene = get_object_or_404(ExcalidrawScene, id=scene_id)
        try:
            limit = int(request.query_params.get("limit", 20))
        except Exception:
            limit = 20
        limit = max(1, min(50, limit))

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


class ExcalidrawVideoGenerateView(APIView):
    permission_classes = [permissions.AllowAny]
    DEFAULT_PROMPT = (
        "Create a smooth, high-quality showcase video based on the prompt. "
        "Keep colors and details accurate, use gentle camera motion, and avoid adding new elements or text."
    )

    def get_scene(self, scene_id):
        return get_object_or_404(ExcalidrawScene, id=scene_id)

    def post(self, request, scene_id):
        scene = self.get_scene(scene_id)
        prompt = (request.data or {}).get("prompt", "")
        prompt = prompt.strip() if isinstance(prompt, str) else ""
        if not prompt:
            prompt = self.DEFAULT_PROMPT

        image_urls = (request.data or {}).get("image_urls") or []
        if isinstance(image_urls, str):
            image_urls = [image_urls]
        if not isinstance(image_urls, list):
            image_urls = []
        image_urls = [item for item in image_urls if isinstance(item, str) and item.strip()]

        script = _analyze_video_shooting_script(image_urls[0], prompt) if image_urls else ""
        if script:
            prompt = f"{prompt}\n\n拍摄脚本：\n{script}\n\n请严格参考拍摄脚本生成视频，不要添加文字或新的元素。"

        duration = (request.data or {}).get("duration", 15)
        try:
            duration = int(duration)
        except Exception:
            duration = 15

        aspect_ratio = (request.data or {}).get("aspect_ratio") or "16:9"
        if not isinstance(aspect_ratio, str) or not aspect_ratio.strip():
            aspect_ratio = "16:9"

        model_name = (request.data or {}).get("model") or ""
        if not isinstance(model_name, str):
            model_name = ""

        try:
            job = ExcalidrawVideoJob.objects.create(
                scene=scene,
                prompt=prompt,
                image_urls=image_urls,
                duration=duration,
                aspect_ratio=aspect_ratio,
                model_name=model_name,
                status=ExcalidrawVideoJob.Status.QUEUED,
            )
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


class ExcalidrawSceneVideoJobListView(APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request, scene_id):
        scene = get_object_or_404(ExcalidrawScene, id=scene_id)
        try:
            limit = int(request.query_params.get("limit", 20))
        except Exception:
            limit = 20
        limit = max(1, min(50, limit))

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
