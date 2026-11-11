// Capture the real UI with fictional data; no host, GitHub, AI or Notion access.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { githubGroupKey } from "../shared/pr-label.mjs";

const at = "2026-01-15T10:00:00+09:00";
const common = {
  source: "web",
  createdAt: at,
  modifiedAt: at,
  history: [],
  version: "demo-v1",
  size: 600,
};
const pullRequest = {
  ...common,
  id: "demo-pr",
  file: "src/search.ts",
  title: "検索語の前後の空白を取り除く",
  changeSet: {
    kind: "github-pr",
    id: "42",
    title: "検索語の前後の空白を取り除く",
    source: "example/note-app",
    url: "https://github.com/example/note-app/pull/42",
    revision: "demo-base:demo-head",
  },
  before: [
    "export function searchNotes(notes: Note[], query: string) {",
    "  return notes.filter((note) => note.title.includes(query));",
    "}",
    "",
  ].join("\n"),
  content: [
    "export function searchNotes(notes: Note[], query: string) {",
    "  const keyword = query.trim();",
    "  if (!keyword) return notes;",
    "  return notes.filter((note) => note.title.includes(keyword));",
    "}",
    "",
  ].join("\n"),
  explanations: [
    {
      heading: "空白だけの検索は、すべてのノートを表示",
      summary:
        "前後の空白を除去してから検索します。空の検索語では一覧を返します。",
      impact:
        "コピーした検索語に空白が含まれていても、目的のノートを探せます。",
      review: "空文字・空白のみ・日本語の検索語をテストで確認してください。",
      severity: "info",
      oldStart: 2,
      newStart: 2,
    },
  ],
};
const draft = {
  ...common,
  id: "demo-draft",
  file: "docs/getting-started.md",
  title: "ノートアプリの使い方",
  before: "# ノートアプリの使い方\n\nノートを書いて保存できます。\n",
  content: [
    "# ノートアプリの使い方",
    "",
    "思いついたことを、すぐに書き留めましょう。",
    "",
    "## はじめてのノート",
    "",
    "1. 「新しいノート」を選びます。",
    "2. タイトルと本文を入力します。",
    "3. 「保存」を押すと、一覧に追加されます。",
    "",
    "## 検索する",
    "",
    "検索欄にキーワードを入力すると、タイトルで絞り込めます。",
    "前後の空白は自動で取り除きます。空欄ならすべて表示します。",
    "",
    "## 次に試すこと",
    "",
    "- 気になるアイデアを3つ書く",
    "- キーワードでノートを探す",
    "- 使い方の原稿を見直す",
    "",
  ].join("\n"),
};
const slide = {
  ...common,
  id: "demo-slide",
  file: "documents/demo-slides/page-1.txt",
  title: "ノートアプリの改善提案",
  readOnly: true,
  before: "",
  content:
    "ノートアプリの改善提案\n検索をもっと使いやすく\n課題：検索語に空白があると見つからない\n改善：前後の空白を除去する\n目標：検索の成功率を上げる",
  document: {
    id: "demo-slides",
    name: "ノートアプリの改善提案.pptx",
    format: "PPTX",
    page: 1,
    pages: 1,
  },
  changeSet: {
    kind: "artifact",
    id: "demo-slides",
    title: "ノートアプリの改善提案",
    source: "PPTX",
    url: "demo-slides",
  },
  explanations: [
    {
      heading: "資料全体の概要",
      summary:
        "検索時の空白による取りこぼしを減らす改善提案です。課題・改善内容・目標を1枚で説明しています。",
      review: "",
      impact: "",
      severity: "info",
      oldStart: 1,
      newStart: 1,
    },
    {
      heading: "目標に測定方法を添える",
      summary: "「検索の成功率を上げる」だけでは、改善の達成を判断できません。",
      review:
        "例として「前後に空白がある検索語でも、期待するノートが見つかる」を確認項目に加えましょう。",
      impact: "実装後に何を検証するか、開発者と読み手で共有できます。",
      severity: "warning",
      oldStart: 1,
      newStart: 1,
    },
    {
      heading: "課題と改善の対応が明確",
      summary: "左から右へ読むと、困りごとと変更内容がつながります。",
      review: "検索語の具体例を1つ添えると、利用者にも伝わりやすくなります。",
      impact: "",
      severity: "info",
      oldStart: 1,
      newStart: 1,
    },
  ],
};
// A code-drawn slide stands in for a converted page image, not a real PPTX import.
const slideImage = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="#f4f7fb"/>
<rect width="18" height="720" fill="#2563eb"/>
<g font-family="Noto Sans CJK JP, sans-serif">
<text x="75" y="85" font-size="22" fill="#2563eb">NOTE APP / 改善提案</text>
<text x="75" y="165" font-size="52" font-weight="700" fill="#172554">検索をもっと使いやすく</text>
<text x="75" y="220" font-size="24" fill="#64748b">空白を気にせず、目的のノートへ。</text>
<rect x="75" y="280" width="520" height="230" rx="18" fill="white"/>
<rect x="635" y="280" width="570" height="230" rx="18" fill="#dbeafe"/>
<text x="110" y="335" font-size="24" fill="#64748b">01 / 課題</text>
<text x="110" y="400" font-size="30" font-weight="700" fill="#172554">検索語に空白があると</text>
<text x="110" y="448" font-size="30" font-weight="700" fill="#172554">見つからない</text>
<text x="670" y="335" font-size="24" fill="#2563eb">02 / 改善</text>
<text x="670" y="400" font-size="30" font-weight="700" fill="#172554">前後の空白を</text>
<text x="670" y="448" font-size="30" font-weight="700" fill="#172554">自動で取り除く</text>
<text x="75" y="595" font-size="28" fill="#172554">目標：検索の成功率を上げる</text>
<text x="75" y="675" font-size="18" fill="#64748b">架空の資料・ダミーデータ</text>
<text x="1160" y="675" font-size="18" fill="#64748b">01</text>
</g></svg>`;
const reviews = [pullRequest, draft, slide];
await mkdir("docs/images", { recursive: true });
const server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  const origin = new URL(server.resolvedUrls.local[0]).origin;
  browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE || "/snap/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 1,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Fail closed on unexpected APIs, writes, and all external network requests.
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) {
      errors.push(`External request blocked: ${url.origin}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    let data;
    const review = reviews.find(
      (item) => url.pathname === `/api/reviews/${item.id}`,
    );
    if (req.method() !== "GET") {
      errors.push(`Unexpected write: ${req.method()} ${url.pathname}`);
      return route.abort();
    }
    if (url.pathname === "/api/reviews/demo-slide/page")
      return route.fulfill({ contentType: "image/svg+xml", body: slideImage });
    if (url.pathname === "/api/reviews") data = reviews;
    else if (review) data = review;
    else if (url.pathname === "/api/preferences")
      data = {
        defaultProjectId: null,
        reviewerProjectIds: [],
        archivedChangeSets: [],
      };
    else if (url.pathname === "/api/notion") data = { configured: false };
    else if (url.pathname === "/api/projects") data = { projects: [] };
    else if (url.pathname === "/api/agents") data = { agents: [] };
    else if (
      url.pathname === "/api/review-jobs" ||
      url.pathname.endsWith("/requests")
    )
      data = [];
    else if (url.pathname.startsWith("/api/drafts/")) data = null;
    else if (url.pathname.endsWith("/github-description"))
      data = {
        title: pullRequest.title,
        body: "検索語の前後の空白を取り除き、空欄ならすべてのノートを表示します。",
        url: pullRequest.changeSet.url,
      };
    else {
      errors.push(`Unexpected API: ${url.pathname}`);
      return route.fulfill({ status: 404, json: { error: "No demo fixture" } });
    }
    await route.fulfill({ json: data });
  });
  await page.goto(
    `${origin}/?pr=${encodeURIComponent(githubGroupKey(pullRequest.changeSet))}`,
  );
  await page.locator(".pr-inline-comment").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: "docs/images/pr-review.png",
    animations: "disabled",
  });
  await page.goto(`${origin}/?review=demo-draft&mode=edit`);
  await page.locator(".cm-content").waitFor();
  await page.getByRole("button", { name: "保存", exact: true }).waitFor();
  assert.match(
    await page.locator(".cm-content").innerText(),
    /はじめてのノート/,
  );
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: "docs/images/draft-editor.png",
    animations: "disabled",
  });
  await page.goto(`${origin}/?review=demo-slide&mode=preview`);
  const slideElement = page.getByRole("img", {
    name: "ノートアプリの改善提案.pptx 1ページ",
  });
  await slideElement.waitFor();
  await slideElement.evaluate((img) => img.decode());
  await page
    .getByRole("heading", { name: "要注意 · 目標に測定方法を添える" })
    .waitFor();
  await page
    .getByLabel("資料全体の概要")
    .getByText(
      "検索時の空白による取りこぼしを減らす改善提案です。課題・改善内容・目標を1枚で説明しています。",
      { exact: true },
    )
    .waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: "docs/images/slide-review.png",
    animations: "disabled",
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: PR review, draft editor and slide review captured with fictional data (1440×960); no external requests or writes.",
  );
} finally {
  await browser?.close();
  await server.close();
}
