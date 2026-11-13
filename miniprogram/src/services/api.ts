import { config } from "../config";
import { Api } from "../types";

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public songId?: number,
    public hidden = false,
  ) {
    super(message);
  }
}
export type ContainerCall = (options: {
  config: { env: string };
  path: string;
  method: "GET" | "POST";
  header: Record<string, string>;
  data?: object;
  timeout: number;
}) => Promise<{ statusCode: number; data: unknown }>;

export function createApi(call: ContainerCall): Api {
  async function request<T>(
    path: string,
    method: "GET" | "POST",
    data?: object,
  ): Promise<T> {
    if (
      !path.startsWith("/api/") ||
      path.startsWith("//") ||
      path.includes("://")
    ) {
      throw new ApiError("invalid_path", "只允许调用本服务 API");
    }
    let response: { statusCode: number; data: unknown };
    try {
      response = await call({
        config: { env: config.env },
        path,
        method,
        header: {
          "X-WX-SERVICE": config.service,
          "Content-Type": "application/json",
        },
        data,
        timeout: 60000,
      });
    } catch {
      throw new ApiError(
        "cloud_call_failed",
        "云调用失败，请检查环境、服务名、网络及云托管部署",
      );
    }
    let payload = response.data;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        throw new ApiError("invalid_response", "服务未返回有效 JSON");
      }
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const e = (
        payload as {
          error?: {
            code?: string;
            message?: string;
            song_id?: number;
            hidden?: boolean;
          };
        }
      )?.error;
      throw new ApiError(
        e?.code || "request_failed",
        e?.message || "服务请求失败 " + response.statusCode,
        e?.song_id,
        !!e?.hidden,
      );
    }
    return payload as T;
  }
  return {
    get: <T>(path: string) => request<T>(path, "GET"),
    post: <T>(path: string, data = {}) => request<T>(path, "POST", data),
  };
}

export function uuid(bytes: ArrayBuffer): string {
  if (bytes.byteLength !== 16)
    throw new ApiError("random_failed", "无法生成唯一请求 ID");
  const values = new Uint8Array(bytes);
  values[6] = (values[6] & 15) | 64;
  values[8] = (values[8] & 63) | 128;
  const hex = Array.from(values, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export const api = createApi((options) => wx.cloud.callContainer(options));
export function newRequestId(): Promise<string> {
  return new Promise((resolve, reject) =>
    wx.getRandomValues({
      length: 16,
      success: (result) => resolve(uuid(result.randomValues)),
      fail: () =>
        reject(
          new ApiError("random_failed", "安全随机数不可用，请更新微信后重试"),
        ),
    }),
  );
}
