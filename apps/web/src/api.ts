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
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
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
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export type Role = "admin" | "operator";

export interface Me {
  user: { username: string; role: Role; mustChangePassword?: boolean };
}

export interface PublicUser {
  id: string;
  username: string;
  role: Role;
  createdAt: string;
}

export interface StreamView {
  id: string;
  slug: string;
  title: string;
  status: "draft" | "starting" | "live" | "ended";
  kind: "video" | "audio";
  posterUrl: string | null;
  iconUrl: string | null;
  fallbackPosterUrl: string;
  adminPosterUrl: string;
  adminIconUrl: string;
  posterPalette: string | null;
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
    backupReady: boolean;
    currentInput: "primary" | "backup" | null;
    readers: number;
    server: string;
    backupServer: string;
    publishUser: string;
    hasPublishPass: boolean;
  };
  cdn: { enabled: boolean; hlsBaseUrl: string; publicBaseUrl: string };
}

export interface Settings {
  brandName: string;
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

export interface LiveMeta {
  slug: string;
  title: string;
  status: "starting" | "live" | "ended";
  kind: "video" | "audio";
  posterUrl: string | null;
  iconUrl: string | null;
  fallbackPosterUrl: string;
  startedAt: string | null;
  endedAt: string | null;
  hlsUrl: string;
  pageUrl: string;
}

export interface ProbeResult {
  ok: boolean;
  status?: number;
  error?: string;
  ms: number;
}

export interface Checks {
  origin: ProbeResult;
  cdn: ProbeResult | null;
  ingestTcp: boolean;
  cdnEnabled: boolean;
  pipeline: string;
}

/** Uploads a File's raw bytes; the server sniffs the format by magic bytes. */
export async function uploadStreamImage(
  streamId: string,
  kind: "poster" | "icon",
  file: File,
): Promise<StreamView> {
  const type = file.type || (file.name.endsWith(".png") ? "image/png" : file.name.endsWith(".webp") ? "image/webp" : "image/jpeg");
  const res = await fetch(`/api/admin/streams/${streamId}/${kind}`, {
    method: "POST",
    body: file,
    credentials: "same-origin",
    headers: { "content-type": type },
  });
  if (!res.ok) {
    let body: { error?: string } = {};
    try {
      body = (await res.json()) as { error?: string };
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  }
  return ((await res.json()) as { stream: StreamView }).stream;
}

/** What to show for a broadcast: the uploaded poster, else the generated one. */
export function posterSrc(stream: { posterUrl: string | null; adminPosterUrl: string }): string {
  return stream.posterUrl ?? stream.adminPosterUrl;
}

export function iconSrc(stream: { iconUrl: string | null; adminIconUrl: string }): string {
  return stream.iconUrl ?? stream.adminIconUrl;
}

export async function recoverPassword(username: string, code: string, newPassword: string): Promise<void> {
  await request("/api/auth/recover", {
    method: "POST",
    body: JSON.stringify({ username, code, newPassword }),
  });
}
