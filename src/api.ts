import { parseXangiChatEvents } from "../shared/auto-review.mjs";

export type Platform = "discord" | "slack" | "web";
export type Mode = "preview" | "diff" | "edit";
export type Snapshot = {
  id: string;
  label: string;
  at: string;
  content?: string;
};
export type Explanation = {
  heading: string;
  summary: string;
  impact: string;
  review: string;
  severity: "info" | "warning" | "danger";
  oldStart: number;
  newStart: number;
};
export type SoftwareOverview = {
  summary: string;
  before: string;
  after: string;
  nodes: { id: string; label: string; description: string; files: string[] }[];
  edges: { from: string; to: string; label: string }[];
  decisions: {
    fact: string;
    reason: string;
    question: string;
    files: string[];
  }[];
  limitations: string[];
  revision: string;
  generatedAt: string;
  reviewer: string;
};
export type ReviewSummary = {
  document?: {
    id: string;
    page: number;
    pages: number;
    name: string;
    format?: string;
  };
  id: string;
  file: string;
  title: string;
  source: Platform;
  sourceUrl?: string | null;
  createdAt: string;
  history: Snapshot[];
  readOnly?: boolean;
  changeSet?: {
    kind:
      "github-pr" | "github-repository" | "git-diff" | "workspace" | "artifact";
    id: string;
    title: string;
    url: string;
    source: string;
    revision?: string;
    editRevision?: string;
    reviewContext?: string;
  } | null;
  softwareOverview?: SoftwareOverview;
  explanations?: Explanation[];
};
export type Review = ReviewSummary & {
  before: string;
  content: string;
  version: string;
  size: number;
  modifiedAt: string;
};
export type ReviewJob = {
  purpose?: "review" | "overview";
  files?: string[];
  group?: { index: number; total: number };
  file?: string;
  reviewer?: { id: string; name: string };
  sessionId: string;
  changeSet: NonNullable<ReviewSummary["changeSet"]>;
  status: "running" | "completed" | "failed";
  startedAt: number;
  error?: string;
  result?: { updated: number; total: number };
};
export type ImportResult = {
  imported: Array<{ id: string }>;
  skipped: Array<{ file: string; reason: string }>;
  status: "imported" | "updated" | "unchanged";
};
type ImportJob = {
  id: string;
  status: "running" | "completed" | "failed";
  result?: ImportResult;
  error?: string;
};
export type ArchivedChangeSet = NonNullable<ReviewSummary["changeSet"]> & {
  key: string;
};
export type ReviewPreferences = {
  defaultProjectId: string | null;
  reviewerProjectIds: string[];
  archivedChangeSets: ArchivedChangeSet[];
};
export type XangiProject = {
  id: string;
  name: string;
  prompt: string;
  backend?: string;
  model?: string;
  effort?: string;
  workspaceId?: string;
};

const supplied = new URLSearchParams(window.location.hash.slice(1)).get("key");
if (supplied) sessionStorage.setItem("xangi-editor-key", supplied);
export const isManagedExtension = /^\/api\/extensions\/[^/]+\/ui(?:\/|$)/.test(
  window.location.pathname,
);
export const workspacePath = window.location.pathname.startsWith(
  "/api/extensions/",
)
  ? window.location.pathname
  : "/";
export const accessKey =
  supplied ?? sessionStorage.getItem("xangi-editor-key") ?? "";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function fetchReview(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const target = window.location.pathname.startsWith("/api/extensions/")
    ? new URL(path.replace(/^\//, ""), document.baseURI).toString()
    : path;
  return fetch(target, {
    ...options,
    signal:
      options.signal ??
      (path.startsWith("/api/import/")
        ? AbortSignal.timeout(60_000)
        : undefined),
    headers: {
      Authorization: `Bearer ${accessKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
}

const readCache = new Map<string, { revision: string; value: unknown }>();

export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const cacheable =
    (!options.method || options.method === "GET") &&
    /^\/api\/(reviews|preferences|review-jobs)(\?|$)/.test(path);
  const cached = cacheable ? readCache.get(path) : undefined;
  // The managed extension proxy forwards query parameters but not cache headers.
  const target = cacheable
    ? `${path}${path.includes("?") ? "&" : "?"}poll=1${cached ? `&since=${cached.revision}` : ""}`
    : path;
  const response = await fetchReview(target, options);
  const payload = await response.json();
  if (!response.ok)
    throw new HttpError(
      response.status,
      payload.error ?? "通信に失敗しました。",
    );
  if (cacheable && payload.revision) {
    if (payload.unchanged && cached) return cached.value as T;
    readCache.set(path, { revision: payload.revision, value: payload.data });
    return payload.data as T;
  }
  return payload;
}

async function waitForImport(path: string): Promise<ImportResult> {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const job = await request<ImportJob>(path);
    if (job.status === "completed" && job.result) return job.result;
    if (job.status === "failed")
      throw new Error(job.error ?? "取り込みに失敗しました。");
  }
  throw new Error(
    "取り込み結果の待機時間を超えました。サーバー側の処理は続いている可能性があります。成果物一覧を確認してください。",
  );
}

// Only this adapter knows the transport. The screen can later use xangi's API.
export const reviewApi = {
  importGoogle: async (
    url: string,
    reviewContext?: string,
  ): Promise<ImportResult> => {
    const { id } = await request<ImportJob>("/api/import/google", {
      method: "POST",
      body: JSON.stringify({ url, reviewContext }),
    });
    return waitForImport(`/api/import/pdf/jobs/${id}`);
  },
  notionConfig: () => request<{ configured: boolean }>("/api/notion"),
  exportNotion: async (id: string): Promise<{ url: string }> => {
    type Job = { id: string; status: string; url?: string; error?: string };
    let job = await request<Job>(
      `/api/reviews/${encodeURIComponent(id)}/notion`,
      { method: "POST" },
    );
    while (job.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      job = await request<Job>(
        `/api/notion/jobs/${encodeURIComponent(job.id)}`,
      );
    }
    if (job.status !== "completed" || !job.url)
      throw new Error(job.error ?? "Notion保存結果を確認できません。");
    return { url: job.url };
  },
  documentPrompt: (id: string) =>
    request<{ prompt: string }>(
      `/api/reviews/${encodeURIComponent(id)}/prompt`,
    ),
  pageImage: async (id: string): Promise<string> => {
    const response = await fetchReview(
      `/api/reviews/${encodeURIComponent(id)}/page`,
    );
    if (!response.ok)
      throw new Error(
        (await response.json()).error ?? "ページ画像を取得できません。",
      );
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  },
  importPdf: async (
    file: File,
    reviewContext?: string,
  ): Promise<ImportResult> => {
    if (file.size > 100 * 1024 * 1024)
      throw new Error("PDFの上限は100MBです。");
    let uploadId: string | undefined;
    let jobId = "";
    const chunkSize = 384 * 1024;
    const total = Math.max(1, Math.ceil(file.size / chunkSize));
    for (let index = 0; index < total; index++) {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(
          file.slice(index * chunkSize, (index + 1) * chunkSize),
        );
      });
      const response = await request<{ uploadId: string; id?: string }>(
        "/api/import/pdf",
        {
          method: "POST",
          body: JSON.stringify({
            name: file.name,
            ...(index === 0 ? { reviewContext } : {}),
            uploadId,
            index,
            total,
            data,
          }),
        },
      );
      uploadId = response.uploadId;
      jobId = response.id ?? "";
    }
    const id = jobId;
    return waitForImport(`/api/import/pdf/jobs/${id}`);
  },
  jobs: () => request<ReviewJob[]>("/api/review-jobs"),
  registerJob: (
    changeSet: NonNullable<ReviewSummary["changeSet"]>,
    sessionId: string,
    reviewer?: { id: string; name: string },
    file?: string,
    options: {
      purpose?: "review" | "overview";
      files?: string[];
      group?: { index: number; total: number };
    } = {},
  ) =>
    request<ReviewJob>("/api/review-jobs", {
      method: "POST",
      body: JSON.stringify({
        changeSet,
        sessionId,
        reviewer,
        file,
        ...options,
      }),
    }),
  list: () => request<ReviewSummary[]>("/api/reviews"),
  read: (id: string) =>
    request<Review>(`/api/reviews/${encodeURIComponent(id)}`),
  save: (id: string, content: string) =>
    request<Review>(`/api/reviews/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),
  snapshot: (id: string, snapshot: string) =>
    request<Snapshot & { content: string }>(
      `/api/reviews/${encodeURIComponent(id)}/history/${encodeURIComponent(snapshot)}`,
    ),
  importGithub: async (
    url: string,
    reviewContext?: string,
  ): Promise<ImportResult> => {
    const { id } = await request<ImportJob>("/api/import/github", {
      method: "POST",
      body: JSON.stringify({ url, reviewContext }),
    });
    return waitForImport(`/api/import/github/jobs/${encodeURIComponent(id)}`);
  },
  applyAnalysis: (
    changeSet: NonNullable<ReviewSummary["changeSet"]>,
    analysis: Record<string, Explanation[]>,
  ) =>
    request<{ updated: number; total: number }>("/api/import/github/analysis", {
      method: "POST",
      body: JSON.stringify({ changeSet, analysis }),
    }),
  preferences: () => request<ReviewPreferences>("/api/preferences"),
  savePreferences: (
    defaultProjectId: string | null,
    reviewerProjectIds: string[],
  ) =>
    request<ReviewPreferences>("/api/preferences", {
      method: "PUT",
      body: JSON.stringify({ defaultProjectId, reviewerProjectIds }),
    }),
  setArchived: (key: string, archived: boolean) =>
    request<ReviewPreferences>("/api/change-sets/archive", {
      method: "POST",
      body: JSON.stringify({ key, archived }),
    }),
};

async function xangiJson<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    /* Keep the plain response for the error below. */
  }
  if (!response.ok)
    throw new HttpError(
      response.status,
      typeof payload.error === "string"
        ? payload.error
        : text || "xangiとの通信に失敗しました。",
    );
  return payload as T;
}

export const xangiApi = {
  session: (sessionId: string) =>
    xangiJson<{
      messages: Array<{ role: string; content: string }>;
    }>(`/api/sessions/${encodeURIComponent(sessionId)}?limit=200`),
  projects: async () =>
    (await xangiJson<{ agents: XangiProject[] }>("/api/agents")).agents,
  createSession: async (projectId?: string) =>
    (
      await xangiJson<{ sessionId: string }>("/api/sessions", {
        method: "POST",
        body: JSON.stringify(projectId ? { agentId: projectId } : {}),
      })
    ).sessionId,
  sendMessage: async (sessionId: string, message: string) => {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appSessionId: sessionId, message }),
    });
    const body = await response.text();
    if (!response.ok)
      throw new HttpError(
        response.status,
        body || "会話を開始できませんでした。",
      );
    return parseXangiChatEvents(body);
  },
};
