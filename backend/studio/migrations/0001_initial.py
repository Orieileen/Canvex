# Generated manually for standalone studio app
from django.db import migrations, models
import django.db.models.deletion
import studio.models
import uuid


class Migration(migrations.Migration):
    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="DataFolder",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("name", models.CharField(max_length=255)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "parent",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="children",
                        to="studio.datafolder",
                    ),
                ),
            ],
            options={
                "ordering": ["name"],
                "unique_together": {("parent", "name")},
            },
        ),
        migrations.CreateModel(
            name="ExcalidrawScene",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("title", models.CharField(blank=True, max_length=255)),
                ("data", models.JSONField(blank=True, default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={"ordering": ["-updated_at"]},
        ),
        migrations.CreateModel(
            name="DataAsset",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("file", models.ImageField(upload_to=studio.models.library_upload_to)),
                ("filename", models.CharField(max_length=255)),
                ("mime_type", models.CharField(blank=True, max_length=100)),
                ("size_bytes", models.BigIntegerField(default=0)),
                ("checksum_sha256", models.CharField(blank=True, max_length=64)),
                ("width", models.IntegerField(blank=True, null=True)),
                ("height", models.IntegerField(blank=True, null=True)),
                ("alt_text", models.CharField(blank=True, max_length=255)),
                ("tags", models.JSONField(blank=True, default=list)),
                ("is_public", models.BooleanField(default=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "folder",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="assets",
                        to="studio.datafolder",
                    ),
                ),
            ],
            options={
                "ordering": ["-created_at"],
                "unique_together": {("folder", "filename")},
            },
        ),
        migrations.CreateModel(
            name="ExcalidrawChatMessage",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                (
                    "role",
                    models.CharField(
                        choices=[("user", "User"), ("assistant", "Assistant"), ("system", "System")],
                        max_length=16,
                    ),
                ),
                ("content", models.TextField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "scene",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="chat_messages",
                        to="studio.excalidrawscene",
                    ),
                ),
            ],
            options={"ordering": ["created_at"]},
        ),
        migrations.CreateModel(
            name="ExcalidrawImageEditJob",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("prompt", models.TextField()),
                ("size", models.CharField(default="1024x1024", max_length=32)),
                ("num_images", models.PositiveSmallIntegerField(default=1)),
                ("is_cutout", models.BooleanField(default=False)),
                ("source_image", models.ImageField(upload_to=studio.models.excalidraw_edit_upload_to)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("QUEUED", "Queued"),
                            ("RUNNING", "Running"),
                            ("SUCCEEDED", "Succeeded"),
                            ("FAILED", "Failed"),
                        ],
                        db_index=True,
                        default="QUEUED",
                        max_length=16,
                    ),
                ),
                ("error", models.TextField(blank=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "result_asset",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="excalidraw_image_edit_results",
                        to="studio.dataasset",
                    ),
                ),
                (
                    "scene",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="image_edit_jobs",
                        to="studio.excalidrawscene",
                    ),
                ),
            ],
            options={"ordering": ["-created_at"]},
        ),
        migrations.CreateModel(
            name="ExcalidrawVideoJob",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("prompt", models.TextField()),
                ("image_urls", models.JSONField(blank=True, default=list)),
                ("duration", models.PositiveSmallIntegerField(default=10)),
                ("aspect_ratio", models.CharField(default="16:9", max_length=16)),
                ("model_name", models.CharField(blank=True, max_length=64)),
                ("task_id", models.CharField(blank=True, max_length=128)),
                ("result_url", models.TextField(blank=True)),
                ("thumbnail_url", models.TextField(blank=True)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("QUEUED", "Queued"),
                            ("RUNNING", "Running"),
                            ("SUCCEEDED", "Succeeded"),
                            ("FAILED", "Failed"),
                        ],
                        db_index=True,
                        default="QUEUED",
                        max_length=16,
                    ),
                ),
                ("error", models.TextField(blank=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "scene",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="video_jobs",
                        to="studio.excalidrawscene",
                    ),
                ),
            ],
            options={"ordering": ["-created_at"]},
        ),
        migrations.CreateModel(
            name="ExcalidrawImageEditResult",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("order", models.PositiveSmallIntegerField(default=0)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "asset",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="image_edit_result_assets",
                        to="studio.dataasset",
                    ),
                ),
                (
                    "job",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="results",
                        to="studio.excalidrawimageeditjob",
                    ),
                ),
            ],
            options={"ordering": ["order", "created_at"]},
        ),
    ]
