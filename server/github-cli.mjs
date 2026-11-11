import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const wrapperDirectory = "/tmp/xangi-gh-wrapper";

// A host without App auth can inherit another instance's wrapper in PATH.
// Only the host's explicit "not configured" response permits normal gh auth.
export async function githubCliEnvironment(env = process.env, fetcher = fetch) {
  if (
    !env.XANGI_TOOL_SERVER ||
    !env.PATH?.split(":").includes(wrapperDirectory)
  )
    return env;
  try {
    const response = await fetcher(`${env.XANGI_TOOL_SERVER}/github-token`, {
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    if (
      response.status === 404 &&
      (await response.json()).error === "GitHub App is not configured"
    ) {
      return {
        ...env,
        PATH: env.PATH.split(":")
          .filter((part) => part !== wrapperDirectory)
          .join(":"),
      };
    }
    await response.body?.cancel();
  } catch {
    /* Keep the configured auth path on network/authentication errors. */
  }
  return env;
}
let environment;
export async function githubCli(args, maxBuffer = 2 * 1024 * 1024) {
  environment ??= githubCliEnvironment();
  return (
    await exec("gh", args, {
      env: await environment,
      encoding: "utf8",
      maxBuffer,
      timeout: 30_000,
    })
  ).stdout;
}
