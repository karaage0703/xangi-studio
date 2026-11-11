import { readFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ApiError, atomicWrite } from "./store.mjs";

// The extension has one process per data directory; serialize all draft mutations.
export class DraftStore {
  constructor(stateDir) {
    this.root = join(stateDir, "drafts");
    this.pending = Promise.resolve();
  }
  path(scope, id) {
    if (scope !== "review" || !/^[\w-]{1,100}$/.test(id))
      throw new ApiError(400, "下書きの対象が正しくありません。");
    return join(this.root, `${scope}-${id}.json`);
  }
  async read(scope, id) {
    try {
      return JSON.parse(await readFile(this.path(scope, id), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
  mutate(fn) {
    const task = this.pending.then(fn);
    this.pending = task.catch(() => {});
    return task;
  }
  save(scope, id, { content }) {
    return this.mutate(async () => {
      if (
        typeof content !== "string" ||
        Buffer.byteLength(content) > 1024 * 1024
      )
        throw new ApiError(400, "下書きは1MiB以内の本文を指定してください。");
      const draft = { content, updatedAt: new Date().toISOString() };
      await mkdir(this.root, { recursive: true });
      await atomicWrite(this.path(scope, id), JSON.stringify(draft));
      return draft;
    });
  }
  remove(scope, id) {
    return this.mutate(async () => {
      try {
        await unlink(this.path(scope, id));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      return { ok: true };
    });
  }
}
