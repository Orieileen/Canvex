import type { AxiosResponse } from "axios";
import { request } from "@/utils/request";

export type ResourcePayload<T> = Partial<Omit<T, "id" | "created_at" | "updated_at">>;

export interface CrudResource<T> {
  list: () => Promise<AxiosResponse<T[]>>;
  retrieve: (id: string) => Promise<AxiosResponse<T>>;
  create: (payload: ResourcePayload<T>) => Promise<AxiosResponse<T>>;
  update: (id: string, payload: ResourcePayload<T>) => Promise<AxiosResponse<T>>;
  remove: (id: string) => Promise<AxiosResponse<void>>;
}

/**
 * REST 资源 CRUD 工厂。
 *
 * basePath 必须以斜杠结尾，例如 ``/api/v1/canvas/scenes/``。
 */
export function createResource<T>(basePath: string): CrudResource<T> {
  return {
    list: () => request.get<T[]>(basePath),
    retrieve: (id) => request.get<T>(`${basePath}${id}/`),
    create: (payload) => request.post<T>(basePath, payload),
    update: (id, payload) => request.patch<T>(`${basePath}${id}/`, payload),
    remove: (id) => request.delete(`${basePath}${id}/`),
  };
}
