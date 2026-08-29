"""空的合并节点 —— 两条分支各自建了 0017, 迁移图因此有了两个叶子。

`0017_custom_channel` (给 ImageProvider 加 request_template + 两种 kind) 和
`0018_import_builtin_skills` (建 Skill 表并导入出厂 SOP) 动的是不同的模型, 彼此没有
依赖, 只是编号撞了。所以这里不需要任何 operation, 只是把两条线接回一条。

刻意不去给其中一条重编号: 那两条**已经在本地库里应用过了**, 改文件名会让
django_migrations 里的记录对不上一个不存在的迁移。
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('studio', '0017_custom_channel'),
        ('studio', '0018_import_builtin_skills'),
    ]

    operations = [
    ]
