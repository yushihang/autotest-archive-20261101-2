/**
 * 按 [`docs/api-contract.md`](../../docs/api-contract.md) 封装的 typed fetch 客户端。
 *
 * 约定：
 * - 只做 HTTP 与错误规范化，不缓存、不重试、不读数据库；
 * - 所有非 2xx 响应统一抛 {@link ApiError}，调用方只需要展示 `message` / `details`；
 * - 路径用同源相对地址（`/api/...`），因此默认在浏览器端调用；
 *   如果控制台与 API 分域部署，用 `NEXT_PUBLIC_API_BASE_URL` 指定 API 源。
 */

import type {
  ApiErrorBody,
  ApiErrorCode,
  Paginated,
  Project,
  Run,
  RunStatus,
  RunSummary,
} from "@/lib/domain";

/** 列表接口的默认每页条数（契约默认 20，最大 100）。 */
export const DEFAULT_PAGE_SIZE = 20;

/**
 * 客户端侧的错误码 = 契约里的服务端错误码 + 两个传输层错误。
 * 只有后两个是前端补的，展示时不需要区分来源。
 */
export type ApiClientErrorCode = ApiErrorCode | "network_error" | "invalid_response";

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/+$/, "");

const API_ERROR_CODES: readonly ApiErrorCode[] = [
  "bad_request",
  "validation_error",
  "not_found",
  "conflict",
  "run_not_cancellable",
  "payload_too_large",
  "internal_error",
];

/** 统一的请求错误；`details` 直接对应契约里的字段级错误。 */
export class ApiError extends Error {
  readonly code: ApiClientErrorCode;
  readonly status: number;
  readonly details: Record<string, string[]> | null;

  constructor(init: {
    code: ApiClientErrorCode;
    message: string;
    status: number;
    details?: Record<string, string[]> | null;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.code = init.code;
    this.status = init.status;
    this.details = init.details ?? null;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** 任意异常 → 一句可直接展示的中文。 */
export function errorMessage(error: unknown): string {
  if (isApiError(error)) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "请求失败，请稍后重试。";
}

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && (API_ERROR_CODES as readonly string[]).includes(value);
}

/** 浏览器把取消包成 DOMException，Node 包成 Error，两者都靠 name 判断。 */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function parseDetails(value: unknown): Record<string, string[]> | null {
  if (typeof value !== "object" || value === null) return null;

  const details: Record<string, string[]> = {};
  let hasEntry = false;
  for (const [field, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(raw)) continue;
    const messages = raw.filter((item): item is string => typeof item === "string");
    if (messages.length === 0) continue;
    details[field] = messages;
    hasEntry = true;
  }

  return hasEntry ? details : null;
}

/** 校验收到的错误体；形状不对时返回 null，由调用方兜底。 */
function parseErrorBody(payload: unknown): ApiErrorBody["error"] | null {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) {
    return null;
  }

  const envelope = (payload as { error?: unknown }).error;
  if (typeof envelope !== "object" || envelope === null) return null;
  if (!("code" in envelope) || !("message" in envelope)) return null;

  const { code, message } = envelope as { code: unknown; message: unknown };
  if (!isApiErrorCode(code) || typeof message !== "string") return null;

  const details = "details" in envelope ? parseDetails((envelope as { details?: unknown }).details) : null;
  return { code, message, details };
}

/** 服务端没给错误码时，用 HTTP 状态码兜底。 */
function fallbackErrorCode(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return "bad_request";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 413:
      return "payload_too_large";
    case 422:
      return "validation_error";
    default:
      return "internal_error";
  }
}

type QueryValue = string | number | boolean | null | undefined;

function buildQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

/**
 * 发起一次 JSON 请求。
 *
 * `AbortError` 会原样抛出（取消是控制流，不是错误），调用方通过 `signal.aborted` 忽略即可。
 */
export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers,
      cache: "no-store",
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiError({
      code: "network_error",
      status: 0,
      message: `无法连接接口 ${path}，请确认服务已启动。`,
    });
  }

  const raw = await response.text();
  let payload: unknown = null;
  if (raw.trim().length > 0) {
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const body = parseErrorBody(payload);
    throw new ApiError({
      status: response.status,
      code: body?.code ?? fallbackErrorCode(response.status),
      message: body?.message ?? `请求失败（HTTP ${response.status}）。`,
      details: body?.details ?? null,
    });
  }

  if (raw.trim().length === 0) {
    throw new ApiError({
      status: response.status,
      code: "invalid_response",
      message: "服务端返回了空响应，预期是 JSON。",
    });
  }

  if (payload === null) {
    throw new ApiError({
      status: response.status,
      code: "invalid_response",
      message: "服务端返回的不是合法 JSON。",
    });
  }

  return payload as T;
}

// ---------------------------------------------------------------------------
// /api/projects
// ---------------------------------------------------------------------------

export interface ListProjectsParams {
  page?: number;
  pageSize?: number;
  /** 按名称模糊匹配，大小写不敏感。 */
  q?: string | null;
  signal?: AbortSignal;
}

export async function listProjects(params: ListProjectsParams = {}): Promise<Paginated<Project>> {
  const { page = 1, pageSize = DEFAULT_PAGE_SIZE, q, signal } = params;
  const query = buildQuery({ page, pageSize, q });
  return apiRequest<Paginated<Project>>(`/api/projects${query}`, { signal });
}

export interface CreateProjectInput {
  /** 1–64 字符，实例内不区分大小写唯一。 */
  name: string;
  /** ≤ 500 字符；缺省为 null。 */
  description?: string | null;
  /** 合法 http(s) URL，≤ 2048 字符。 */
  baseUrl: string;
  /** 1000–120000，缺省由服务端取 15000。 */
  defaultStepTimeoutMs?: number;
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const body: Record<string, unknown> = {
    name: input.name,
    baseUrl: input.baseUrl,
    description: input.description ?? null,
  };
  if (input.defaultStepTimeoutMs !== undefined) {
    body.defaultStepTimeoutMs = input.defaultStepTimeoutMs;
  }

  return apiRequest<Project>("/api/projects", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// /api/runs
// ---------------------------------------------------------------------------

export interface ListRunsParams {
  projectId?: string | null;
  /** 多值会拼成 `status=running,failed`。 */
  status?: readonly RunStatus[] | null;
  page?: number;
  pageSize?: number;
  signal?: AbortSignal;
}

export async function listRuns(params: ListRunsParams = {}): Promise<Paginated<RunSummary>> {
  const { projectId, status, page = 1, pageSize = DEFAULT_PAGE_SIZE, signal } = params;
  const query = buildQuery({
    projectId,
    status: status && status.length > 0 ? status.join(",") : null,
    page,
    pageSize,
  });

  return apiRequest<Paginated<RunSummary>>(`/api/runs${query}`, { signal });
}

export async function getRun(runId: string, options: { signal?: AbortSignal } = {}): Promise<Run> {
  return apiRequest<Run>(`/api/runs/${encodeURIComponent(runId)}`, { signal: options.signal });
}
