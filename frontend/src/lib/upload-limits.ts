/**
 * Upload limits — 跟后端必须一致。改时后端常量 + 这里同步, 否则前端拦不住的会
 * 被 400 顶回来 (差体验)。
 */

/** 单张上传图体积上限 (10 MB), 跟后端 MAX_UPLOAD_IMAGE_BYTES 一致。 */
export const MAX_UPLOAD_IMAGE_BYTES = 10 * 1024 * 1024;
