import { DraftStore } from "./drafts.mjs";
import { HtmlPreviews, PREVIEW_CSP, previewFiles } from "./html-previews.mjs";
import {
  importGitHubRepository,
  parseGitHubRepository,
} from "./github-repository.mjs";
import { githubDescription } from "./github-import.mjs";
import { normalizeReviewContext } from "../shared/review-context.mjs";
import { parseGoogleDocument } from "./document-sources.mjs";
import { Documents, PDF_MAX_BYTES } from "./documents.mjs";
import { NotionExport } from "./notion.mjs";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { ApiError, MAX_BYTES, changeSetKey } from "./store.mjs";
import {
  importGitHubPullRequest,
  parseGitHubPullRequest,
} from "./github-import.mjs";

const sameToken = (actual, expected) => {
  const a = Buffer.from(actual ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};
async function jsonBody(req) {
  if (!String(req.headers["content-type"]).startsWith("application/json"))
    throw new ApiError(415, "JSON形式で送信してください。");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BYTES * 7)
      throw new ApiError(413, "送信内容が大きすぎます。");
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("Expected object");
    return body;
  } catch {
    throw new ApiError(400, "送信内容を読み取れません。");
  }
}

export function createServer({
  store,
  token,
  distDir,
  importPullRequest = importGitHubPullRequest,
  importRepository = importGitHubRepository,
  reviewJobs,
  artifactRequests,
  documents = new Documents(store),
  notion = new NotionExport(store),
}) {
  const drafts = new DraftStore(store.stateDir);
  const htmlPreviews = new HtmlPreviews();
  const notionJobs = new Map();
  const importJobs = new Map();
  const pdfJobs = new Map();
  const pdfUploads = new Map();
  const runningImports = new Map();
  return http.createServer(async (req, res) => {
    const json = (status, value) => {
      let body = JSON.stringify(value);
      const query = new URL(req.url, "http://localhost").searchParams;
      if (
        status === 200 &&
        req.method === "GET" &&
        /^\/api\/(reviews|preferences|review-jobs)(\?|$)/.test(req.url) &&
        query.get("poll") === "1"
      ) {
        const revision = createHash("sha256").update(body).digest("hex");
        body = JSON.stringify(
          query.get("since") === revision
            ? { revision, unchanged: true }
            : { revision, data: value },
        );
      }
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(body);
    };
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/health" && req.method === "GET")
        return json(200, { ok: true, app: "xangi-studio" });
      const htmlPreview = /^\/html-preview\/([a-f0-9]{48})$/.exec(url.pathname);
      if (htmlPreview) {
        if (!["GET", "HEAD"].includes(req.method))
          throw new ApiError(405, "この操作は対応していません。");
        const content = htmlPreviews.read(htmlPreview[1]);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": PREVIEW_CSP,
          "Cache-Control": "no-store",
        });
        return res.end(req.method === "HEAD" ? undefined : content);
      }
      if (
        url.pathname.startsWith("/api/") ||
        url.pathname === "/import/github"
      ) {
        if (!sameToken(req.headers.authorization, `Bearer ${token}`))
          return json(401, { error: "招待リンクから開いてください。" });
        if (req.headers["sec-fetch-site"] === "cross-site")
          throw new ApiError(403, "この操作は許可されていません。");
        if (url.pathname === "/api/html-previews" && req.method === "POST")
          return json(201, htmlPreviews.create((await jsonBody(req)).content));
        const previewFileMatch =
          /^\/api\/reviews\/([\w-]{1,100})\/preview-files$/.exec(url.pathname);
        if (previewFileMatch && req.method === "GET")
          return json(200, await previewFiles(store, previewFileMatch[1]));
        const draftMatch = /^\/api\/drafts\/(review)\/([\w-]{1,100})$/.exec(
          url.pathname,
        );
        if (draftMatch) {
          res.setHeader("Cache-Control", "no-store");
          const [, scope, id] = draftMatch;
          const target = await store.get(id);
          if (target.readOnly)
            throw new ApiError(403, "このファイルは閲覧専用です。");
          if (req.method === "GET")
            return json(200, await drafts.read(scope, id));
          if (req.method === "PUT")
            return json(200, await drafts.save(scope, id, await jsonBody(req)));
          if (req.method === "DELETE")
            return json(200, await drafts.remove(scope, id));
          throw new ApiError(405, "この操作は対応していません。");
        }
        if (url.pathname === "/api/request-options" && req.method === "GET") {
          if (!artifactRequests)
            throw new ApiError(503, "xangi接続が未設定です。");
          return json(200, await artifactRequests.host.options());
        }
        const requestMatch = /^\/api\/reviews\/([\w-]{1,100})\/requests$/.exec(
          url.pathname,
        );
        if (requestMatch) {
          if (!artifactRequests)
            throw new ApiError(503, "xangi接続が未設定です。");
          await store.get(requestMatch[1]);
          if (req.method === "GET")
            return json(200, artifactRequests.list(requestMatch[1]));
          if (req.method === "POST")
            return json(
              202,
              await artifactRequests.submit(
                requestMatch[1],
                await jsonBody(req),
              ),
            );
          throw new ApiError(405, "この操作は対応していません。");
        }
        if (url.pathname === "/api/notion" && req.method === "GET")
          return json(
            200,
            notion.settings
              ? notion.settings()
              : { configured: notion.configured() },
          );
        if (url.pathname === "/api/notion/settings" && req.method === "POST")
          return json(200, await notion.configure(await jsonBody(req)));
        if (url.pathname === "/api/notion/check" && req.method === "POST")
          return json(200, await notion.checkConnection());
        const notionMatch = /^\/api\/reviews\/([a-zA-Z0-9-]+)\/notion$/.exec(
          url.pathname,
        );
        if (notionMatch && req.method === "POST") {
          const reviewId = notionMatch[1];
          store.find(reviewId);
          let job = [...notionJobs.values()].find(
            (j) => j.reviewId === reviewId && j.status === "running",
          );
          if (!job) {
            for (const [key, value] of notionJobs)
              if (value.status !== "running" && notionJobs.size >= 100)
                notionJobs.delete(key);
            job = { id: randomUUID(), reviewId, status: "running" };
            notionJobs.set(job.id, job);
            const active = job;
            void notion
              .save(reviewId)
              .then((result) => {
                active.status = "completed";
                active.url = result.url;
              })
              .catch((e) => {
                active.status = "failed";
                active.error = e.message;
              });
          }
          return json(202, job);
        }
        const notionJobMatch = /^\/api\/notion\/jobs\/([a-zA-Z0-9-]+)$/.exec(
          url.pathname,
        );
        if (notionJobMatch && req.method === "GET") {
          const job = notionJobs.get(notionJobMatch[1]);
          if (!job)
            throw new ApiError(
              404,
              "保存ジョブが見つかりません。再送せずNotionの保存状態を確認してください。",
            );
          return json(200, job);
        }
        const pageMatch = /^\/api\/reviews\/([a-zA-Z0-9-]+)\/page$/.exec(
          url.pathname,
        );
        if (pageMatch && req.method === "GET") {
          const bytes = await documents.image(pageMatch[1]);
          res.writeHead(200, {
            "Content-Type": "image/png",
            "Cache-Control": "no-store",
          });
          return res.end(bytes);
        }
        const descriptionMatch =
          /^\/api\/reviews\/([a-zA-Z0-9-]+)\/github-description$/.exec(
            url.pathname,
          );
        if (descriptionMatch && req.method === "GET") {
          const current = store.find(descriptionMatch[1]);
          if (current.changeSet?.kind !== "github-pr")
            throw new ApiError(400, "GitHub PRを選んでください。");
          return json(200, await githubDescription(current.changeSet.url));
        }
        const contextMatch = /^\/api\/reviews\/([a-zA-Z0-9-]+)\/context$/.exec(
          url.pathname,
        );
        if (contextMatch && req.method === "PUT") {
          const body = await jsonBody(req);
          const reviewContext = normalizeReviewContext(body.reviewContext);
          if (reviewContext === undefined)
            throw new ApiError(400, "レビュー指示を指定してください。");
          const current = store.find(contextMatch[1]);
          if (
            !current.changeSet ||
            current.supersededAt ||
            current.changeSet.revision !== body.revision
          )
            throw new ApiError(
              409,
              "対象の版が変わりました。更新を確認してください。",
            );
          await store.setImportReviewContext({
            ...current.changeSet,
            reviewContext,
          });
          return json(200, await store.get(current.id));
        }
        const promptMatch = /^\/api\/reviews\/([a-zA-Z0-9-]+)\/prompt$/.exec(
          url.pathname,
        );
        if (promptMatch && req.method === "GET")
          return json(200, await documents.prompt(promptMatch[1]));
        if (url.pathname === "/api/import/pdf" && req.method === "POST") {
          if ([...pdfJobs.values()].some((j) => j.status === "running"))
            throw new ApiError(409, "別のPDFを変換中です。");
          for (const [key, upload] of pdfUploads)
            if (Date.now() - upload.at > 300_000) pdfUploads.delete(key);
          const {
            name,
            uploadId,
            index,
            total,
            data,
            reviewContext: inputContext,
          } = await jsonBody(req);
          const reviewContext = normalizeReviewContext(inputContext);
          if (
            typeof name !== "string" ||
            !/\.(pdf|pptx|docx|doc)$/i.test(name) ||
            !Number.isInteger(index) ||
            !Number.isInteger(total) ||
            total < 1 ||
            total > Math.ceil(PDF_MAX_BYTES / (384 * 1024)) ||
            index < 0 ||
            index >= total ||
            typeof data !== "string" ||
            data.length > 524288 ||
            data.length % 4 !== 0 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
          )
            throw new ApiError(
              400,
              "PDFアップロードの内容が正しくありません。",
            );
          let upload = pdfUploads.get(uploadId);
          if (index === 0 && !uploadId) {
            if (pdfUploads.size)
              throw new ApiError(
                409,
                "別のPDFをアップロード中です。中断した場合は5分後に再試行してください。",
              );
            upload = {
              id: randomUUID(),
              name,
              total,
              chunks: [],
              reviewContext,
              size: 0,
              at: Date.now(),
            };
            pdfUploads.set(upload.id, upload);
          }
          if (
            !upload ||
            upload.name !== name ||
            upload.total !== total ||
            upload.chunks.length !== index
          )
            throw new ApiError(
              409,
              "PDFアップロードの順序が一致しません。再度取り込んでください。",
            );
          const chunk = Buffer.from(data, "base64");
          upload.size += chunk.length;
          if (upload.size > PDF_MAX_BYTES) {
            pdfUploads.delete(upload.id);
            throw new ApiError(413, "PDFの上限は100MBです。");
          }
          upload.chunks.push(chunk);
          upload.at = Date.now();
          if (index + 1 < total) return json(202, { uploadId: upload.id });
          pdfUploads.delete(upload.id);
          const id = randomUUID();
          const job = { id, status: "running" };
          for (const [key, previous] of pdfJobs)
            if (
              previous.finishedAt &&
              Date.now() - previous.finishedAt > 600_000
            )
              pdfJobs.delete(key);
          pdfJobs.set(id, job);
          void documents
            .import(
              name,
              Buffer.concat(upload.chunks),
              undefined,
              upload.reviewContext,
            )
            .then((result) => {
              job.status = "completed";
              job.result = result;
              job.finishedAt = Date.now();
            })
            .catch((error) => {
              job.status = "failed";
              job.error = error.message;
              job.finishedAt = Date.now();
            });
          return json(202, { id, uploadId: upload.id });
        }
        if (url.pathname === "/api/import/google" && req.method === "POST") {
          const { url: sourceUrl, reviewContext: inputContext } =
            await jsonBody(req);
          const reviewContext = normalizeReviewContext(inputContext);
          parseGoogleDocument(sourceUrl);
          if (
            [...pdfJobs.values()].some((j) => j.status === "running") ||
            pdfUploads.size
          )
            throw new ApiError(409, "別の資料を取り込み中です。");
          const id = randomUUID();
          const job = { id, status: "running" };
          pdfJobs.set(id, job);
          void documents
            .import("google.pdf", null, sourceUrl, reviewContext)
            .then((result) => {
              job.result = result;
              job.status = "completed";
            })
            .catch((e) => {
              job.status = "failed";
              job.error = e.message;
            })
            .finally(() => {
              job.finishedAt = Date.now();
            });
          return json(202, { id });
        }
        const pdfJob = /^\/api\/import\/pdf\/jobs\/([a-f0-9-]+)$/.exec(
          url.pathname,
        );
        if (pdfJob && req.method === "GET") {
          const job = pdfJobs.get(pdfJob[1]);
          if (!job)
            throw new ApiError(
              404,
              "PDFの取り込み状態が見つかりません。一覧で結果を確認してください。",
            );
          return json(200, job);
        }
        if (url.pathname === "/api/reviews") {
          if (req.method === "GET")
            return json(
              200,
              url.searchParams.get("summary") === "home"
                ? store
                    .list()
                    .map(
                      ({
                        id,
                        title,
                        file,
                        createdAt,
                        document,
                        changeSet,
                      }) => ({
                        id,
                        title,
                        file,
                        createdAt,
                        document,
                        changeSet: changeSet
                          ? {
                              kind: changeSet.kind,
                              id: changeSet.id,
                              source: changeSet.source,
                              title: changeSet.title,
                              revision: changeSet.revision,
                            }
                          : undefined,
                      }),
                    )
                : store.list(),
            );
          if (req.method === "POST") {
            const {
              file,
              title,
              source,
              sourceUrl,
              before,
              content,
              readOnly,
              changeSet,
              explanations,
            } = await jsonBody(req);
            return json(
              201,
              await store.create({
                file,
                title,
                source,
                sourceUrl,
                before,
                content,
                readOnly,
                changeSet,
                explanations,
              }),
            );
          }
        }
        if (url.pathname === "/api/review-jobs") {
          if (!reviewJobs)
            throw new ApiError(
              503,
              "AIレビューはManaged Extensionで利用してください。",
            );
          if (req.method === "GET") return json(200, reviewJobs.list());
          if (req.method === "POST") {
            const {
              changeSet,
              sessionId,
              reviewer,
              file,
              purpose,
              files,
              group,
            } = await jsonBody(req);
            return json(
              202,
              await reviewJobs.register(changeSet, sessionId, reviewer, file, {
                purpose,
                files,
                group,
              }),
            );
          }
        }
        if (url.pathname === "/api/preferences") {
          if (req.method === "GET") return json(200, store.reviewPreferences());
          if (req.method === "PUT")
            return json(
              200,
              await store.updateReviewPreferences(await jsonBody(req)),
            );
        }
        if (
          url.pathname === "/api/change-sets/archive" &&
          req.method === "POST"
        ) {
          const { key, archived = true } = await jsonBody(req);
          return json(200, await store.setChangeSetArchived(key, archived));
        }
        if (
          url.pathname === "/api/import/github/analysis" &&
          req.method === "POST"
        ) {
          const { changeSet, analysis } = await jsonBody(req);
          return json(
            200,
            await store.applyImportAnalysis(changeSet, analysis),
          );
        }
        if (
          ["/api/import/github", "/import/github"].includes(url.pathname) &&
          req.method === "POST"
        ) {
          const {
            url: pullRequestUrl,
            analysis,
            reviewContext: inputContext,
          } = await jsonBody(req);
          const reviewContext = normalizeReviewContext(inputContext);
          const isPr = /\/pull\/\d+\/?$/.test(String(pullRequestUrl));
          if (isPr) parseGitHubPullRequest(pullRequestUrl);
          else parseGitHubRepository(pullRequestUrl);
          const key = JSON.stringify([
            pullRequestUrl,
            analysis ?? {},
            reviewContext,
          ]);
          const activeId = runningImports.get(key);
          if (activeId) return json(202, { id: activeId });
          if (
            [...runningImports.keys()].some(
              (entry) =>
                JSON.parse(entry)[0].replace(/\/$/, "") ===
                pullRequestUrl.replace(/\/$/, ""),
            )
          )
            throw new ApiError(
              409,
              "同じ取り込み元を別の指示で取り込み中です。完了後に再試行してください。",
            );
          for (const [jobId, previous] of importJobs) {
            if (
              previous.finishedAt &&
              Date.now() - previous.finishedAt > 600_000
            )
              importJobs.delete(jobId);
          }
          const id = randomUUID();
          const job = { id, status: "running", startedAt: Date.now() };
          importJobs.set(id, job);
          runningImports.set(key, id);
          void (isPr ? importPullRequest : importRepository)(
            store,
            pullRequestUrl,
            analysis,
            undefined,
            reviewContext,
          )
            .then((result) => {
              job.status = "completed";
              job.result = {
                status: result.status,
                imported: result.imported.map(({ id }) => ({ id })),
                skipped: result.skipped,
              };
            })
            .catch((error) => {
              job.status = "failed";
              job.error =
                error instanceof Error ? error.message : String(error);
            })
            .finally(() => {
              job.finishedAt = Date.now();
              runningImports.delete(key);
            });
          return json(202, { id });
        }
        const importJobMatch =
          /^\/api\/import\/github\/jobs\/([a-f0-9-]+)$/.exec(url.pathname);
        if (importJobMatch && req.method === "GET") {
          const job = importJobs.get(importJobMatch[1]);
          if (!job) throw new ApiError(404, "取り込み状態が見つかりません。");
          return json(200, job);
        }
        const match =
          /^\/api\/reviews\/([a-zA-Z0-9-]+)(?:\/history\/([a-zA-Z0-9-]+))?$/.exec(
            url.pathname,
          );
        if (match) {
          if (req.method === "DELETE" && !match[2]) {
            const current = store.find(match[1]);
            const activeRequest = (
              artifactRequests?.list(current.id) ?? []
            ).some((request) =>
              ["dispatching", "queued", "running"].includes(request.status),
            );
            const activeReview =
              current.changeSet &&
              (reviewJobs?.list() ?? []).some(
                (job) =>
                  job.status === "running" &&
                  changeSetKey(job.changeSet) ===
                    changeSetKey(current.changeSet),
              );
            const activeExport = [...notionJobs.values()].some(
              (job) => job.reviewId === current.id && job.status === "running",
            );
            if (activeRequest || activeReview || activeExport)
              throw new ApiError(
                409,
                "実行中の成果物は削除できません。完了後に削除してください。",
              );
            return json(200, await store.remove(current.id));
          }
          if (req.method === "GET")
            return json(
              200,
              match[2]
                ? store.snapshot(match[1], match[2])
                : await store.get(match[1]),
            );
          if (req.method === "PUT" && !match[2]) {
            const body = await jsonBody(req);
            const next = await store.save(match[1], body.content);
            await drafts.save("review", match[1], { content: next.content });
            return json(200, next);
          }
        }
        throw new ApiError(404, "操作が見つかりません。");
      }
      if (req.method !== "GET" && req.method !== "HEAD")
        throw new ApiError(405, "この操作は対応していません。");
      const isAsset = /^\/assets\/[a-zA-Z0-9._-]+$/.test(url.pathname);
      const file = isAsset
        ? resolve(distDir, `.${url.pathname}`)
        : resolve(distDir, "index.html");
      const bytes = await readFile(file);
      const types = {
        ".js": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".svg": "image/svg+xml",
      };
      const script =
        extname(file) === ".html"
          ? /<script type="module">([\s\S]*?)<\/script>/.exec(
              bytes.toString(),
            )?.[1]
          : null;
      const scriptHash = script
        ? ` 'sha256-${createHash("sha256").update(script).digest("base64")}'`
        : "";
      res.setHeader(
        "Content-Security-Policy",
        `default-src 'self'; script-src 'self'${scriptHash}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'`,
      );
      res.writeHead(200, {
        "Content-Type": `${types[extname(file)] ?? "application/octet-stream"}; charset=utf-8`,
        "Cache-Control": isAsset
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : bytes);
    } catch (error) {
      if (res.headersSent) return res.end();
      const status = error.status ?? (error.code === "ENOENT" ? 404 : 500);
      if (status === 500) console.error(error);
      json(status, {
        error:
          status === 500
            ? "処理に失敗しました。編集内容を残して、もう一度お試しください。"
            : error.message,
      });
    }
  });
}
