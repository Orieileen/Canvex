from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("studio", "0001_initial"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="excalidrawvideojob",
            name="model_name",
        ),
    ]
