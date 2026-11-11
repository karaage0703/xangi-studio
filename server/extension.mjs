import { ArtifactRequests } from "./artifact-requests.mjs";
import { XangiHost } from "./xangi-host.mjs";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { ReviewJobs } from "./review-jobs.mjs";
import { ReviewStore } from "./store.mjs";
import { createServer } from "./http.mjs";

const project = fileURLToPath(new URL("..", import.meta.url));
const workspaceIndex = process.argv.indexOf("--workspace");
const workspace = resolve(
  workspaceIndex >= 0 ? process.argv[workspaceIndex + 1] : process.cwd(),
);
process.env.XANGI_REVIEW_WORKSPACE = workspace;
const instance = (process.env.XANGI_EXTENSION_INSTANCE_ID ?? "default").replace(
  /[^a-zA-Z0-9._-]/g,
  "-",
);
const dataDir = resolve(
  process.env.XANGI_REVIEW_DATA_DIR ??
    resolve(project, ".state", `managed-${instance}`),
);
const root = resolve(dataDir, "changes");
const stateDir = resolve(dataDir, "state");
const token = process.env.XANGI_EXTENSION_AUTH_TOKEN;

if (!token) throw new Error("XANGI_EXTENSION_AUTH_TOKEN is required");
await readFile(resolve(project, "dist", "index.html"));
await mkdir(root, { recursive: true });
const store = await new ReviewStore(root, stateDir).init();
const reviewJobs = await new ReviewJobs(
  store,
  resolve(
    process.env.DATA_DIR || resolve(workspace, ".xangi"),
    "logs",
    "sessions",
  ),
).init();
reviewJobs.start();
const artifactRequests = await new ArtifactRequests(
  store,
  new XangiHost(),
).init();
artifactRequests.start();
const server = createServer({
  artifactRequests,
  reviewJobs,
  store,
  token,
  distDir: resolve(project, "dist"),
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("managed HTTP address is unavailable");
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 2,
      event: "ready",
      id: "xangi-studio",
      baseUrl: `http://127.0.0.1:${address.port}`,
      workspace,
    })}\n`,
  );
});

const stop = () => {
  artifactRequests.stop();
  reviewJobs.stop();
  server.close(() => process.exit(0));
};
process.stdin.resume();
process.stdin.on("end", stop);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, stop);
