from __future__ import annotations

import hashlib
import mimetypes

from PIL import Image
from rest_framework import serializers

from .models import (
    DataAsset,
    DataFolder,
    ExcalidrawChatMessage,
    ExcalidrawScene,
)


class DataFolderSerializer(serializers.ModelSerializer):
    class Meta:
        model = DataFolder
        fields = ["id", "name", "parent", "created_at", "updated_at"]


class DataAssetSerializer(serializers.ModelSerializer):
    url = serializers.SerializerMethodField()

    class Meta:
        model = DataAsset
        fields = [
            "id",
            "folder",
            "filename",
            "file",
            "url",
            "mime_type",
            "size_bytes",
            "width",
            "height",
            "alt_text",
            "tags",
            "is_public",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["size_bytes", "width", "height", "checksum_sha256"]

    def get_url(self, obj):
        request = self.context.get("request")
        try:
            url = obj.file.url
        except Exception:
            return ""
        if request is not None:
            return request.build_absolute_uri(url)
        return url

    def create(self, validated_data):
        f = validated_data.get("file")
        if f and not validated_data.get("filename"):
            validated_data["filename"] = getattr(f, "name", "uploaded")

        if f:
            validated_data["size_bytes"] = getattr(f, "size", 0) or 0
            content_type = getattr(f, "content_type", "") or ""
            if not content_type:
                content_type = mimetypes.guess_type(validated_data.get("filename", ""))[0] or ""
            validated_data["mime_type"] = content_type

            try:
                f.seek(0)
                h = hashlib.sha256()
                for chunk in iter(lambda: f.read(8192), b""):
                    h.update(chunk)
                validated_data["checksum_sha256"] = h.hexdigest()
            finally:
                try:
                    f.seek(0)
                except Exception:
                    pass

            try:
                f.seek(0)
                image = Image.open(f)
                validated_data["width"], validated_data["height"] = image.size
            except Exception:
                pass
            finally:
                try:
                    f.seek(0)
                except Exception:
                    pass

        return super().create(validated_data)


class ExcalidrawSceneSerializer(serializers.ModelSerializer):
    class Meta:
        model = ExcalidrawScene
        fields = ["id", "title", "data", "created_at", "updated_at"]
        read_only_fields = ["created_at", "updated_at"]

    def validate_data(self, value):
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise serializers.ValidationError("data must be an object")
        return value


class ExcalidrawChatMessageSerializer(serializers.ModelSerializer):
    class Meta:
        model = ExcalidrawChatMessage
        fields = ["id", "scene", "role", "content", "created_at"]
        read_only_fields = ["id", "scene", "created_at"]
