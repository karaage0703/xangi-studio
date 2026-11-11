import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseGoogleDocument,
  exportGoogleDocument,
  officeToPdf,
} from "../server/document-sources.mjs";
import { samplePdf } from "./helpers/pdf.mjs";
test("Google accepts only canonical Slides/Docs URLs and never fetches arbitrary URLs", () => {
  for (const kind of ["presentation", "document"])
    assert.equal(
      parseGoogleDocument(
        `https://docs.google.com/${kind}/d/file_123/edit?usp=sharing#slide=id.test`,
      ).id,
      "file_123",
    );
  for (const url of [
    "http://docs.google.com/document/d/id/edit",
    "https://evil.test/document/d/id/edit",
    "https://docs.google.com.evil.test/document/d/id/edit",
    "https://docs.google.com:444/document/d/id/edit",
    "https://user@docs.google.com/document/d/id/edit",
    "https://docs.google.com/spreadsheets/d/id/edit",
  ])
    assert.throws(() => parseGoogleDocument(url), { status: 400 });
});
test("Google exports both native formats with explicit account and PDF output", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "google-export-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const kind of ["presentation", "document"]) {
    const calls = [];
    const runner = async (cmd, args) => {
      calls.push(args);
      assert.ok(args.includes("--account"));
      assert.equal(args[1], "test@example.com");
      if (args.includes("get"))
        return {
          stdout: JSON.stringify({
            name: "Example",
            mimeType: `application/vnd.google-apps.${kind}`,
          }),
        };
      await writeFile(args[args.indexOf("--out") + 1], samplePdf());
      return { stdout: "" };
    };
    const result = await exportGoogleDocument(
      `https://docs.google.com/${kind}/d/file_123/edit`,
      dir,
      { account: "test@example.com", runner },
    );
    assert.equal(calls.length, 2);
    assert.equal(result.bytes.subarray(0, 5).toString(), "%PDF-");
    assert.equal(result.title, "Example");
    assert.ok(calls[1].includes("pdf"));
  }
  await assert.rejects(
    exportGoogleDocument("https://docs.google.com/document/d/id/edit", dir, {
      account: "",
    }),
    { status: 503 },
  );
  await assert.rejects(
    exportGoogleDocument("https://docs.google.com/document/d/id/edit", dir, {
      account: "a",
      runner: async () => {
        throw Object.assign(new Error("secret"), {
          stderr: "403 permission secret",
        });
      },
    }),
    (e) => e.status === 422 && !e.message.includes("secret"),
  );
  await assert.rejects(
    officeToPdf(dir, ".docx", Buffer.from("bad"), async () => {
      throw new Error("conversion failed");
    }),
    { status: 422 },
  );
});

test("Google automatically reuses Drive accounts and skips only inaccessible accounts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "google-accounts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const visited = [];
  const runner = async (cmd, args) => {
    if (args.includes("auth"))
      return {
        stdout: JSON.stringify({
          accounts: [
            { email: "denied@example.com", services: ["drive"] },
            { email: "allowed@example.com", services: ["drive"] },
          ],
        }),
      };
    if (args.includes("get")) {
      visited.push(args[1]);
      if (args[1].startsWith("denied"))
        throw Object.assign(new Error("denied"), { stderr: "403 permission" });
      return {
        stdout: JSON.stringify({
          name: "Existing settings",
          mimeType: "application/vnd.google-apps.document",
        }),
      };
    }
    await writeFile(args[args.indexOf("--out") + 1], samplePdf());
    return { stdout: "" };
  };
  const result = await exportGoogleDocument(
    "https://docs.google.com/document/d/test/edit",
    dir,
    { runner },
  );
  assert.equal(result.title, "Existing settings");
  assert.deepEqual(visited, ["denied@example.com", "allowed@example.com"]);
});

test("Google editor URLs can refer to original Office files", async (t) => {
  for (const [kind, mime, fixture, extension] of [
    [
      "presentation",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "two-slides.pptx",
      ".pptx",
    ],
    [
      "document",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "two-pages.docx",
      ".docx",
    ],
    ["document", "application/msword", "two-pages.doc", ".doc"],
  ]) {
    const dir = await mkdtemp(join(tmpdir(), "google-office-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const original = await readFile(
      new URL(`./fixtures/${fixture}`, import.meta.url),
    );
    const runner = async (cmd, args) => {
      if (args.includes("get"))
        return {
          stdout: JSON.stringify({
            name: fixture,
            mimeType: mime,
            size: String(original.length),
          }),
        };
      assert.ok(!args.includes("--format"));
      await writeFile(args[args.indexOf("--out") + 1], original);
      return { stdout: "" };
    };
    const result = await exportGoogleDocument(
      `https://docs.google.com/${kind}/d/test/edit`,
      dir,
      { account: "test@example.com", runner },
    );
    assert.equal(result.bytes.subarray(0, 5).toString(), "%PDF-");
    assert.deepEqual(
      await readFile(join(dir, `original${extension}`)),
      original,
    );
  }
});
