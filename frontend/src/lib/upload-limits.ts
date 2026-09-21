/**
 * Upload limits — 跟后端必须一致。改时后端常量 + 这里同步, 否则前端拦不住的会
 * 被 400 顶回来 (差体验)。
 */

/* 这里原来有一个 MAX_UPLOAD_IMAGE_BYTES (10 MB), 在前端把超大的图**静默筛掉**。
   已删除 —— 导入图片不再有前端上限, 由后端裁决 (services/attachments.py 的
   MAX_ATTACHMENT_BYTES, 可用 CANVAS_MAX_ATTACHMENT_MB 调)。

   顺带一提, 它的注释写的是"跟后端 MAX_UPLOAD_IMAGE_BYTES 一致" —— 后端**从来没有过**
   这个常量, 真正的那个叫 MAX_ATTACHMENT_BYTES 而且是 20 MB。两个数从一开始就没对上,
   而这种不一致正好不会报错: 用户只会觉得"10 MB 以上的图传不上去"。 */

/** 单篇 SKILL.md 体积上限 (256 KB), 跟后端 skill_md.MAX_CONTENT_BYTES 一致。
 *
 *  前端这道只是粗筛 —— 准入仍然由后端裁决 (它按 UTF-8 字节算, 报错也更具体)。但超过
 *  Django 的 DATA_UPLOAD_MAX_MEMORY_SIZE 之后请求根本到不了序列化器, 用户只会收到一句
 *  没头没脑的 "install failed", 所以太大的必须在这里就拦下。
 *
 *  数字只写在这一处: 提示文案里的 "256 KB" 也从它插值出来, 不再手写一遍。 */
export const MAX_SKILL_BYTES = 256 * 1024;
