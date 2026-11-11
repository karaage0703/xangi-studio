"""Run against a task-owned CDP browser: uv run --with playwright python scripts/browser_check.py."""
import json
from pathlib import Path
from urllib.request import Request, urlopen
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = json.loads((ROOT / ".state/runtime.json").read_text())
BASE = RUNTIME["baseUrl"]
KEY = (ROOT / ".state/access-token").read_text().strip()
ARTIFACTS = ROOT / "artifacts"
ARTIFACTS.mkdir(exist_ok=True)


def api(path, body=None):
    request = Request(BASE + path, headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"},
                      data=json.dumps(body).encode() if body is not None else None,
                      method="PUT" if body is not None else "GET")
    with urlopen(request) as response:
        return json.load(response)


def link(review, mode="preview"):
    return f"{BASE}/review/{review}?mode={mode}#key={KEY}"


results = []
errors = []
initial = api("/api/reviews/demo-code")
with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp("http://127.0.0.1:9247")
    context = browser.new_context()
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.set_viewport_size({"width": 1440, "height": 1000})
    try:
        page.goto(link("demo-markdown"))
        expect(page.get_by_role("heading", name="小さな道具をつくる", exact=True)).to_be_visible()
        page.screenshot(path=str(ARTIFACTS / "desktop-preview.png"))
        page.get_by_role("tab", name="差分", exact=True).click()
        expect(page.locator(".cm-mergeView .cm-editor")).to_have_count(2)
        page.screenshot(path=str(ARTIFACTS / "desktop-diff.png"))
        results.append("desktop Markdown preview and two-column diff")

        page.get_by_role("button", name="リンク", exact=True).click()
        page.get_by_label("貼り付け先").select_option("slack")
        assert page.get_by_label("共有するリンク").input_value().startswith("<" + BASE)
        page.get_by_label("貼り付け先").select_option("discord")
        assert "](" + BASE in page.get_by_label("共有するリンク").input_value()
        page.get_by_label("貼り付け先").select_option("web")
        assert "mode=diff#key=" in page.get_by_label("共有するリンク").input_value()
        page.get_by_role("button", name="閉じる", exact=True).click()
        results.append("Discord / Slack / Web shared links preserve selected mode")

        page.goto(link("demo-code", "edit"))
        editor = page.get_by_label("ファイルを編集", exact=True)
        expect(editor).to_be_visible()
        edited = initial["content"] + "\n// ブラウザで微修正しました。\n"
        editor.fill(edited)
        page.get_by_role("tab", name="表示", exact=True).click()
        expect(page.locator(".code-pane")).to_contain_text("ブラウザで微修正しました。")
        page.get_by_role("tab", name="編集", exact=True).click()
        expect(editor).to_contain_text("ブラウザで微修正しました。")
        page.get_by_role("button", name="保存する").click()
        expect(page.get_by_role("status")).to_have_text("保存しました")
        assert api("/api/reviews/demo-code")["content"] == edited
        page.reload()
        expect(editor).to_contain_text("ブラウザで微修正しました。")
        results.append("Japanese edit, mode switches retain draft, real save survives reload")

        editor.fill(edited + "// 未保存の下書き\n")
        page.get_by_role("button", name="editor.json", exact=False).click()
        expect(page.get_by_role("dialog")).to_be_visible()
        page.get_by_role("button", name="編集を続ける", exact=True).click()
        expect(editor).to_contain_text("未保存の下書き")
        page.get_by_role("button", name="editor.json", exact=False).click()
        page.get_by_role("button", name="破棄して続ける", exact=True).click()
        expect(page.locator(".file-path")).to_contain_text("editor.json")
        results.append("unsaved file-switch confirmation: cancel and discard")

        page.goto(link("demo-code", "edit"))
        expect(editor).to_be_visible()
        local_draft = edited + "// 自分の下書き\n"
        editor.fill(local_draft)
        latest = api("/api/reviews/demo-code")
        external = edited + "// 別の場所で更新\n"
        api("/api/reviews/demo-code", {"content": external, "version": latest["version"]})
        page.get_by_role("button", name="保存する").click()
        expect(page.get_by_role("alert")).to_contain_text("別の場所で更新")
        expect(editor).to_contain_text("自分の下書き")
        assert api("/api/reviews/demo-code")["content"] == external
        page.get_by_role("button", name="最新内容と比較", exact=True).click()
        expect(page.locator(".cm-mergeView")).to_contain_text("別の場所で更新")
        expect(page.locator(".cm-mergeView")).to_contain_text("自分の下書き")
        page.screenshot(path=str(ARTIFACTS / "conflict.png"))
        page.get_by_role("button", name="この編集を保存候補にする", exact=True).click()
        page.get_by_role("button", name="保存する").click()
        expect(page.get_by_role("status")).to_have_text("保存しました")
        assert api("/api/reviews/demo-code")["content"] == local_draft
        results.append("conflict preserves both disk and draft; explicit review before save")

        page.get_by_role("button", name="保存履歴", exact=True).click()
        page.get_by_role("button", name="AI作業前", exact=False).click()
        expect(editor).to_be_visible()
        expect(page.locator(".save-status")).to_contain_text("未保存")
        assert api("/api/reviews/demo-code")["content"] == local_draft
        page.get_by_role("button", name="取り消す", exact=True).click()
        page.get_by_role("button", name="破棄して続ける", exact=True).click()
        results.append("history restore loads draft without immediately overwriting disk")

        page.get_by_role("tab", name="編集", exact=True).click()
        pending = []
        def hold_save(route):
            if route.request.method == "PUT":
                pending.append(route)
            else:
                route.continue_()
        page.route("**/api/reviews/demo-code", hold_save)
        submitted = local_draft + "// 保存開始\n"
        newer = submitted + "// 通信中の追記\n"
        editor.fill(submitted)
        editor.press("Control+s")
        expect(page.locator(".save-status")).to_contain_text("保存中")
        editor.fill(newer)
        assert len(pending) == 1
        pending[0].continue_()
        expect(page.get_by_role("status")).to_have_text("保存しました")
        expect(editor).to_contain_text("通信中の追記")
        expect(page.locator(".save-status")).to_contain_text("未保存")
        assert api("/api/reviews/demo-code")["content"] == submitted
        page.unroute("**/api/reviews/demo-code", hold_save)
        page.get_by_role("button", name="保存する").click()
        expect(page.locator(".save-status")).to_contain_text("すべて保存済み")
        assert api("/api/reviews/demo-code")["content"] == newer
        results.append("Ctrl+S saves submitted content; typing during save retains newer draft")

        for width in [320, 375, 414, 768]:
            page.set_viewport_size({"width": width, "height": 812})
            page.goto(link("demo-markdown"))
            expect(page.get_by_role("heading", name="小さな道具をつくる", exact=True)).to_be_visible()
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), f"overflow at {width}"
            if width == 375:
                page.screenshot(path=str(ARTIFACTS / "mobile-preview.png"))
            page.get_by_role("tab", name="差分", exact=True).click()
            expect(page.locator(".cm-editor")).to_have_count(1)
            expect(page.locator(".cm-deletedChunk").first).to_be_visible()
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), f"diff overflow at {width}"
            if width == 375:
                page.screenshot(path=str(ARTIFACTS / "mobile-diff.png"))
            page.get_by_role("button", name="ファイル一覧へ戻る", exact=True).click()
            expect(page.get_by_label("ファイルを検索", exact=True)).to_be_visible()
            page.get_by_role("button", name="greeting.ts", exact=False).click()
            page.get_by_role("tab", name="編集", exact=True).click()
            expect(editor).to_be_visible()
            editor.fill(f"// モバイル幅{width}pxの日本語編集\n" + initial["content"])
            page.get_by_role("button", name="保存する").click()
            expect(page.get_by_role("status")).to_have_text("保存しました")
            assert api("/api/reviews/demo-code")["content"].startswith("// モバイル幅")
            results.append(f"{width}px: no page overflow, unified diff, file navigation, edit and save")

        page.set_viewport_size({"width": 1440, "height": 1000})
        page.goto(link("demo-markdown"))
        expect(page.get_by_role("heading", name="小さな道具をつくる", exact=True)).to_be_visible()
        assert not errors, errors
        results.append("no uncaught browser JavaScript errors")
    finally:
        page.unroute_all(behavior="ignoreErrors")
        context.close()
        current = api("/api/reviews/demo-code")
        api("/api/reviews/demo-code", {"content": initial["content"], "version": current["version"]})
        (ARTIFACTS / "browser-results.json").write_text(json.dumps({"passed": results, "errors": errors}, ensure_ascii=False, indent=2))
        print(json.dumps({"passed": results, "errors": errors}, ensure_ascii=False, indent=2))
