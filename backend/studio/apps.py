from django.apps import AppConfig


class StudioConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "studio"
    verbose_name = "Studio"

    def ready(self) -> None:
        # Importing binds the @worker_process_init handler. On the web
        # process this is a harmless no-op — the signal only fires when a
        # celery worker forks a child, and web isn't celery.
        from . import celery_signals  # noqa: F401
        # ORM post_delete: ImageEditJob.source_image storage cleanup
        from . import signals  # noqa: F401
