import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewStore } from "../server/store.mjs";
import { ArtifactRequests } from "../server/artifact-requests.mjs";
import { XangiHost } from "../server/xangi-host.mjs";
import { createServer } from "../server/http.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "artifact-requests-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new ReviewStore(
    join(root, "files"),
    join(root, "state"),
  ).init();
  const review = await store.create({
    file: "sample.md",
    title: "原稿",
    content: "# 保存済みの本文",
    readOnly: true,
  });
  const calls = [];
  const host = {
    options: async () => ({
      projects: [{ id: "p", name: "Project" }],
      agents: [{ id: "writer", name: "Writer" }],
    }),
    start: async (task, target) => {
      calls.push({ task, target });
      return { id: "run", appSessionId: "conversation" };
    },
    read: async () => ({
      status: "succeeded",
      result: "# 完了\n説明を短くしました。",
    }),
  };
  const requests = await new ArtifactRequests(store, host).init();
  const body = {
    requestId: "receipt",
    instruction: "説明を短くして",
    expectedVersion: review.version,
    agentId: "writer",
  };
  return { root, store, review, host, requests, body, calls };
}
test("request dispatch is deduplicated, carries the saved source, and survives restart without changing the original", async (t) => {
  const { store, review, host, requests, body, calls } = await fixture(t);
  const [a, b] = await Promise.all([
    requests.submit(review.id, body),
    requests.submit(review.id, body),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(calls.length, 1);
  assert.match(calls[0].task, /保存済みの本文/);
  assert.match(calls[0].task, /原本は閲覧専用/);
  assert.match(calls[0].task, /説明を短くして/);
  assert.equal(calls[0].target.agentId, "writer");
  await assert.rejects(
    requests.submit(review.id, { ...body, instruction: "別の指示" }),
    { status: 409 },
  );
  await assert.rejects(
    requests.submit(review.id, { ...body, requestId: "second" }),
    { status: 409 },
  );
  const restored = await new ArtifactRequests(store, host).init();
  await restored.collect();
  assert.equal(restored.list(review.id)[0].status, "succeeded");
  assert.match(restored.list(review.id)[0].result, /完了/);
  assert.equal((await store.get(review.id)).content, review.content);
  assert.equal(calls.length, 1);
});
test("invalid instructions, stale versions and missing destinations never dispatch", async (t) => {
  const { review, requests, body, calls } = await fixture(t);
  for (const change of [
    { instruction: " " },
    { instruction: "a".repeat(4001) },
    { requestId: [] },
    { agentId: "missing" },
    { projectId: "p" },
    { expectedVersion: "stale" },
  ])
    await assert.rejects(requests.submit(review.id, { ...body, ...change }));
  assert.equal(calls.length, 0);
});
test("oversized saved content is rejected before dispatch", async (t) => {
  const { store, requests, calls, body } = await fixture(t);
  const large = await store.create({
    file: "large.md",
    content: "a".repeat(90001),
  });
  await assert.rejects(
    requests.submit(large.id, { ...body, expectedVersion: large.version }),
    { status: 413 },
  );
  assert.equal(calls.length, 0);
});
test("unknown dispatch and interrupted startup never automatically retry", async (t) => {
  const { store, review, host, requests, body } = await fixture(t);
  let attempts = 0;
  host.start = async () => {
    attempts++;
    throw new Error("timeout");
  };
  const result = await requests.submit(review.id, body);
  assert.equal(result.status, "interrupted");
  assert.match(result.error, /自動再送はしません/);
  await requests.submit(review.id, body);
  await requests.collect();
  assert.equal(attempts, 1);
  await writeFile(
    requests.file,
    JSON.stringify([{ ...result, status: "dispatching" }]),
  );
  const restored = await new ArtifactRequests(store, host).init();
  assert.equal(restored.list(review.id)[0].status, "interrupted");
  await restored.collect();
  assert.equal(attempts, 1);
});
test("progress transport failures retain running work; host failures remain visible", async (t) => {
  const { review, host, requests, body } = await fixture(t);
  await requests.submit(review.id, body);
  host.read = async () => {
    throw new Error("offline");
  };
  await requests.collect();
  assert.equal(requests.list(review.id)[0].status, "queued");
  assert.match(requests.list(review.id)[0].error, /offline/);
  host.read = async () => ({ status: "failed", error: "execution failed" });
  await requests.collect();
  assert.equal(requests.list(review.id)[0].status, "failed");
  assert.equal(requests.list(review.id)[0].error, "execution failed");
});
test("HTTP requests enforce auth and origin, and retired task APIs are gone", async (t) => {
  const { root, store, review, requests, body, calls } = await fixture(t);
  const server = createServer({
    store,
    artifactRequests: requests,
    token: "test",
    distDir: root,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    Authorization: "Bearer test",
    "Content-Type": "application/json",
  };
  const endpoint = `/api/reviews/${review.id}/requests`;
  assert.equal((await fetch(base + endpoint)).status, 401);
  assert.equal(
    (
      await fetch(base + endpoint, {
        method: "POST",
        headers: { ...headers, "sec-fetch-site": "cross-site" },
        body: JSON.stringify(body),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      })
    ).status,
    202,
  );
  const list = await (await fetch(base + endpoint, { headers })).json();
  assert.equal(list[0].sessionId, "conversation");
  assert.equal(calls.length, 1);
  for (const path of [
    "/api/studio",
    "/api/studio/options",
    "/api/studio/tasks/old",
    "/api/drafts/studio/old",
  ])
    assert.equal((await fetch(base + path, { headers })).status, 404);
});
test("host uses runtime defaults or the selected project agent without restricting the requested work", async () => {
  const host = new XangiHost("http://localhost:1234");
  let sent;
  host.request = async (path, body) => {
    if (path === "/api/projects")
      return {
        projects: [
          {
            id: "p",
            defaultAgentId: "writer",
            prompt: "共通指示",
            materials: "資料",
          },
        ],
      };
    if (path === "/api/agents") return { agents: [{ id: "writer" }] };
    if (path === "/api/runtime-settings")
      return { backend: { value: { backend: "codex", model: "configured" } } };
    sent = body;
    return { run: { id: "run", appSessionId: "chat" } };
  };
  await host.start("依頼", {});
  assert.equal(sent.backend, "codex");
  assert.equal(sent.model, "configured");
  assert.equal(sent.agentId, undefined);
  await host.start("依頼", { projectId: "p" });
  assert.equal(sent.agentId, "writer");
  assert.equal(sent.projectId, "p");
  assert.match(sent.task, /共通指示/);
  assert.match(sent.task, /資料/);
  assert.doesNotMatch(sent.task, /ファイル変更.*行わない/);
  assert.equal(sent.skipPermissions, undefined);
});
