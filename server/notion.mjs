import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ApiError, atomicWrite, changeSetKey, versionOf } from "./store.mjs";

import { Documents } from "./documents.mjs";
import { notionPayload, blockBatches } from "./notion-content.mjs";
export { notionPayload } from "./notion-content.mjs";

export function existingNotionToken({
  env = process.env,
  home = homedir(),
} = {}) {
  if (env.XANGI_REVIEW_NOTION_TOKEN?.trim())
    return env.XANGI_REVIEW_NOTION_TOKEN.trim();
  try {
    return readFileSync(resolve(home, ".config/notion/api_key"), "utf8").trim();
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw new ApiError(
      503,
      "既存のNotion認証ファイルを読み込めません。サーバー側のアクセス権限を確認してください。",
    );
  }
}
export function savedNotionSettings(stateDir) {
  try {
    return JSON.parse(
      readFileSync(resolve(stateDir, "notion-settings.json"), "utf8"),
    );
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new ApiError(503, "Notion保存先の設定ファイルを確認してください。");
  }
}
export function savedNotionParent(stateDir) {
  return savedNotionSettings(stateDir).parentPageId;
}
export function notionParentId(value) {
  if (typeof value !== "string")
    throw new ApiError(
      400,
      "Notionの保存先ページURLまたはIDを入力してください。",
    );
  let candidate = value.trim();
  if (candidate.startsWith("https://")) {
    let url;
    try {
      url = new URL(candidate);
    } catch {
      throw new ApiError(400, "NotionのURLが正しくありません。");
    }
    if (!/^(?:[a-z0-9-]+\.)?notion\.(?:so|com)$/.test(url.hostname))
      throw new ApiError(400, "NotionのページURLを指定してください。");
    candidate = url.pathname.replace(/\/$/, "").split("/").pop();
  }
  const id =
    /([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(
      candidate,
    )?.[1];
  if (!id)
    throw new ApiError(
      400,
      "Notionの保存先ページURLまたはIDを確認してください。",
    );
  return id.replaceAll("-", "");
}
export class NotionExport {
  constructor(
    store,
    {
      token = existingNotionToken(),
      parent = process.env.XANGI_REVIEW_NOTION_PARENT_PAGE_ID ||
        savedNotionParent(store.stateDir),
      fetcher = fetch,
      imageReader = (id) => new Documents(store).image(id),
    } = {},
  ) {
    this.store = store;
    const saved = savedNotionSettings(store.stateDir);
    this.token = token || saved.token || "";
    this.tokenLocked = Boolean(process.env.XANGI_REVIEW_NOTION_TOKEN);
    this.parentLocked = Boolean(process.env.XANGI_REVIEW_NOTION_PARENT_PAGE_ID);
    if (!this.tokenLocked && saved.token) this.token = saved.token;
    this.parent = parent;
    let lastRequest = 0;
    this.fetcher = async (...args) => {
      if (fetcher === fetch) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, 350 - (Date.now() - lastRequest))),
        );
        lastRequest = Date.now();
      }
      return fetcher(...args);
    };
    this.imageReader = imageReader;
    this.file = resolve(store.stateDir, "notion-exports.json");
    this.pending = Promise.resolve();
  }
  settings() {
    return {
      configured: this.configured(),
      hasToken: Boolean(this.token),
      parentPageId: this.parent ?? "",
      tokenLocked: this.tokenLocked,
      parentLocked: this.parentLocked,
    };
  }
  configure(body) {
    const result = this.pending.then(async () => {
      if (!body || typeof body !== "object")
        throw new ApiError(400, "設定を指定してください。");
      if (this.parentLocked)
        throw new ApiError(409, "保存先は管理者の環境変数で固定されています。");
      const parentPageId = notionParentId(body.parentPageId);
      if (
        body.token !== undefined &&
        (typeof body.token !== "string" ||
          body.token.length > 4096 ||
          /[\r\n]/.test(body.token))
      )
        throw new ApiError(400, "認証キーの形式を確認してください。");
      if (body.token?.trim() && this.tokenLocked)
        throw new ApiError(
          409,
          "認証キーは管理者の環境変数で固定されています。",
        );
      const saved = savedNotionSettings(this.store.stateDir);
      const token = body.token?.trim() || saved.token;
      await atomicWrite(
        resolve(this.store.stateDir, "notion-settings.json"),
        JSON.stringify({ parentPageId, ...(token ? { token } : {}) }),
      );
      this.parent = parentPageId;
      if (body.token?.trim()) this.token = body.token.trim();
      return this.settings();
    });
    this.pending = result.catch(() => {});
    return result;
  }
  checkConnection() {
    const result = this.pending.then(async () => {
      if (!this.configured())
        throw new ApiError(
          400,
          "認証キーと保存先を設定してから接続を確認してください。",
        );
      let response;
      try {
        response = await this.fetcher(
          `https://api.notion.com/v1/pages/${this.parent}`,
          {
            headers: {
              Authorization: `Bearer ${this.token}`,
              "Notion-Version": "2026-03-11",
            },
            signal: AbortSignal.timeout(15000),
          },
        );
      } catch {
        throw new ApiError(
          502,
          "Notionに接続できませんでした。時間をおいて再確認してください。",
        );
      }
      if (!response.ok)
        throw new ApiError(
          400,
          response.status === 404 || response.status === 403
            ? "保存先を参照できません。ページURLとNotionの『接続』で認証キーの連携が許可されているか確認してください。"
            : response.status === 401
              ? "認証キーが無効です。設定を確認してください。"
              : `Notionの接続確認に失敗しました（HTTP ${response.status}）。`,
        );
      const page = await response.json();
      if (page.archived || page.in_trash)
        throw new ApiError(
          400,
          "保存先がゴミ箱にあります。別のページを指定してください。",
        );
      return {
        ok: true,
        message:
          "保存先ページを参照できました。書き込み権限は実際の保存時に確認します。",
      };
    });
    this.pending = result.catch(() => {});
    return result;
  }
  configured() {
    return Boolean(
      this.token &&
      /^[a-f0-9]{32}$/i.test((this.parent ?? "").replaceAll("-", "")),
    );
  }
  save(id) {
    const result = this.pending.then(() => this.perform(id));
    this.pending = result.catch(() => {});
    return result;
  }
  async perform(id) {
    if (!this.configured())
      throw new ApiError(
        503,
        "Notion保存は未設定です。サーバーのトークンと保存先ページIDを設定してください。",
      );
    const selected = this.store.find(id);
    const reviews = selected.changeSet
      ? this.store
          .list({ includeArchived: true })
          .filter(
            (r) =>
              changeSetKey(r.changeSet) === changeSetKey(selected.changeSet) &&
              r.changeSet?.revision === selected.changeSet.revision,
          )
      : [this.store.summary(selected)];
    reviews.sort(
      (a, b) =>
        (a.document?.page ?? 0) - (b.document?.page ?? 0) ||
        a.file.localeCompare(b.file),
    );
    const fullReviews = await Promise.all(
      reviews.map((r) => this.store.get(r.id)),
    );
    const payload = notionPayload(fullReviews, this.parent);
    const imageHashes = [];
    for (const r of fullReviews)
      if (r.document) imageHashes.push(versionOf(await this.imageReader(r.id)));
    const key = versionOf(JSON.stringify({ format: 2, payload, imageHashes }));
    let exports = {};
    try {
      exports = JSON.parse(await readFile(this.file, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (exports[key]?.url && exports[key].status === "saved")
      return exports[key];
    if (exports[key])
      throw new ApiError(
        409,
        "前回のNotion保存結果が不明です。重複を避けるため再送していません。Notionとnotion-exports.jsonを確認してください。",
      );
    const persist = () => atomicWrite(this.file, JSON.stringify(exports));
    exports[key] = { status: "pending", at: new Date().toISOString() };
    await persist();
    // Persist pending before uploading or writing; ambiguous writes are never retried.
    for (const block of payload.children) {
      if (block.type !== "image") continue;
      const reviewId = block.image.file_upload.id.slice("pending:".length);
      const bytes = await this.imageReader(reviewId);
      if (bytes.length > 20 * 1024 * 1024)
        throw new ApiError(413, "ページ画像がNotionの20MB上限を超えています。");
      const headers = {
        Authorization: `Bearer ${this.token}`,
        "Notion-Version": "2026-03-11",
      };
      const created = await this.fetcher(
        "https://api.notion.com/v1/file_uploads",
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: `page-${reviewId}.png`,
            content_type: "image/png",
          }),
          signal: AbortSignal.timeout(20000),
        },
      );
      if (!created.ok)
        throw new ApiError(
          502,
          `Notion画像準備に失敗しました（HTTP ${created.status}）。再送せず保存状態を確認してください。`,
        );
      const upload = await created.json();
      if (!/^[a-zA-Z0-9-]+$/.test(upload.id ?? ""))
        throw new ApiError(502, "Notion画像の識別子を確認できません。");
      const body = new FormData();
      body.append("file", new Blob([bytes], { type: "image/png" }), "page.png");
      const sent = await this.fetcher(
        `https://api.notion.com/v1/file_uploads/${upload.id}/send`,
        { method: "POST", headers, body, signal: AbortSignal.timeout(60000) },
      );
      if (!sent.ok || (await sent.json()).status !== "uploaded")
        throw new ApiError(
          502,
          "Notion画像の転送を確認できません。再送せず保存状態を確認してください。",
        );
      block.image.file_upload.id = upload.id;
    }
    const batches = blockBatches(payload.children);
    let response;
    try {
      response = await this.fetcher("https://api.notion.com/v1/pages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Notion-Version": "2026-03-11",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...payload, children: batches[0] }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ApiError(
        502,
        "Notionとの通信が中断しました。保存済みの可能性があるため自動再送しません。Notionを確認してください。",
      );
    }
    if (!response.ok) {
      // Definite rejection is safe to retry manually; ambiguous writes remain pending.
      if (response.status < 500) {
        delete exports[key];
        await persist();
      }
      const retry = response.headers.get("retry-after");
      throw new ApiError(
        502,
        `Notion保存に失敗しました（HTTP ${response.status}）${retry ? `。${retry}秒以上待ってください` : "。接続権限・保存先・Notion側の状態を確認してください"}。`,
      );
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new ApiError(
        502,
        "Notion応答を読み取れません。再送せずNotionを確認してください。",
      );
    }
    if (
      !result.id ||
      !/^https:\/\/((www\.)?notion\.(so|site)|app\.notion\.com)\//.test(
        result.url ?? "",
      )
    )
      throw new ApiError(
        502,
        "Notionの保存先URLを確認できません。再送せずNotionを確認してください。",
      );
    exports[key] = {
      status: "pending",
      id: result.id,
      url: result.url,
      at: new Date().toISOString(),
    };
    await persist();
    for (const children of batches.slice(1)) {
      const appended = await this.fetcher(
        `https://api.notion.com/v1/blocks/${encodeURIComponent(result.id)}/children`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Notion-Version": "2026-03-11",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ children }),
          signal: AbortSignal.timeout(20000),
        },
      );
      if (!appended.ok)
        throw new ApiError(
          502,
          `Notionへの保存が途中で止まりました。再送せずページを確認してください: ${result.url}`,
        );
    }
    exports[key] = {
      status: "saved",
      id: result.id,
      url: result.url,
      at: new Date().toISOString(),
    };
    await persist();
    return exports[key];
  }
}
