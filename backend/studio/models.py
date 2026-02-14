from __future__ import annotations

import uuid
from datetime import datetime
from pathlib import Path

from django.core.exceptions import ValidationError
from django.db import models


def library_upload_to(instance, filename: str) -> str:
    ext = Path(filename).suffix.lower()
    now = datetime.utcnow()
    return f"library/{now:%Y/%m/%d}/{uuid.uuid4().hex}{ext}"


def excalidraw_edit_upload_to(instance, filename: str) -> str:
    ext = Path(filename).suffix.lower()
    now = datetime.utcnow()
    return f"canvex_edits/{now:%Y/%m/%d}/{uuid.uuid4().hex}{ext}"


class DataFolder(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=255)
    parent = models.ForeignKey(
        "self",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="children",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]
        unique_together = (("parent", "name"),)

    def __str__(self) -> str:
        return self.name

    def clean(self):
        node = self.parent
        while node is not None:
            if node.id == self.id:
                raise ValidationError("Cannot move folder into its own descendant")
            node = node.parent


class DataAsset(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    folder = models.ForeignKey(DataFolder, on_delete=models.CASCADE, null=True, blank=True, related_name="assets")
    file = models.ImageField(upload_to=library_upload_to)
    filename = models.CharField(max_length=255)
    mime_type = models.CharField(max_length=100, blank=True)
    size_bytes = models.BigIntegerField(default=0)
    checksum_sha256 = models.CharField(max_length=64, blank=True)
    width = models.IntegerField(null=True, blank=True)
    height = models.IntegerField(null=True, blank=True)
    alt_text = models.CharField(max_length=255, blank=True)
    tags = models.JSONField(default=list, blank=True)
    is_public = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        unique_together = (("folder", "filename"),)

    def __str__(self) -> str:
        return self.filename


class ExcalidrawScene(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    title = models.CharField(max_length=255, blank=True)
    data = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]

    def __str__(self):
        return self.title or f"Scene {self.id}"


class ExcalidrawChatMessage(models.Model):
    class Role(models.TextChoices):
        USER = "user", "User"
        ASSISTANT = "assistant", "Assistant"
        SYSTEM = "system", "System"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    scene = models.ForeignKey(ExcalidrawScene, on_delete=models.CASCADE, related_name="chat_messages")
    role = models.CharField(max_length=16, choices=Role.choices)
    content = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]

    def __str__(self):
        return f"{self.role}: {self.content[:40]}"


class ExcalidrawImageEditJob(models.Model):
    class Status(models.TextChoices):
        QUEUED = "QUEUED", "Queued"
        RUNNING = "RUNNING", "Running"
        SUCCEEDED = "SUCCEEDED", "Succeeded"
        FAILED = "FAILED", "Failed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    scene = models.ForeignKey(ExcalidrawScene, on_delete=models.CASCADE, related_name="image_edit_jobs")
    prompt = models.TextField()
    size = models.CharField(max_length=32, default="1024x1024")
    num_images = models.PositiveSmallIntegerField(default=1)
    is_cutout = models.BooleanField(default=False)
    source_image = models.ImageField(upload_to=excalidraw_edit_upload_to)
    result_asset = models.ForeignKey(
        DataAsset,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="excalidraw_image_edit_results",
    )
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.QUEUED, db_index=True)
    error = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]


class ExcalidrawImageEditResult(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    job = models.ForeignKey(ExcalidrawImageEditJob, on_delete=models.CASCADE, related_name="results")
    asset = models.ForeignKey(DataAsset, on_delete=models.CASCADE, related_name="image_edit_result_assets")
    order = models.PositiveSmallIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["order", "created_at"]


class ExcalidrawVideoJob(models.Model):
    class Status(models.TextChoices):
        QUEUED = "QUEUED", "Queued"
        RUNNING = "RUNNING", "Running"
        SUCCEEDED = "SUCCEEDED", "Succeeded"
        FAILED = "FAILED", "Failed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    scene = models.ForeignKey(ExcalidrawScene, on_delete=models.CASCADE, related_name="video_jobs")
    prompt = models.TextField()
    image_urls = models.JSONField(default=list, blank=True)
    duration = models.PositiveSmallIntegerField(default=10)
    aspect_ratio = models.CharField(max_length=16, default="16:9")
    model_name = models.CharField(max_length=64, blank=True)
    task_id = models.CharField(max_length=128, blank=True)
    result_url = models.TextField(blank=True)
    thumbnail_url = models.TextField(blank=True)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.QUEUED, db_index=True)
    error = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
