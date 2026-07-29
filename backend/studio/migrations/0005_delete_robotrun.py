# Drop the retired RobotRun model: the server-side robot "Run" path was removed (robots run
# in the user's own browser via the Canvex extension now), so nothing writes RobotRun rows.
# DeleteModel drops the canvas_robot_runs table when applied.

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("studio", "0004_robot_allow_writes"),
    ]

    operations = [
        migrations.DeleteModel(
            name="RobotRun",
        ),
    ]
