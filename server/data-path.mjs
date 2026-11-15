import { homedir } from "node:os";
import { resolve } from "node:path";

export function managedDataDir(env = process.env) {
  if (env.XANGI_REVIEW_DATA_DIR) return resolve(env.XANGI_REVIEW_DATA_DIR);
  const instance = (env.XANGI_EXTENSION_INSTANCE_ID ?? "default").replace(
    /[^a-zA-Z0-9._-]/g,
    "-",
  );
  return resolve(
    env.XDG_STATE_HOME || resolve(homedir(), ".local/state"),
    "xangi-studio",
    `instance-${instance}`,
  );
}
