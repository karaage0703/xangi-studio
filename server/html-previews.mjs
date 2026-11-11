import { randomBytes } from "node:crypto";
import { extname } from "node:path";
import { ApiError, changeSetKey } from "./store.mjs";

export const MAX_PREVIEW_BYTES = 1024 * 1024;
export const PREVIEW_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline' data:",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

export class HtmlPreviews {
  constructor({ now = Date.now, ttl = 10 * 60_000, limit = 20 } = {}) {
    this.items = new Map();
    this.now = now;
    this.ttl = ttl;
    this.limit = limit;
  }
  create(content) {
    if (typeof content !== "string")
      throw new ApiError(400, "HTML本文が必要です。");
    if (Buffer.byteLength(content) > MAX_PREVIEW_BYTES)
      throw new ApiError(413, "HTMLプレビューの上限は1MBです。");
    for (const [key, item] of this.items)
      if (item.expires <= this.now()) this.items.delete(key);
    while (this.items.size >= this.limit)
      this.items.delete(this.items.keys().next().value);
    const id = randomBytes(24).toString("hex");
    this.items.set(id, { content, expires: this.now() + this.ttl });
    return { path: `/html-preview/${id}` };
  }
  read(id) {
    const item = this.items.get(id);
    if (!item || item.expires <= this.now()) {
      this.items.delete(id);
      throw new ApiError(
        404,
        "プレビューの期限が切れました。再読み込みしてください。",
      );
    }
    return item.content;
  }
}

export async function previewFiles(store, id) {
  const selected = store.find(id);
  if (!/\.html?$/i.test(selected.file) || selected.document)
    throw new ApiError(400, "HTMLファイルを選んでください。");
  // Only registered files in this exact import/revision are available. Never
  // follow paths from HTML into the filesystem or fetch external resources.
  const related = selected.changeSet
    ? store
        .list({ includeArchived: true })
        .filter(
          (item) =>
            item.id !== id &&
            changeSetKey(item.changeSet) === changeSetKey(selected.changeSet) &&
            item.changeSet?.revision === selected.changeSet.revision &&
            [".css", ".js", ".mjs", ".svg"].includes(
              extname(item.file).toLowerCase(),
            ),
        )
    : [];
  const files = [];
  let bytes = 0;
  for (const item of related) {
    const { content } = await store.get(item.id);
    bytes += Buffer.byteLength(content);
    if (bytes > MAX_PREVIEW_BYTES)
      throw new ApiError(
        413,
        "関連ファイルの合計が1MBを超えています。単体HTMLを開いてください。",
      );
    files.push({ file: item.file, content });
  }
  return { files };
}
