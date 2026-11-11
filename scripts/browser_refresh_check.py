import json, os, subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
proc = subprocess.Popen(
    ["node", "scripts/studio-browser-server.mjs"],
    cwd=repo,
    env={**os.environ, "STUDIO_BROWSER_PR_FIXTURE": "1"},
    stdout=subprocess.PIPE,
    text=True,
)
try:
    info = json.loads(proc.stdout.readline())
    base = f"http://127.0.0.1:{info['port']}"
    url = base + "/api/extensions/xangi-studio/ui"
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=os.environ.get("BROWSER_EXECUTABLE")
            or "/snap/bin/chromium",
            headless=True,
            args=["--no-sandbox"],
        )
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        errors = []
        responses = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on(
            "response",
            lambda r: responses.append(r) if "summary=home" in r.url else None,
        )
        page.goto(url)
        expect(page.get_by_role("navigation", name="成果物一覧")).to_be_visible()
        expect(
            page.get_by_role("link", name="確認用の文章", exact=False)
        ).to_be_visible()
        page.wait_for_timeout(4500)
        bodies = [r.json() for r in responses]
        assert any(x.get("unchanged") for x in bodies), bodies
        sizes = [len(r.body()) for r in responses]
        page.set_viewport_size({"width": 390, "height": 844})
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        page.evaluate(
            'Object.defineProperty(document,"hidden",{configurable:true,get:()=>true})'
        )
        before = len(responses)
        page.wait_for_timeout(4500)
        assert len(responses) == before
        page.evaluate(
            'Object.defineProperty(document,"hidden",{configurable:true,get:()=>false})'
        )
        page.wait_for_timeout(4500)
        assert len(responses) > before
        assert not errors, errors
        reviews = page.request.get(
            base + "/api/extensions/xangi-studio/service/api/reviews"
        ).json()
        change_set = reviews[0]["changeSet"]
        job = {
            "sessionId": "saved-review",
            "status": "failed",
            "error": "旧読取エラー",
            "changeSet": change_set,
            "reviewer": {"id": "test", "name": "確認担当"},
        }
        page.route("**/api/review-jobs**", lambda route: route.fulfill(json=[job]))
        page.goto(url + "?pr=github-pr:example/studio:17")
        expect(page.get_by_text("旧読取エラー", exact=False)).to_be_visible()
        expect(page.get_by_role("button", name="保存済みの結果を再取得")).to_have_count(0)
        assert not errors, errors
        print(
            json.dumps(
                {
                    "home_response_bytes": sizes,
                    "unchanged_count": sum(bool(x.get("unchanged")) for x in bodies),
                    "hidden_polling": "stopped",
                    "resume": "ok",
                    "mobile_overflow": False,
                    "errors": errors,
                }
            )
        )
        browser.close()
finally:
    proc.terminate()
    proc.wait(timeout=10)
