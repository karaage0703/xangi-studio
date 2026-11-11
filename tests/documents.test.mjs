import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readFile,
  mkdir,
  writeFile,
  symlink,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewStore } from "../server/store.mjs";
import { Documents, PDF_MAX_BYTES } from "../server/documents.mjs";
import { ReviewJobs } from "../server/review-jobs.mjs";
import { createServer } from "../server/http.mjs";
import { samplePdf } from "./helpers/pdf.mjs";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pdf-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new ReviewStore(
    join(root, "files"),
    join(root, "state"),
  ).init();
  return { root, store, documents: new Documents(store) };
}
test("real PDF pages, images and complete review survive reopening without modifying original", async (t) => {
  const { root, store, documents } = await fixture(t);
  const bytes = samplePdf();
  const result = await documents.import(
    "slides.pdf",
    bytes,
    undefined,
    "初心者向けに確認。参考資料:仕様の抜粋",
  );
  assert.equal(result.imported.length, 2);
  const first = await store.get(result.imported[0].id);
  assert.equal(first.document.page, 1);
  assert.match(first.content, /Page 1/);
  assert.deepEqual(
    await readFile(
      join(store.stateDir, "documents", first.document.id, "original.pdf"),
    ),
    bytes,
  );
  assert.equal(
    (await documents.image(first.id)).subarray(1, 4).toString(),
    "PNG",
  );
  const prompt = (await documents.prompt(first.id)).prompt;
  assert.match(prompt, /初心者向けに確認。参考資料:仕様の抜粋/);
  assert.match(prompt, /page-1.png/);
  assert.match(prompt, /page-2.png/);
  assert.match(prompt, /見た目は未確認/);
  await assert.rejects(store.save(first.id, "edited", first.version), {
    status: 403,
  });
  await assert.rejects(
    store.applyImportAnalysis(first.changeSet, {
      [first.file]: [{ review: "partial" }],
    }),
    /一部ページ/,
  );
  const transcripts = join(root, "logs");
  await mkdir(transcripts);
  const jobs = await new ReviewJobs(store, transcripts).init();
  await jobs.register(first.changeSet, "pdf_session");
  const files = Object.fromEntries(
    store.list().map((r) => [
      r.file,
      [
        {
          heading: `${r.document.page}ページ`,
          review: "Layout checked",
          severity: "warning",
        },
      ],
    ]),
  );
  await writeFile(
    join(transcripts, "pdf_session.jsonl"),
    [
      JSON.stringify({ role: "user", content: prompt }),
      JSON.stringify({
        role: "assistant",
        content: { result: JSON.stringify({ files }) },
      }),
    ].join("\n"),
  );
  const reopened = await new ReviewStore(store.root, store.stateDir).init();
  const recovered = await new ReviewJobs(reopened, transcripts).init();
  assert.equal(recovered.list()[0].status, "completed");
  assert.equal(recovered.list()[0].result.updated, 2);
  assert.equal(
    (await reopened.get(first.id)).explanations[0].review,
    "Layout checked",
  );
});
test("invalid format, corrupt PDF, page/byte limits leave no partial reviews", async (t) => {
  const { store, documents } = await fixture(t);
  await assert.rejects(documents.import("slides.pptx", samplePdf()), {
    status: 415,
  });
  await assert.rejects(
    documents.import("bad.pdf", Buffer.from("%PDF-invalid")),
    { status: 422 },
  );
  await assert.rejects(
    documents.import(
      "large.pdf",
      Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(PDF_MAX_BYTES)]),
    ),
    { status: 413 },
  );
  await assert.rejects(documents.import("many.pdf", samplePdf(101)), {
    status: 413,
  });
  assert.equal(store.list().length, 0);
});
test("authenticated JSON chunks preserve binary bytes through a text-only proxy", async (t) => {
  const { store } = await fixture(t);
  let received;
  let receivedContext;
  const server = createServer({
    store,
    token: "test",
    distDir: ".",
    documents: {
      import: async (name, bytes, googleUrl, context) => {
        receivedContext = context;
        received = bytes;
        return { imported: [], skipped: [], status: "imported" };
      },
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal(
    (await fetch(base + "/api/import/pdf", { method: "POST" })).status,
    401,
  );
  const request = (body) =>
    fetch(base + "/api/import/pdf", {
      method: "POST",
      headers: {
        Authorization: "Bearer test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const bytes = Buffer.concat([samplePdf(), Buffer.from([0, 128, 255, 254])]);
  const half = Math.ceil(bytes.length / 2);
  const first = await request({
    name: "s.pdf",
    index: 0,
    total: 2,
    data: bytes.subarray(0, half).toString("base64"),
    reviewContext: "first chunk instructions",
  });
  assert.equal(first.status, 202);
  const { uploadId } = await first.json();
  assert.equal(
    (
      await request({
        name: "s.pdf",
        index: 0,
        total: 2,
        uploadId,
        data: "AAAA",
      })
    ).status,
    409,
  );
  const last = await request({
    name: "s.pdf",
    index: 1,
    total: 2,
    uploadId,
    data: bytes.subarray(half).toString("base64"),
    reviewContext: "must not replace instructions",
  });
  assert.equal(last.status, 202);
  assert.ok((await last.json()).id);
  assert.deepEqual(received, bytes);
  assert.equal(receivedContext, "first chunk instructions");
});

test("real PPTX and DOCX imports preserve originals and map every rendered page", async (t) => {
  const { store, documents } = await fixture(t);
  for (const name of ["two-slides.pptx", "two-pages.docx", "two-pages.doc"]) {
    const bytes = await readFile(
      new URL(`./fixtures/${name}`, import.meta.url),
    );
    const result = await documents.import(name, bytes);
    assert.equal(result.imported.length, 2);
    const first = await store.get(result.imported[0].id);
    const format = name.split(".").at(-1).toUpperCase();
    assert.equal(first.document.format, format);
    assert.deepEqual(
      await readFile(
        join(
          store.stateDir,
          "documents",
          first.document.id,
          `original.${format.toLowerCase()}`,
        ),
      ),
      bytes,
    );
    assert.equal(
      (await documents.image(first.id)).subarray(1, 4).toString(),
      "PNG",
    );
    assert.match(
      first.content,
      name.endsWith("pptx") ? /Slide 1/ : /Document page 1/,
    );
  }
});

test("100 pages are accepted at the document boundary", async (t) => {
  const { store, documents } = await fixture(t);
  await documents.import("hundred.pdf", samplePdf(100));
  assert.equal(store.list().length, 100);
});

test("page images work through a linked state root but reject escaped document/image links", async (t) => {
  const { root, store, documents } = await fixture(t);
  const imported = await documents.import("slides.pdf", samplePdf());
  const id = imported.imported[0].id;
  const review = await store.get(id);
  const expected = await documents.image(id);
  const linked = join(root, "linked-state");
  await symlink(store.stateDir, linked, "dir");
  const reopened = await new ReviewStore(store.root, linked).init();
  const viaLink = new Documents(reopened);
  assert.deepEqual(await viaLink.image(id), expected);
  const dir = join(store.stateDir, "documents", review.document.id);
  const png = join(dir, "page-1.png");
  const outside = join(root, "outside.png");
  await writeFile(outside, expected);
  await rm(png);
  await symlink(outside, png);
  await assert.rejects(viaLink.image(id), { status: 403 });
  await rm(png);
  await writeFile(png, expected);
  const outsideDir = join(root, "outside-document");
  await rename(dir, outsideDir);
  await symlink(outsideDir, dir, "dir");
  await assert.rejects(viaLink.image(id), { status: 403 });
});
