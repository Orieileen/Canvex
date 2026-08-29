/**
 * Upload limits — 跟后端必须一致。改时后端常量 + 这里同步, 否则前端拦不住的会
 * 被 400 顶回来 (差体验)。
 */

/** 单张上传图体积上限 (10 MB), 跟后端 MAX_UPLOAD_IMAGE_BYTES 一致。 */
export const MAX_UPLOAD_IMAGE_BYTES = 10 * 1024 * 1024;

/** 单篇 SKILL.md 体积上限 (256 KB), 跟后端 skill_md.MAX_CONTENT_BYTES 一致。
 *
 *  前端这道只是粗筛 —— 准入仍然由后端裁决 (它按 UTF-8 字节算, 报错也更具体)。但超过
 *  Django 的 DATA_UPLOAD_MAX_MEMORY_SIZE 之后请求根本到不了序列化器, 用户只会收到一句
 *  没头没脑的 "install failed", 所以太大的必须在这里就拦下。
 *
 *  数字只写在这一处: 提示文案里的 "256 KB" 也从它插值出来, 不再手写一遍。 */
export const MAX_SKILL_BYTES = 256 * 1024;
