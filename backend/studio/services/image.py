"""Image-edit job creation service. Single entry point so the view stays thin.

从上游 apps/canvas/services/image.py port (Canvex 独立版):
- 剥 organization / user(单工作区)→ create 不再 set 这两字段,签名去掉它们,
  save_canvas_source_image 不再传 user。
- billing.reserve 调用保留(stub 空操作),只改 import 路径到 studio.services.billing。
"""
from django.db import transaction

from . import save_canvas_source_image
from .billing import reserve as reserve_canvas_credit
from ..constants import SPLIT_INPAINT_PROMPT
from ..models import ImageEditJob


# apimart 服务端 `size=auto` 自动按 image_urls 源图比例匹配 (支持 1:1 / 4:3 /
# 3:4 / 16:9 / 9:16 / 3:2 / 2:3 / 21:9 / 9:21). 比客户端就近匹配干净:
# 1) 不用读图 / 不引 PIL 依赖 2) 精确匹配不是就近 3) apimart 内部升级新比例
# 自动跟上. 前提是必须传 image_urls (cutout / split 都有源图, 满足).
_AUTO_SIZE = "auto"


def create_image_edit_job(*, scene, image_file=None, image_files=None, validated):
    """Create a QUEUED ImageEditJob + reserve credit. Pass exactly one of image_file / image_files.

    validated is ImageEditJobCreateSerializer.validated_data.

    Reserve 在 Canvex 是 no-op(免费)。保留调用是为契约对齐;reserve 永不抛异常。

    Cutout 路径忽略前端 size, 用 size=auto 让 apimart 按源图比例匹配 (输出贴着
    原图比例, 不强压 1:1); 非 cutout 路径保留前端 size 选择.
    """
    is_cutout = validated["cutout"]
    # Cutout: keep the user/marquee prompt AS-IS (may be empty). Stage 1 prepends
    # CUTOUT_LLM_PROMPT, so a marquee selection's spatial prompt (box region /
    # arrows / text) rides along as extra edit instructions; an empty prompt = a
    # plain cutout. The "Refine…" default only applies to regular edits.
    raw_prompt = validated["prompt"].strip()
    prompt = raw_prompt if is_cutout else (
        raw_prompt or "Refine the image while preserving content and layout."
    )

    source_image = None
    source_images: list[str] = []
    if image_files:
        source_images = [save_canvas_source_image(f) for f in image_files]
    elif image_file is not None:
        source_image = image_file

    if is_cutout and image_file is not None:
        size = _AUTO_SIZE
    else:
        size = validated["size"].strip() or "1024x1024"
    resolution = validated.get("resolution") or ImageEditJob.Resolution.TWO_K

    with transaction.atomic():
        job = ImageEditJob.objects.create(
            scene=scene,
            prompt=prompt,
            size=size,
            resolution=resolution,
            num_images=validated["n"],
            is_cutout=validated["cutout"],
            source_image=source_image,
            source_images=source_images,
            status=ImageEditJob.Status.QUEUED,
            # 工具栏选的模型。异步路径 —— 请求早就返回了, worker 之后才捞这行, 所以
            # 选择必须落在行上而不是留在请求里。None = 没选 → 退到库里第一条。
            image_model=validated.get("image_model"),
        )
        reserve_canvas_credit(job)
    return job


def create_split_jobs(
    *, scene, image_file, region_clause: str = "", resolution: str = "", image_model=None,
):
    """Create atomic split pair: 1 background inpaint job + 1 cutout subject job.

    两条 leg 互填 split_partner 形成 pair, 前端靠它把两腿配对显示。Canvex 无计费:
    billing.reserve 是 no-op, 不做 "全成功扣 1 / 任一失败扣 0" 的原子退款(stub
    自动空操作),split_partner 纯用于结果配对。

    Source image 只 save 一次, 两 leg 共用 (`source_image` FieldFile path 是 storage
    上的相对路径 string, FieldFile 可以多 row 指向同一物理文件).

    `region_clause`: plan B 下框选主体区域的坐标文字(前端 subjectRegionClause)。
    接到两条 leg 的 prompt 当主体定位 —— background leg 直接拼在 SPLIT_INPAINT_PROMPT
    后;cutout leg 放进 prompt(空 prompt 字段),run_cutout_llm_step 会拼到
    CUTOUT_LLM_PROMPT 后。空 region_clause → 两个 prompt 各自落到"最显眼主体"兜底。

    `image_model`: 工具栏选的生图模型, 两条 leg 共用一个 —— 背景 inpaint 和主体抠图
    出自同一张源图, 分别用不同供应商生成会得到风格对不上的一对。None = 默认通道。

    Returns (background_job, cutout_job).

    输出尺寸用 size=auto, apimart 服务端按源图比例匹配 (两 leg 共享一致比例).
    """
    saved_path = save_canvas_source_image(image_file)
    # 画质档位(1K/2K/4K),两腿共用;非法/缺省落 2K。
    tier = (resolution or "").strip().upper()
    if tier not in {r.value for r in ImageEditJob.Resolution}:
        tier = ImageEditJob.Resolution.TWO_K
    bg_prompt = (
        f"{SPLIT_INPAINT_PROMPT}\n\n{region_clause}" if region_clause else SPLIT_INPAINT_PROMPT
    )

    with transaction.atomic():
        # Background leg (primary): SPLIT_INPAINT_PROMPT (+ 框选区域坐标).
        background = ImageEditJob.objects.create(
            scene=scene,
            prompt=bg_prompt,
            size=_AUTO_SIZE,
            resolution=tier,
            num_images=1,
            is_cutout=False,
            source_image=saved_path,
            image_model=image_model,
            status=ImageEditJob.Status.QUEUED,
        )
        # Cutout leg (secondary): prompt = 框选区域坐标(run_cutout_llm_step 拼到
        # CUTOUT_LLM_PROMPT 后); 无框时为空 → 纯抠最显眼主体。split_partner 指 background.
        cutout = ImageEditJob.objects.create(
            scene=scene,
            prompt=region_clause,
            size=_AUTO_SIZE,
            resolution=tier,
            num_images=1,
            is_cutout=True,
            source_image=saved_path,
            image_model=image_model,
            split_partner=background,
            status=ImageEditJob.Status.QUEUED,
        )
        # 双向 FK: background 也要指回 cutout, 这样从任一 leg 都能找到 partner.
        # update() 绕信号 + 避免重写其他字段.
        ImageEditJob.objects.filter(pk=background.pk).update(split_partner=cutout)
        background.split_partner = cutout

        # Reserve 是 no-op(免费),顺序无所谓;保留调用对齐上游契约。
        reserve_canvas_credit(background)
        reserve_canvas_credit(cutout)

    return background, cutout
