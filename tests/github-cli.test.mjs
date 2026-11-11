import test from "node:test";
import assert from "node:assert/strict";
import { githubCliEnvironment } from "../server/github-cli.mjs";
const env = {
  PATH: "/tmp/xangi-gh-wrapper:/usr/bin:/tmp/xangi-gh-wrapper:/bin",
  XANGI_TOOL_SERVER: "http://127.0.0.1:1234",
  GH_CONFIG_DIR: "/existing/gh",
};
test("App-disabled host uses its existing normal gh authentication without changing parent env", async () => {
  const result = await githubCliEnvironment(env, async () =>
    Response.json({ error: "GitHub App is not configured" }, { status: 404 }),
  );
  assert.equal(result.PATH, "/usr/bin:/bin");
  assert.equal(result.GH_CONFIG_DIR, env.GH_CONFIG_DIR);
  assert.match(env.PATH, /wrapper/);
});
test("configured App, unrelated 404, auth errors and network failures never switch identity", async () => {
  for (const fetcher of [
    async () => new Response("token"),
    async () => Response.json({ error: "other" }, { status: 404 }),
    async () => new Response("", { status: 401 }),
    async () => new Response("", { status: 500 }),
    async () => {
      throw new Error("network");
    },
  ])
    assert.equal(await githubCliEnvironment(env, fetcher), env);
});
test("no inherited wrapper or no explicit host performs no request", async () => {
  const fail = async () => {
    throw new Error("unexpected request");
  };
  const noWrapper = { ...env, PATH: "/usr/bin" };
  assert.equal(await githubCliEnvironment(noWrapper, fail), noWrapper);
  const noHost = { PATH: env.PATH };
  assert.equal(await githubCliEnvironment(noHost, fail), noHost);
});
