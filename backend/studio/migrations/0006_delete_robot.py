# Drop the retired Robot model. The RPA feature (authoring browser automations and
# running them in the user's own browser via the Canvex extension) was removed, so
# nothing reads or writes canvas_robots rows any more. DeleteModel drops the table.

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("studio", "0005_delete_robotrun"),
    ]

    operations = [
        migrations.DeleteModel(
            name="Robot",
        ),
    ]
