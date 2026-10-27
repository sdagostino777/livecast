/** Small typed fetch wrapper: same-origin cookies, JSON, one error type. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  if (!res.ok) {
    let body: { error?: string } = {};
    try {
      body = (await res.json()) as { error?: string };
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export interface Me {
  user: { username: string; role: string; totpEnabled: boolean };
}

export interface StreamView {
  id: string;
  slug: string;
  title: string;
  status: "draft" | "starting" | "live" | "ended";
  record: boolean;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  pageUrl: string;
}

export interface Overview {
  serverTime: string;
  publicUrl: string;
  stream: StreamView | null;
  pipeline: {
    status: "idle" | "starting" | "live" | "ended";
    attempts: number;
    startedAt: string | null;
    lastError: string | null;
  };
  ingest: {
    reachable: boolean;
    ready: boolean;
    readers: number;
    server: string;
    publishUser: string;
    hasPublishPass: boolean;
  };
  cdn: { enabled: boolean; hlsBaseUrl: string; publicBaseUrl: string };
}

export interface Settings {
  publicBaseUrl: string;
  cdnBaseUrl: string;
  ingestHost: string;
  ingestPort: number;
  hlsBaseUrl: string;
  obsServer: string;
}

export interface CdnTestResult {
  ok: boolean;
  probe: string;
  status?: number;
  headers?: Record<string, string | null>;
  error?: string;
}
