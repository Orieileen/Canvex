import type { AxiosResponse } from "axios";
import { request } from "@/utils/request";

export type ResourcePayload<T> = Partial<Omit<T, "id" | "created_at" | "updated_at">>;

/** `W` 是写入形状, 默认跟读取形状同一个。分开是因为嵌套子资源的 id 不对称 ——
 *  后端返回的行一定有 id, 前端新建的行还没有, 发个假 id 过去比不发更糟。 */
export interface CrudResource<T, W = T> {
  list: () => Promise<AxiosResponse<T[]>>;
  retrieve: (id: string) => Promise<AxiosResponse<T>>;
  create: (payload: ResourcePayload<W>) => Promise<AxiosResponse<T>>;
  update: (id: string, payload: ResourcePayload<W>) => Promise<AxiosResponse<T>>;
  remove: (id: string) => Promise<AxiosResponse<void>>;
}

/**
 * REST 资源 CRUD 工厂。
 *
 * basePath 必须以斜杠结尾，例如 ``/api/v1/canvas/scenes/``。
 */
export function createResource<T, W = T>(basePath: string): CrudResource<T, W> {
  return {
    list: () => request.get<T[]>(basePath),
    retrieve: (id) => request.get<T>(`${basePath}${id}/`),
    create: (payload) => request.post<T>(basePath, payload),
    update: (id, payload) => request.patch<T>(`${basePath}${id}/`, payload),
    remove: (id) => request.delete(`${basePath}${id}/`),
  };
}
