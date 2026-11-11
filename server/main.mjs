import { ArtifactRequests } from "./artifact-requests.mjs";
import { XangiHost } from "./xangi-host.mjs";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { ReviewStore, seedDemo, atomicWrite } from "./store.mjs";
import { createServer } from "./http.mjs";

const project = fileURLToPath(new URL("..", import.meta.url));
const stateDir = resolve(project, process.env.EDITOR_STATE_DIR ?? ".state");
const root = resolve(project, process.env.EDITOR_ROOT ?? "workspace");
const store = await new ReviewStore(root, stateDir).init();
const tokenFile = resolve(stateDir, "access-token");
let token;
try {
  token = (await readFile(tokenFile, "utf8")).trim();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  token = randomBytes(32).toString("base64url");
  await writeFile(tokenFile, token, { flag: "wx", mode: 0o600 });
}
// Only seed the bundled sandbox; never modify a configured external root on startup.
if (!process.env.EDITOR_ROOT) await seedDemo(store);
const host = process.env.EDITOR_HOST ?? "127.0.0.1";
const port = Number(process.env.EDITOR_PORT ?? 18930);
const baseUrl = process.env.EDITOR_BASE_URL ?? `http://${host}:${port}`;
const artifactRequests = await new ArtifactRequests(
  store,
  new XangiHost(),
).init();
artifactRequests.start();
const server = createServer({
  artifactRequests,
  store,
  token,
  distDir: resolve(project, "dist"),
});
server.listen(port, host, async () => {
  await atomicWrite(
    resolve(stateDir, "runtime.json"),
    JSON.stringify(
      {
        pid: process.pid,
        root,
        baseUrl,
        startedAt: new Date().toISOString(),
        status: "running",
      },
      null,
      2,
    ),
  );
  console.log(`xangi editor listening on ${baseUrl}`);
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    artifactRequests.stop();
    server.close(async () => {
      await atomicWrite(
        resolve(stateDir, "exit.json"),
        JSON.stringify({
          pid: process.pid,
          signal,
          exitedAt: new Date().toISOString(),
        }),
      );
      process.exit(0);
    });
  });
}
