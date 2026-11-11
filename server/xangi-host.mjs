import { ApiError } from "./store.mjs";

// Only the administrator-provided host can receive requests.
export class XangiHost {
  constructor(baseUrl = process.env.XANGI_EXTENSION_HOST_URL) {
    this.baseUrl = baseUrl ? new URL(baseUrl).origin : null;
  }
  async request(path, body) {
    if (!this.baseUrl)
      throw new ApiError(
        503,
        "xangi接続が未設定です。Managed Extensionで開いてください。",
      );
    const response = await fetch(this.baseUrl + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Origin: this.baseUrl },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (!response.ok)
      throw new ApiError(
        response.status,
        `xangiとの通信に失敗しました (${response.status})。`,
      );
    return response.json();
  }
  async options() {
    const [{ projects }, { agents }] = await Promise.all([
      this.request("/api/projects"),
      this.request("/api/agents"),
    ]);
    return { projects, agents };
  }
  async start(task, { projectId, agentId }) {
    const [options, settings] = await Promise.all([
      this.options(),
      this.request("/api/runtime-settings"),
    ]);
    const project = options.projects.find((p) => p.id === projectId);
    if (projectId && !project)
      throw new ApiError(400, "プロジェクトが見つかりません。");
    const selectedAgent = agentId || project?.defaultAgentId;
    if (selectedAgent && !options.agents.some((a) => a.id === selectedAgent))
      throw new ApiError(400, "担当エージェントが見つかりません。");
    const defaults = settings.backend.value;
    return (
      await this.request("/api/agent-runs", {
        task: [project?.prompt, project?.materials, task]
          .filter(Boolean)
          .join("\n\n"),
        title: "xangi-studioからの依頼",
        projectId: projectId || undefined,
        agentId: selectedAgent || undefined,
        ...(!selectedAgent
          ? {
              backend: defaults.backend,
              model: defaults.model,
              effort: defaults.effort,
              workspaceId: project?.workspaceId,
            }
          : {}),
      })
    ).run;
  }
  async read(id) {
    return (await this.request(`/api/agent-runs/${encodeURIComponent(id)}`))
      .run;
  }
}
