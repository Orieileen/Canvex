from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("studio", "0003_excalidrawimageeditjob_is_view_transform"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="excalidrawimageeditjob",
            name="is_view_transform",
        ),
    ]
