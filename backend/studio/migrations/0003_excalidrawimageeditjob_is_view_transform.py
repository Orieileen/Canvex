from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("studio", "0002_remove_excalidrawvideojob_model_name"),
    ]

    operations = [
        migrations.AddField(
            model_name="excalidrawimageeditjob",
            name="is_view_transform",
            field=models.BooleanField(default=False),
        ),
    ]
