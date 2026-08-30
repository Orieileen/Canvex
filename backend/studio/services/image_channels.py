"""库里的供应商配置 → ImageChannel。

`image_client.ImageChannel` 是「一次生图调用需要的全部参数」, 而**唯一来源**是用户在
前端配的 ImageProvider / ImageModel 两层记录 —— 本模块负责把它们压成一个通道。
(早先还有一路 env 前缀 `CANVAS_IMAGE_PRIMARY_*`, 连同工具栏的「后端默认」一起去掉了;
老部署的值由迁移 0008 / 0010 一次性导进库。)

下游 (`_single_generation` / `build_image_client`) 只认那个 dataclass, 不关心配置从哪
来。所以这一层是唯一需要理解「两层记录如何合并」的地方。
"""
import dataclasses
import logging
import typing
import uuid as uuid_lib

from studio.models import ImageModel, ImageProvider
from studio.services import template_client
from studio.services.image_client import ImageChannel

logger = logging.getLogger(__name__)

# base_url / api_key / model / label 有各自的来源, 不走 JSON 合并; ImageChannel 上
# 其余的字段就是可调项。从 dataclass 派生而不是手抄一份 —— 手抄的那份会在有人给
# ImageChannel 加旋钮时悄悄落后, 表现是"在界面上配了却不生效", 而且没有任何报错。
#
# **kind / request_template 也在这张排除表里**, 理由跟上面四个一样: 它们由 provider 行
# 直接决定 (见 channel_for_model), 不是用户在 defaults/overrides 里填的东西。漏掉的话
# 派生会把它们当成旋钮, 而且失败得很难看 —— `kind` 是 str, 于是表单里凭空多出一个叫
# "kind" 的输入框; 一旦有人往里填, channel_for_model 就会同时用关键字和 `**known` 传
# 它, 抛 "got multiple values for keyword argument 'kind'", 这条通道的每一次生成全挂。
_NON_TUNABLE_FIELDS = frozenset({
    "base_url", "api_key", "model", "label", "kind", "request_template", "provider_id",
})
_TUNABLE_FIELDS = frozenset(
    f.name for f in dataclasses.fields(ImageChannel)
) - _NON_TUNABLE_FIELDS


def _scalar_type(annotation) -> type | None:
    """这个旋钮接受的标量类型。`bool | None` (watermark) → bool; 认不出 → None。

    同样从 dataclass 派生而不是手抄: 加一个旋钮时表会自己跟上, 校验不会悄悄漏掉它。

    取注解走 `typing.get_type_hints` 而不是 `Field.type`: 后者在 image_client 哪天加上
    `from __future__ import annotations` 之后会变成字符串, 于是这里认不出**任何**类型,
    TUNABLE_TYPES 静默变空 —— 校验全体失效, 而且没有任何报错。get_type_hints 两种写法
    都解析成真实类型。
    """
    args = [a for a in typing.get_args(annotation) if a is not type(None)]
    if args:
        return args[0] if isinstance(args[0], type) else None
    return annotation if isinstance(annotation, type) else None


# 旋钮名 → 它接受的标量类型。serializers._validate_tunables 用它在**保存的那一刻**
# 拦下类型不对的值 —— 否则 poll_enabled="false" (非空字符串, 真值) 会静默打开轮询,
# size_mode=123 会在几分钟后的 worker 里炸 AttributeError。
TUNABLE_TYPES: dict[str, type] = {
    name: t
    for name, annotation in typing.get_type_hints(ImageChannel).items()
    if name in _TUNABLE_FIELDS and (t := _scalar_type(annotation)) is not None
}


# 这几个旋钮 0 跟负数一样是"保存时看不见、生成时才炸"的:
#   timeout / poll_timeout  urllib3 对 <= 0 的超时直接抛 ValueError, 整个 job FAILED,
#                           报错跟这个输入框毫无关系
#   poll_interval           time.sleep(0) = 不间隔, 轮询变成一个尽全力锤供应商的死循环
#   poll_max_attempts       range() 一轮都不转, 静默当成"轮询完了没结果"
# poll_max_interval 不在里面 —— 它的 0 是有定义的 (= 不退避, 固定间隔), 见字段注释。
POSITIVE_TUNABLES = frozenset({
    "timeout", "poll_timeout", "poll_interval", "poll_max_attempts",
})


@dataclasses.dataclass(frozen=True)
class _KindSpec:
    """**关于一种通道类型的全部事实, 一行说完。**

    以前这些事实散在四个模块里各写一遍: 旋钮子集在这里, "base_url 必不必填"在
    serializers, "能不能一键测"在 views (还带一份文案), base_url 长什么样在前端的一个
    三元表达式里。加第五种 kind 要翻四个不相干的文件, 而漏掉任何一处都**不会报错** ——
    只会安静地要一个这种通道根本不用的 base_url, 或者给一条配得完全正确的通道报"测试
    失败"。收在这里之后, 加一种 kind 就是加一行, 且这一行会随 schema 一起下发给前端。
    """

    tunables: frozenset[str]
    # 只在跟 ImageChannel 的字段默认值**不同**时才写。既用于表单的占位符, 也真的在
    # channel_for_model 里垫在 provider.defaults 底下 —— 两处同一份, 不会各说一套。
    defaults: dict[str, object] = dataclasses.field(default_factory=dict)
    # 这种通道要不要 base_url。chat 不要 —— 留空就是 OpenAI 官方端点。
    requires_base_url: bool = True
    # 表单里 base_url 输入框的灰字。angle 只填域名 (模型名会被拼成路径), 其余带 /v1。
    base_url_example: str = "https://api.example.com/v1"
    # 有没有探针 (见 views.ImageProviderTestView._probe)。**默认 False**: 加第五种 kind
    # 时默认"测不了", 而不是默认拿生图那条去打它然后给一个假的 404。
    testable: bool = False
    # testable=False 时告诉用户该怎么验。空 = 用通用兜底文案。
    untestable_reason: str = ""

    # 工具栏上的哪个选择器列这种通道。`image` / `angle` / `video`, 空 = 不进任何选择器
    # (chat 是全局一条, 没有工具栏入口)。
    #
    # 存在的理由跟这个类里其它字段一样: 前端原来是按 kind **名字**筛的
    # (`m.kind === "image"`), 于是新增 custom_image 之后它配好了却不出现在选择器里 ——
    # 而且不报错。判定收在这里, 随 schema 下发, 前端只认 picker 不认 kind。
    picker: str = ""

    # ── 模板类通道 ────────────────────────────────────────────────────────
    # True = 这种通道由**用户填的请求模板**驱动, 不是上面那些旋钮。表单因此完全不同
    # (一个 JSON 编辑器 + 变量说明, 而不是十四个输入框), 所以前端要靠这个标志分流。
    template: bool = False
    # 这种通道能用哪些占位符。**存盘时校验**, 写错的变量当场报错而不是等到生成时 ——
    # 后者的报错落在 celery 日志里, 用户只看得见"生成失败"。
    #
    # 这张表也是"全部由用户填"这句话的边界: 请求的形状随便你写, 但我们必须知道哪个键
    # 放提示词、哪个放源图, 否则没法把画布上的东西喂进去。
    variables: frozenset[str] = frozenset()
    # 内置的起点模板。**不是为了限制, 是因为预设本身就是知识** —— 全空的话每接一家都得
    # 先读一遍 API 文档手写 JSON, 而常见情况本来填个 url/key/model 就能跑。选一个再改。
    starters: tuple[tuple[str, dict], ...] = ()


# 每种 kind 真正会读的旋钮。
#
# angle 只读 timeout: 它的"参数"是相机坐标 (画布上那个立方体在控), 请求体由 submit_angle
# 自己拼, 剩下的一个都不看。这条规则以前只写在前端 (一个 ANGLE_TUNABLE_KEYS 集合), 于是
# 后端照样接收、校验、入库、合并那 12 项 —— 用户在 angle 通道上配了 poll_enabled, 存得
# 下去、静默不生效; 反过来 angle 哪天要加旋钮, 后端改完在界面上也不会出现。现在判定只此
# 一处, 并且随 schema 一起下发给前端。
#
# video 是"提交 → 拿 task_id → 长轮询", 所以它读连接超时 + 整套轮询, 但不读任何生图的
# 请求形状旋钮 (image_field / response_format / watermark … 它的请求体是 video.py 自己拼的)。
# 它的默认值跟生图差很远: 生图 60 次 × 5 秒 = 5 分钟内敲 60 下, 而视频要跑 1-5 分钟 ——
# 所以 9 次 × 20 秒起步、退避到 180 秒, 这几个数就是原来 CANVAS_VIDEO_* 的默认值。
# 模板通道能用哪些占位符 —— **从变量 builder 的实际返回值派生**, 不在这里手抄一份。
# 抄的那份漏一个名字, 表现是"模板里写了、存盘通过、渲染成空、那个键整个消失", 没有报错。
# 见 template_client 里那两个常量上面的注释。
_IMAGE_VARS = template_client.IMAGE_VARS
_VIDEO_VARS = template_client.VIDEO_VARS

# OpenAI **官方** 的 /v1/images/generations —— 按官方规范写, 不是聚合商的方言。
#
# 单独列一条而不是跟下面那几个"OpenAI 兼容"混在一起, 是因为**这两件事真的不一样**:
# 「兼容」在这个圈子里通常只保证端点路径和认证头一样, 再往里各写各的。实测过的两家:
#   - apimart 在同一个端点上是**异步**的 (回 task_id 要轮询), 尺寸只收比例 `16:9`
#     不收官方的 `1024x1024`, response_format 只认 `url`
#   - 兔子在 generations 上加了个官方没有的 `image` 字段收源图
# 所以拿"兼容"的模板去接官方、或者反过来, 都会出问题。
#
# 刻意写得最小 —— 少一个字段就少一处会填错的地方:
#   - **没有源图字段**: 官方的 generations 是纯文生图, 图生图在 /images/edits, 而那个
#     是 multipart, 模板通道目前只发 JSON, 接不了。
#   - **没有 response_format**: gpt-image-1 不接受这个参数 (它固定回 b64_json), 而
#     dall-e-2/3 才支持。留空让各自按需加, 比预设一个会在最新模型上报错的值安全。
#   - `size` 用像素 (`1024x1024`), 那是官方的格式。
_STARTER_OPENAI_OFFICIAL = {
    "method": "POST",
    "url": "{{base_url}}/images/generations",
    "headers": {"Authorization": "Bearer {{api_key}}", "Content-Type": "application/json"},
    "body": {
        "model": "{{model}}", "prompt": "{{prompt}}", "n": "{{n}}", "size": "{{size}}",
    },
    # data[0] 里是 `url` 还是 `b64_json` 由模型决定, 不用填 —— 取到这一项之后我们自己嗅探。
    "result_path": "data[0]",
}

# OpenAI 兼容的同步生图 —— 兔子、大多数聚合商都是这个形状。
_STARTER_OPENAI_IMAGE = {
    "method": "POST",
    "url": "{{base_url}}/images/generations",
    "headers": {"Authorization": "Bearer {{api_key}}", "Content-Type": "application/json"},
    "body": {
        "model": "{{model}}", "prompt": "{{prompt}}", "size": "{{size}}", "n": "{{n}}",
        "image": "{{image}}", "response_format": "url",
    },
    "result_path": "data[0]",
}
# 同一个端点, 但源图是数组、尺寸要比例 —— apimart 这类。
# 起点模板是**原样显示在编辑器里给人看**的, 所以这条写全, 不用 dict-spread 去改上面那条
# —— 那样会在用户第一眼看到的 JSON 里留下一个 `"image": null` 的取消标记。
_STARTER_OPENAI_IMAGE_MULTI = {
    "method": "POST",
    "url": "{{base_url}}/images/generations",
    "headers": {"Authorization": "Bearer {{api_key}}", "Content-Type": "application/json"},
    "body": {
        "model": "{{model}}", "prompt": "{{prompt}}", "size": "{{aspect_ratio}}",
        "n": "{{n}}", "image_urls": "{{images}}", "response_format": "url",
    },
    "result_path": "data[0]",
}
# fal.run: 模型名在 URL 路径里, 认证是 `Key` 不是 `Bearer`。
_STARTER_FAL = {
    "method": "POST",
    "url": "{{base_url}}/{{model}}",
    "headers": {"Authorization": "Key {{api_key}}", "Content-Type": "application/json"},
    "body": {"prompt": "{{prompt}}", "image_urls": ["{{image}}"], "num_images": "{{n}}"},
    "result_path": "images[0]",
}
# 提交 → 拿 task_id → 轮询。**照 apimart 实测的形状写的**:
#   提交回 {"data":[{"status":"submitted","task_id":"..."}]}
#   轮询回 {"data":{"status":"completed","result":{"images":[{"url":["https://..."]}]}}}
# 注意 `url` 是个**数组**, 所以路径要一路点到 `url[0]` —— 取出来是裸字符串, item_to_bytes
# 认这种。
_STARTER_ASYNC_IMAGE = {
    "method": "POST",
    "url": "{{base_url}}/images/generations",
    "headers": {"Authorization": "Bearer {{api_key}}", "Content-Type": "application/json"},
    "body": {
        "model": "{{model}}", "prompt": "{{prompt}}", "size": "{{aspect_ratio}}",
        "n": "{{n}}", "image_urls": "{{images}}", "response_format": "url",
    },
    "task_id_path": "data[0].task_id",
    "poll": {
        "method": "GET",
        "url": "{{base_url}}/tasks/{{task_id}}",
        "headers": {"Authorization": "Bearer {{api_key}}"},
        "status_path": "data.status",
        "done": ["completed", "succeeded", "success", "done"],
        "failed": ["failed", "error", "cancelled"],
        "result_path": "data.result.images[0].url[0]",
    },
}

# Google Gemini 的**原生**生图 —— `models/<模型>:generateContent`, 不是 OpenAI 那套。
#
# 三处跟别家都不一样, 每一处都是硬编码的适配器接不了的:
#   - 认证在 `x-goog-api-key` 头里, 不是 `Authorization: Bearer`
#   - 模型名拼在 URL 里, 而且后面还跟一个 `:generateContent`
#   - 提示词埋在 `contents[].parts[].text` 两层数组下面
#
# **`result_path` 故意留空。** Gemini 常常先回一段文字再回图, 于是图在 `parts[0]` 还是
# `parts[1]` 取决于这一次它想不想说话 —— 写死任一个都会间歇性失败。留空 = 跑的时候按值
# 的形状自动认 (见 template_client._result)。
_STARTER_GEMINI_IMAGE = {
    "method": "POST",
    "url": "{{base_url}}/models/{{model}}:generateContent",
    "headers": {"x-goog-api-key": "{{api_key}}", "Content-Type": "application/json"},
    "body": {"contents": [{"parts": [{"text": "{{prompt}}"}]}]},
    "result_path": "",
}

# 提交 → 拿 task_id → 轮询。视频基本都是这个形状。
_STARTER_ASYNC_VIDEO = {
    "method": "POST",
    "url": "{{base_url}}/videos/generations",
    "headers": {"Authorization": "Bearer {{api_key}}", "Content-Type": "application/json"},
    "body": {
        "model": "{{model}}", "prompt": "{{prompt}}",
        "duration": "{{duration}}", "aspect_ratio": "{{aspect_ratio}}",
        "image_urls": "{{images}}",
    },
    "task_id_path": "data.task_id",
    "poll": {
        "method": "GET",
        "url": "{{base_url}}/tasks/{{task_id}}",
        "headers": {"Authorization": "Bearer {{api_key}}"},
        "status_path": "data.status",
        "done": ["succeeded", "success", "completed", "done"],
        "failed": ["failed", "error", "cancelled"],
        "result_path": "data.result.videos[0]",
    },
}


# 模板通道的旋钮: 请求形状全在模板里, 剩下的只有"跑多久 / 怎么轮询"。生图和视频两种
# 模板通道读的是同一组 —— 它们的差别在变量表和结果怎么用, 不在这里。
_TEMPLATE_TUNABLES = frozenset({
    "timeout", "poll_interval", "poll_max_attempts", "poll_max_interval", "poll_timeout",
    # 模板通道的请求形状全在模板里, 唯独这一项例外 —— 它不是"怎么发", 而是**这个模型收
    # 哪几种比例**, 一条关于供应商的事实, 模板里表达不了 (模板只会把 {{aspect_ratio}}
    # 原样填进去)。填了之后工具栏的比例选择器只列这些, 后端再兜底映射到最近的一个。
    "allowed_ratios",
})


KIND_SPECS: dict[str, _KindSpec] = {
    ImageProvider.Kind.IMAGE: _KindSpec(tunables=_TUNABLE_FIELDS, testable=True, picker="image"),
    ImageProvider.Kind.ANGLE: _KindSpec(
        tunables=frozenset({"timeout"}),
        base_url_example="https://fal.run",
        testable=True,
        picker="angle",
    ),
    # 聊天只用得上连接三件套 + 超时。温度之类的旋钮没加: ImageChannel 现在只认
    # str/int/bool, 加 float 要连带扩控件映射, 而且 agent 的行为主要由 system prompt
    # 和工具定义决定, 温度不是这次搬家的必需品。
    ImageProvider.Kind.CHAT: _KindSpec(
        tunables=frozenset({"timeout", "protocol"}),
        defaults={"timeout": 120},
        # 留空 = 用 OpenAI 官方端点, 所以这是唯一一种 base_url 可空的通道。
        requires_base_url=False,
        untestable_reason=(
            "聊天通道不支持一键测试 —— 要验的是「支不支持 tools 参数」, 跟发一张图不是一回事。"
            "直接在聊天框里说一句「生成一张图」即可: 画布上真的出图 = 通了。"
        ),
    ),
    # ── 模板类 ────────────────────────────────────────────────────────────
    # 请求形状全在模板里, 所以旋钮只剩两类: 超时, 和轮询的节奏。
    #
    # **轮询那几个必须留着**, 哪怕"要不要轮询"是写在模板的 `poll` 段里而不是旋钮上:
    # 起点模板里就有一条异步的 (「OpenAI 兼容 · 异步」), 而 template_client._poll 读的
    # 正是 channel.poll_interval / poll_max_attempts / poll_timeout。不放出来的话它们
    # 会被 serializer 当成"这种通道用不上的旋钮"裁掉, 用户拿到的是一句"轮询了 60 次还
    # 没完成, 把 poll_max_attempts 调大" —— 而那个输入框在界面上根本不存在。
    ImageProvider.Kind.CUSTOM_IMAGE: _KindSpec(
        tunables=_TEMPLATE_TUNABLES,
        template=True,
        variables=_IMAGE_VARS,
        picker="image",
        starters=(
            ("OpenAI 官方 (api.openai.com)", _STARTER_OPENAI_OFFICIAL),
            ("OpenAI 兼容 · 单张源图", _STARTER_OPENAI_IMAGE),
            ("OpenAI 兼容 · 多张源图", _STARTER_OPENAI_IMAGE_MULTI),
            ("OpenAI 兼容 · 异步 (提交 + 轮询)", _STARTER_ASYNC_IMAGE),
            ("fal.run (模型在 URL、Key 认证)", _STARTER_FAL),
            ("Google Gemini 官方 (generateContent)", _STARTER_GEMINI_IMAGE),
        ),
        testable=True,
    ),
    ImageProvider.Kind.CUSTOM_VIDEO: _KindSpec(
        tunables=_TEMPLATE_TUNABLES,
        # 跟内置 video 通道**同一组数**, 包括 poll_max_interval —— 少了它这四个数的含义
        # 就变了: 固定 20 秒 × 9 次 = 160 秒, 而视频要跑 1-5 分钟, 一条配得完全正确的通道
        # 会稳定报"轮询了 9 次还没完成"。退避到 180 秒之后总墙钟才跟内置那条对得上。
        defaults={
            "timeout": 60, "poll_interval": 20,
            "poll_max_attempts": 9, "poll_max_interval": 180,
        },
        template=True,
        variables=_VIDEO_VARS,
        picker="video",
        starters=(("提交 → 轮询 (通用视频)", _STARTER_ASYNC_VIDEO),),
        # 视频要跑几分钟, 一次同步 HTTP 里测不完 —— 跟内置 video 通道同一个理由。
        untestable_reason="视频通道没法一键测: 出片要几分钟, 撑不过一次同步请求。配好之后在画布上真发一条最快。",
    ),
    ImageProvider.Kind.VIDEO: _KindSpec(
        tunables=frozenset({
            "timeout", "poll_url", "poll_max_attempts",
            "poll_interval", "poll_max_interval", "poll_timeout",
            # 视频模型的可用比例往往比生图还窄 —— 常见只有 16:9 / 9:16 / 1:1。
            "allowed_ratios",
        }),
        picker="video",
        defaults={
            "timeout": 60,
            "poll_max_attempts": 9,
            "poll_interval": 20,
            "poll_max_interval": 180,
        },
        untestable_reason=(
            "视频通道不支持一键测试 —— 一次生成要几分钟, 撑不过一个同步请求。"
            "直接在「视频」里生成一次即可, 失败信息会原样显示在画布上。"
        ),
    ),
}

# 标量类型 → 前端控件。派生而不是让前端自己猜: 前端只认得 JSON 的 string/number/boolean,
# 而 "这个字段是 int 还是 str" 是 ImageChannel 说了算。
_CONTROLS: dict[type, str] = {str: "text", int: "number", bool: "bool"}


# 旋钮分组。生图通道有十四个旋钮, 平铺出来是一堵墙 —— 而它们其实回答三个完全不同的问题:
# "这家要什么格式的请求"、"等多久放弃"、"这家是不是异步的"。第三组尤其值得单独关起来:
# 六个里有五个在同步通道上永远用不到, 而同步是大多数。
#
# **一张有序表, 而不是在十四个字段各标一个 group**: 组和组之间的顺序本身是要表达的东西
# (先形状后时间), 分散到 metadata 里就没有顺序可言, 也一眼看不出有没有漏掉谁。
#
# 组内顺序仍然是 dataclass 的声明顺序 —— 这张表只管"哪几个是一伙的"。(现在两者恰好一致,
# 所以这次改动不动任何一项在界面上的位置。)
_TUNABLE_GROUPS: tuple[tuple[str, frozenset[str]], ...] = (
    ("shape", frozenset({
        "image_field", "image_as_single", "response_format", "quality",
        "watermark", "inline_image", "size_mode", "allowed_ratios", "protocol",
    })),
    ("timing", frozenset({"timeout"})),
    ("poll", frozenset({
        "poll_enabled", "poll_url", "poll_max_attempts", "poll_interval",
        "poll_max_interval", "poll_timeout",
    })),
)
# 没被上面任何一组认领的旋钮落这儿。**不是丢掉** —— 加了新旋钮却忘了归组时, 它照样出现
# 在界面上(在"其它"里), 而不是静默消失, 那正是本模块顶上那条注释在防的事。
_FALLBACK_GROUP = "other"


def _group_of(name: str) -> str:
    for group, names in _TUNABLE_GROUPS:
        if name in names:
            return group
    return _FALLBACK_GROUP


# 组的先后 = 上面那张表的顺序, 兜底组永远排最后。前端按行里的 group 首次出现的次序分段,
# 所以顺序由这里的排序决定, 前端不再自己排一份。
_GROUP_ORDER = {g: i for i, (g, _) in enumerate(_TUNABLE_GROUPS)}
_GROUP_ORDER[_FALLBACK_GROUP] = len(_TUNABLE_GROUPS)


# 没有 `.get(kind, 兜底)`: Kind 就定义在 models.py 里紧挨着这张表, 四个成员全在这儿有行。
# 加第五种 kind 却忘了加行时, 这里 KeyError 当场炸在"缺 spec"那一点上, 比悄悄把整套生图
# 旋钮发给一个用不上它们的通道好得多。
UNTESTABLE_FALLBACK = "这种通道还没有测试探针 —— 直接在对应的面板里跑一次即可。"


# ─────────────────────────── 一键预设 ───────────────────────────
#
# **不是"内置供应商"** —— 加一条预设不会让代码认识这家的任何特殊之处, 它只是把
# "base_url + 模型名 + 请求形状"这三样预先填好, 用户只剩一把 key 要填。存进库之后就是
# 一条**普通通道**, 跟手配出来的一模一样, 随便改随便删。
#
# 为什么值得有: 新用户面对的第一个问题不是"我想怎么配", 而是"我怎么开始"。而这两条是
# 这个项目里**唯二被真实跑通过**的组合 —— 有它们, 从零到画布上出图只差一把 key。
#
# 加一条新预设 = 在下面的元组里加一行。**不要**为此在别处写任何分支。


@dataclasses.dataclass(frozen=True)
class _Preset:
    """一条能直接下发给前端的通道草稿。"""

    # 稳定标识。前端拿它查翻译 (名字 / 一句说明 / 去哪儿拿 key), 所以改名字不用动这里。
    key: str
    kind: str
    base_url: str
    model: str
    # 只写跟 kind 默认值不同的那几项 —— 跟 _KindSpec.defaults 同一个规矩。
    defaults: dict[str, object] = dataclasses.field(default_factory=dict)
    request_template: dict = dataclasses.field(default_factory=dict)


PRESETS: tuple[_Preset, ...] = (
    # 聊天(= agent)。tu-zi 的 gpt-5 是这个项目一直在用的那条。
    _Preset(
        key="tuzi_chat",
        kind=ImageProvider.Kind.CHAT,
        base_url="https://api.tu-zi.com/v1",
        model="gpt-5",
    ),
    # 生图。**走模板通道而不是内置那条**: apimart 是异步的、尺寸只吃比例、结果藏在
    # `data.result.images[0].url[0]`, 用内置那十四个旋钮拼不出来 —— 这个项目最早那条
    # 「主通道」就是这么坏掉的。模板这条是真跑通过的形状。
    _Preset(
        key="apimart_image",
        kind=ImageProvider.Kind.CUSTOM_IMAGE,
        base_url="https://api.apimart.ai/v1",
        model="gpt-image-2",
        request_template=_STARTER_ASYNC_IMAGE,
    ),
    # 官方直连的两家 agent 供应商, 作为 tu-zi 之外的选择。
    #
    # **base_url 显式写出来而不是留空。** chat 通道留空确实等于走 OpenAI 官方端点
    # (见 builder 的 `base_url or None`), 但那样卡片上是个空输入框 —— 用户看不出这条通道
    # 到底连的是谁, 也就不知道该去哪儿拿 key。
    _Preset(
        key="openai_chat",
        kind=ImageProvider.Kind.CHAT,
        base_url="https://api.openai.com/v1",
        model="gpt-5",
    ),
    # Google 走的是它的 **OpenAI 兼容层** (`/v1beta/openai`), 不是原生的 generateContent
    # —— agent 那条路是 langchain 的 ChatOpenAI, 只会说 OpenAI 协议。路径写到 `openai`
    # 为止, `/chat/completions` 由 SDK 自己拼。
    _Preset(
        key="google_chat",
        kind=ImageProvider.Kind.CHAT,
        base_url="https://generativelanguage.googleapis.com/v1beta/openai",
        model="gemini-3-pro",
    ),
    # 国内两家按量付费的 agent 供应商, 都提供 OpenAI 兼容端点。加进来的理由只有一个:
    # **便宜**。形状上跟 OpenAI 那条没有任何区别, 所以这里只是两行表。
    #
    # 注意跟"coding plan"那类**订阅**不是一回事: 那些卖的通常是 Anthropic 协议的端点
    # (给 Claude Code 用的), 要走 chat 通道的 `protocol` 开关。见 ImageChannel.protocol。
    _Preset(
        key="deepseek_chat",
        kind=ImageProvider.Kind.CHAT,
        base_url="https://api.deepseek.com/v1",
        model="deepseek-chat",
    ),
    _Preset(
        key="zhipu_chat",
        kind=ImageProvider.Kind.CHAT,
        base_url="https://open.bigmodel.cn/api/paas/v4",
        model="glm-4.6",
    ),
    # OpenAI 官方生图。**allowed_ratios 带右边那一半是必需的** —— gpt-image-1 只认
    # `1024x1024` / `1536x1024` / `1024x1536` / `auto` 这四个具体值, 而 3:2 按长边 1024
    # 算出来是 `1024x672`, 发过去就是 400。这正是 `比例=要发的值` 那个写法存在的理由。
    _Preset(
        key="openai_image",
        kind=ImageProvider.Kind.CUSTOM_IMAGE,
        base_url="https://api.openai.com/v1",
        model="gpt-image-1",
        defaults={"allowed_ratios": "1:1=1024x1024, 3:2=1536x1024, 2:3=1024x1536, auto=auto"},
        request_template=_STARTER_OPENAI_OFFICIAL,
    ),
    # Google 官方生图。**这条走原生 generateContent, 不是 OpenAI 兼容层** —— 兼容层那边
    # 的 `/images/generations` 是给 Imagen 的, 而 Gemini 系的图是 generateContent 出的。
    # 形状上的三处特殊见 _STARTER_GEMINI_IMAGE。
    _Preset(
        key="google_image",
        kind=ImageProvider.Kind.CUSTOM_IMAGE,
        base_url="https://generativelanguage.googleapis.com/v1beta",
        model="gemini-3-pro-image-preview",
        request_template=_STARTER_GEMINI_IMAGE,
    ),
    # 换视角。**base_url 是 fal.run 而不是 fal.ai** —— 公司叫 fal.ai, 接口在 fal.run,
    # 这是所有人第一次配它都会填错的一处 (填 fal.ai 得到一个 404)。预设的价值正在这儿。
    #
    # 模型名带 `fal-ai/` 前缀是刻意的: fal 把模型名拼进 URL 路径 (见 angle 通道的
    # base_url_example —— 它只填域名), 所以这一整串就是路径的后半截。
    _Preset(
        key="fal_angle",
        kind=ImageProvider.Kind.ANGLE,
        base_url="https://fal.run",
        model="fal-ai/qwen-image-edit-2511-multiple-angles",
        # 换视角比一次普通生图慢, 180 秒是实测跑下来够用的数。
        defaults={"timeout": 180},
    ),
)


def presets_payload() -> list[dict]:
    """预设表 → 前端能直接变成一张草稿卡片的形状。

    跟 `tunable_schema()` 一样**只下发结构, 不下发文案**: 名字和说明是翻译, 前端按
    `key` 查, 查不到就退回显示 key —— 漏一条翻译只是标签难看, 而不是按钮消失。

    额外算一个 `role` = 界面上按什么分组。**由后端算而不是前端按 kind 名字判**, 跟
    `picker` 同一个理由: 一个角色可能对应多种 kind (生图 = 内置 image + 模板
    custom_image), 前端按名字分组的话, 哪天加一条内置 image 的预设就会自己单开一组。
    chat 没有工具栏选择器 (picker 为空), 用它自己的 kind 当组名。
    """
    return [
        {**dataclasses.asdict(preset), "role": KIND_SPECS[preset.kind].picker or preset.kind}
        for preset in PRESETS
    ]


def tunable_schema() -> dict[str, dict]:
    """前端配置表单的**全部按 kind 分的规则** —— 从 KIND_SPECS + ImageChannel 派生。

    存在的理由: 这张表以前在前端手抄了一份 (13 项, 含控件类型和占位符), i18n 又各一份。
    本模块顶上那条注释警告的正是"手抄的那份会悄悄落后, 表现是在界面上配了却不生效, 而且
    没有任何报错" —— 而那份手抄就是它自己。现在前端照着渲染, 加一个旋钮只需在 ImageChannel
    上加一行 (再补两条翻译)。

    **按 kind 分组下发而不是给每项标一串 kinds**: 占位符是随 kind 变的 (video 的
    poll_interval 默认 20 秒, 生图是 5 秒), 一项一份占位符表达不了; 而且前端拿到就能直接
    渲染, 不用自己再过滤一遍。

    除了旋钮表, 还带上 requires_base_url / testable / base_url_example —— 这三条以前是前端
    自己写死的 (`kind !== "chat"`、`kind === "image" || kind === "angle"`、一个三元占位符),
    也就是把后端规则手抄了一份。抄的那份还会**抢先**生效: 某个 kind 的 base_url 改成可选
    之后, 前端的 toast 会在请求发出去之前就拦下来, 后端改了等于没改。

    kind 列表本身也由这个 payload 的键决定, 前端不再硬编码那几个 <option>。

    只下发**结构**, 不下发文案: label / hint 是翻译, 留在前端按 key 查, 查不到就退回显示
    key 本身 —— 漏一条翻译只是标签难看, 而不是整个控件消失。
    """
    fields_by_name = {f.name: f for f in dataclasses.fields(ImageChannel)}
    annotations = typing.get_type_hints(ImageChannel)
    out: dict[str, dict] = {}
    for kind, spec in KIND_SPECS.items():
        rows = []
        # 顺序 = dataclass 里的声明顺序 = 表单里的顺序。
        for name, f in fields_by_name.items():
            control = _CONTROLS.get(TUNABLE_TYPES.get(name))
            if control is None or name not in spec.tunables:
                continue
            # 占位符 = 这种 kind 下"不填会得到什么": 优先 kind 自己的默认值, 其次字段默认值。
            # size_mode 这种默认值本身是空、但有个典型取值的, 用 metadata["example"] 覆盖。
            placeholder = spec.defaults.get(
                name, f.metadata.get("example", dataclasses.MISSING),
            )
            if placeholder is dataclasses.MISSING:
                placeholder = f.default
            rows.append({
                "key": name,
                "control": control,
                # 归哪一组。前端据此分段 + 决定"异步轮询"那组默认折不折叠 ——
                # 判定只此一处, 前端不再按字段名前缀猜 (`poll_` 开头的都算轮询那种猜法
                # 会在有人加一个叫 `poll_something_else` 的非轮询字段时静默出错)。
                "group": _group_of(name),
                # False / "" / None / 0 都不值得显示成占位符 —— 空占位符比 "false" 干净。
                "placeholder": "" if placeholder in (None, "", False, 0) else str(placeholder),
                # `bool | None` 的"不填"= 不下发该字段(由供应商自己决定), 其余 = 用我们的
                # 默认。这个区分以前是前端在 watermark 上硬写的一个 emptyKey。
                "empty_label": (
                    "dont_send" if type(None) in typing.get_args(annotations[name]) else "unset"
                ),
            })
        # 按组排序, 组内保持 dataclass 的声明顺序 (sorted 是稳定的)。
        rows.sort(key=lambda r: _GROUP_ORDER[r["group"]])
        out[str(kind)] = {
            "tunables": rows,
            "requires_base_url": spec.requires_base_url,
            "base_url_example": spec.base_url_example,
            "testable": spec.testable,
            # 模板类通道的三件事。前端据此改渲染另一套表单 (一个 JSON 编辑器 + 变量
            # 说明), 而不是那十四个输入框。跟上面几项同一个理由: 判定只此一处, 前端
            # 不再自己按 kind 名字硬编码。
            "template": spec.template,
            "variables": sorted(spec.variables),
            "starters": [{"label": lbl, "template": tpl} for lbl, tpl in spec.starters],
        }
    return out


def channel_for_model(model: ImageModel) -> ImageChannel:
    """把一条 ImageModel (含其 provider) 压成一个可直接调用的通道。

    合并规则: kind 的默认值垫底 → provider.defaults → model.overrides。未知键**丢弃而不是
    报错** —— 配置是用户手填的 JSON, 一个拼错的键不该让整次生成失败; 记一条 warning 就够,
    行为等同于"没配这项"(用 ImageChannel 的字段默认值)。

    最底下那层 kind 默认值是给 video 这种"数量级不同"的通道用的: 它不填轮询参数时该拿到
    9 次 × 20 秒退避到 180 秒, 而不是生图那套 60 次 × 5 秒。表单里的占位符显示的就是这一层
    (同一份 KIND_SPECS.defaults), 所以"界面上看到的灰字"和"真的会用的值"必然一致。
    """
    provider = model.provider
    merged = {
        **KIND_SPECS[provider.kind].defaults,
        **(provider.defaults or {}),
        **(model.overrides or {}),
    }

    unknown = set(merged) - _TUNABLE_FIELDS
    if unknown:
        logger.warning(
            "image channel %s: 忽略无法识别的配置项 %s",
            model.label, ", ".join(sorted(unknown)),
        )
    known = {k: v for k, v in merged.items() if k in _TUNABLE_FIELDS}

    return ImageChannel(
        base_url=provider.base_url,
        api_key=provider.api_key,
        model=model.model,
        kind=provider.kind,
        request_template=provider.request_template or {},
        # 这条通道是库里哪一行 —— channel_health 靠它把调用结果记回去。这里是**唯一**
        # 的填充点: 通道只从这个函数产出, 所以每一条生成路径自动都带上了它。
        provider_id=str(provider.id),
        label=f"{provider.label} · {model.label}",
        **known,
    )


def _parse_model_id(raw) -> uuid_lib.UUID | None:
    """随请求/随任务行传进来的东西 → 一个 UUID, 认不出就 None。

    UUID 先行解析是必需的而不是防御性的: 不合法的字符串直接进 `.filter(id=...)` 会抛
    django 的 ValidationError, 那就把"选择已失效"变成了一个 500。前端本地新建的临时 id
    ("new-1786…") 正是这种输入。
    """
    if not raw:
        return None
    try:
        return raw if isinstance(raw, uuid_lib.UUID) else uuid_lib.UUID(str(raw))
    except (AttributeError, TypeError, ValueError):
        logger.warning("image channel: 模型 id %r 格式非法, 回退默认通道", raw)
        return None


# 「哪个模型算可用」的唯一判定 —— 存在、启用、且是这种 kind。_enabled_model 和
# resolve_model_id 都从这里出发, 所以两者不会对"可用"有不同看法。
def _usable(parsed, kinds: list[str]):
    return ImageModel.objects.filter(id=parsed, enabled=True, provider__kind__in=kinds)


def _enabled_model(raw, kinds: list[str]) -> ImageModel | None:
    """随请求/随任务行传进来的模型 id → 一条**存在且启用**的记录, 否则 None。

    「哪个模型算可用」的唯一判定处。刻意不抛: 用户随时可能删掉或停用一个配置, 而这个
    id 可能来自前端 localStorage 里的粘性选择, 也可能来自一条早就排好队的任务行。这两种
    情况下"退回默认通道生成"都比"整件事 500"合理。

    `kinds` 不是可选的过滤条件而是正确性的一部分: 几种接口形状同住一张表, 不筛的话一个
    angle 通道 (模型名在 URL 路径里、认证是 `Key`) 会被交给生图路径当普通模型用, 请求
    发出去必然失败, 而且失败得莫名其妙。传的是**一组** kind 而不是一个, 因为一个工具栏
    选择器现在对应多种 kind (生图 = 内置 image + 模板 custom_image), 见 kinds_for_kind。

    UUID 先行解析是必需的而不是防御性的: 不合法的字符串直接进 `.filter(id=...)` 会抛
    django 的 ValidationError, 那就把"选择已失效"变成了一个 500。
    """
    parsed = _parse_model_id(raw)
    if parsed is None:
        return None
    # select_related: 调用方一定会 deref model.provider (channel_for_model 要它的
    # base_url / api_key), 不预取就是每条多一次查询。
    model = _usable(parsed, kinds).select_related("provider").first()
    if model is None:
        logger.warning(
            "image channel: 模型配置 %s 不存在/已禁用/不属于 %s, 回退默认通道",
            parsed, "/".join(kinds),
        )
    return model


def resolve_model_id(raw, kind: str = ImageProvider.Kind.IMAGE) -> uuid_lib.UUID | None:
    """写进 job 行的 `image_model_id` 之前的那一道 —— 必须在**写库前**过。

    前端的选择是粘的 (存 localStorage), 所以一个被删掉的模型 id 会一直跟着每一次请求
    发过来。直接塞进 FK 列的话: 合法 UUID 撞外键约束 → IntegrityError, 不合法字符串 →
    ValidationError, 两种都是把"选择已失效"变成整轮聊天 500。

    走 values_list 而不是 `_enabled_model(...).id`: 那个会 JOIN 出整行 provider (含
    api_key / defaults JSON) 再实例化两个 model 对象, 而这里要的只是"这个 id 还能用吗"。
    每次 generate_image / generate_video 工具调用、每次 image-edit / split / angle /
    video 入队都会走这一趟。
    """
    parsed = _parse_model_id(raw)
    if parsed is None:
        return None
    kinds = kinds_for_kind(kind)
    model_id = _usable(parsed, kinds).values_list("id", flat=True).first()
    if model_id is None:
        logger.warning(
            "image channel: 模型配置 %s 不存在/已禁用/不属于 %s, 退到库里第一条",
            parsed, "/".join(kinds),
        )
    return model_id


def no_channel_error(noun: str, extra: str = "") -> RuntimeError:
    """「这种通道一条都没配」那句话 —— 四条生成路径共用一份措辞。

    四处原本各写各的, 已经漂成两种写法 ("在左侧栏点「配置供应商」加一个" vs "在侧栏
    「配置供应商」里加一个")。这些字符串会变成 job.error, 再原样变成画布上那行红字 ——
    侧栏那个按钮哪天改名或挪窝, 应该改一个格式串, 而不是 grep 四句手写中文。
    """
    tail = f" {extra}" if extra else ""
    # 侧栏那个按钮的名字出现在这里 —— 它改名时改这一处即可, 这正是把四份手写中文收成
    # 一个格式串的理由 (刚把按钮从「配置供应商」改成「通道配置」, 就验证了一次)。
    return RuntimeError(f"还没有配置「{noun}」通道 —— 在侧栏「通道配置」里加一条再试。{tail}")


def require_channel(raw, kind: str, *, noun: str, extra: str = "") -> ImageChannel:
    """channel_or_default 的"必须有"版本: 没有就抛上面那句能照做的话。"""
    channel = channel_or_default(raw, kind)
    if channel is None:
        raise no_channel_error(noun, extra)
    return channel


def kinds_for_kind(kind: str) -> list[str]:
    """「按这个 kind 找通道时, 哪几种 kind 都算数」—— 通道解析的唯一入口。

    有工具栏选择器的 (image / angle / video) 返回**同一个选择器下的那一组**: 生图选择器
    既列内置 image 也列模板 custom_image, 只筛一个的话用户在界面上选得中、一提交却被判
    "配置不存在"。

    没有选择器的 (chat) 只返回它自己。**这一条不能靠 `picker == ""` 分组反推**: 那样将来
    任何一个新加的、同样没有工具栏入口的 kind 都会自动变成"聊天模型的候选", 而 builder
    那边一整段注释都在防"聊天被静默接到别的通道上"。
    """
    spec = KIND_SPECS.get(kind)
    if spec is None or not spec.picker:
        return [kind]
    return [k for k, other in KIND_SPECS.items() if other.picker == spec.picker]


def channel_or_default(raw, kind: str = ImageProvider.Kind.IMAGE) -> ImageChannel | None:
    """「选中的那条, 没选/已失效就退到库里第一条」—— 生图和 angle 走的是同一条阶梯。

    一个函数而不是在两处各拼一遍: 那两份抄写已经分叉过一次 (一边补了"是哪个通道挂的"
    报错文案, 另一边没有)。

    退到第一条只有两种触发: 任务排队期间选中的那条被删了, 或者调用方(老的入队路径 /
    agent 没传 model 参数)本来就没带选择。前端选择器会自动落位到列表第一项, 所以正常
    使用不依赖它。排序跟选择器一致 (sort_order, label), 两边的"第一条"是同一条。
    """
    # 同一个选择器下的全部 kind 一起找: 生图选择器现在既列内置 image 也列模板
    # custom_image, 任务行里存的 id 可能是任一种。
    kinds = kinds_for_kind(kind)
    model = _enabled_model(raw, kinds) or (
        ImageModel.objects.filter(enabled=True, provider__kind__in=kinds)
        .select_related("provider")
        .first()
    )
    return channel_for_model(model) if model is not None else None
