# Developer validation

These checks validate xangi-studio changes during development. Their screenshots are local test evidence, separate from the reviews and document images saved to Notion. For the actual export operation, see [Notion export in the usage guide](usage.md#optional-notion-export).

Browser checks require Chromium. Install Playwright Chromium or use `BROWSER_EXECUTABLE` in scripts that support it.

## README screenshots

After `npm ci`, run `node scripts/readme-screenshots.mjs` to capture the actual PR diff/review, slide review and Markdown editor at 1440×960px, updating `docs/images/pr-review.png`, `docs/images/slide-review.png` and `docs/images/draft-editor.png`. Chromium defaults to `/snap/bin/chromium`; override it with `BROWSER_EXECUTABLE`.

APIs use a fictional note app fixture defined in the script. Review comments are fixed dummy text; no AI runs. The slide API returns a code-drawn page image; this does not validate PPTX import or conversion. External requests, API writes, and undefined APIs are blocked, and browser errors fail the capture. No running xangi instance, saved drafts, or credentials are used.

## Chat skill

Run `node --test tests/skill-install.test.mjs tests/artifact-requests.test.mjs` for isolated workspace installation, discovery entries, repeat installation, conflict preservation, and draft creation/read-back/deduplication/persistence through the real HTTP server. Save-only requests do not start AI; explicit edit/review requests are queued. The host is mocked; live workspaces, user drafts and external APIs are untouched. See [setup](../../XANGI_SETUP.md#チャット用スキルの導入).

## Document reviews and Notion integration

Use `npm test` for Office conversion and Notion API regressions. `scripts/browser_document_check.py` assumes the retired automatic-review UI and is not a current UI acceptance check.

## Code selection

Code selection regression check: `node scripts/browser_selection_check.mjs`. Set `BROWSER_EXECUTABLE` to a Chromium executable. Checks visible same-line selections, copying, Shift selection and multiline selection in light/dark edit, read, side-by-side diff and mobile diff views. No backend is needed; screenshots are saved under `artifacts/selection/`.

## List refresh and review recovery

After building, run `uv run --with playwright python scripts/browser_refresh_check.py`. A mock proxy limits response headers while checking unchanged responses, hidden-tab pause/resume, mobile width and screens that do not need a recovery button. Automatic recovery, duplicate-processing prevention and revision checks are covered by `tests/review-jobs.test.mjs`.

## Editor rendering during page scroll

Run `node scripts/browser_editor_render_check.mjs` to open the real app and CodeMirror through Vite and verify that a 1500-line document keeps rendering visible lines as the page scrolls. It covers desktop and mobile widths in edit, read, and diff modes, plus editing and saving at a scrolled position. APIs are mocked; no external writes occur. Screenshots and viewport records go to `artifacts/editor-render/` (override with `EDITOR_ARTIFACTS`). Set `BROWSER_EXECUTABLE` to select Chromium. This check does not measure production save latency.

## Overview and parallel reviews

Overview diagram browser check: `uv run --with playwright python scripts/browser_software_overview_check.py`. Mocked AI/GitHub exercise PR/repository generation, relationships, source navigation, back/reload, existing file views and inert HTML strings at 1440px/390px. Set `OVERVIEW_ARTIFACTS` to choose evidence storage (default `/tmp/studio-software-overview`).

After building, run `uv run --with playwright python scripts/browser_review_pipeline_check.py` for independent overview generation, three groups for one reviewer or six conversations for two, concurrent overview/review execution, partial failure, result recovery after closing the screen, retry and reload at 1440px/390px. Services are mocked. Set `PIPELINE_ARTIFACTS` for evidence (default `/tmp/studio-review-pipeline`). `tests/review-pipeline.test.mjs` covers persistence, restart, assigned scope and revision/context validation.

## Draft autosave

`uv run --with playwright python scripts/browser_draft_check.py` uses an isolated real server/editor to check draft restoration including browser recovery text, concurrent-tab last-write-wins, edits during a save, transport errors/retry, explicit saving despite a draft failure, source history, character counts, and desktop/mobile save controls. Set DRAFT_ARTIFACTS for screenshots. No AI or external API runs. tests/drafts.test.mjs covers persistence across restart, last-write-wins, auth, read-only targets and size limits.

Run `uv run --with playwright python scripts/browser_draft_timeout_check.py` separately for an unresponsive save. The fixture delays its response beyond 15 seconds to verify failure status and retention of editor text and recovery data.

## Artifact request browser checks

`npm run build` → `node scripts/browser_request_check.mjs` verifies requests, reload, answers, conversation links, draft guards and artifact navigation at 1440px/390px. AI is simulated with no external dispatch. Set REQUEST_ARTIFACTS to choose evidence storage.

After building, `node scripts/browser_keyboard_check.mjs` checks document-flow controls at 390px/768px, no overlap with long text, shrinking and zoomed viewports, saving from the end, and the fixed footer at 1440px. Use `KEYBOARD_ARTIFACTS` for screenshots. A physical iOS keyboard still needs a separate check.

The draft browser check covers restored browser text with mismatched revision metadata, concurrent tabs using last-write-wins, and explicit file saving despite a draft endpoint failure.

Run `npm run build` then `node scripts/browser_editable_imports_check.mjs` to check all three text import kinds at 1440px/390px: editing, protected before text, draft restoration, failed save/retry, reload after save, and read-only files. The real server uses a temporary directory and GitHub descriptions are simulated. Set `EDITABLE_ARTIFACTS` for screenshots and results.

## HTML preview checks

After build, run `node scripts/browser_html_preview_check.mjs` to check 1440px/390px rendering, relative CSS/classic JS/SVG, unsaved preview and save/reload, repository source/display switching, error/retry and existing Markdown. It models the host CSP and rejection of opaque-origin requests, checks parent DOM/storage/network isolation, and verifies standalone CSP compatibility. Set HTML_PREVIEW_ARTIFACTS for evidence. Optionally provide HTML_PREVIEW_SAMPLE pointing to a JSON object with a content field containing a self-contained game to test attack interactions locally. No AI or production writes run. tests/html-previews.test.mjs covers authentication, import/revision boundaries, source preservation, CSP, size/capacity and expiry.
