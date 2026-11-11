"""Slow import must not block navigation; test success/failure for each input."""
import json, os, subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
repo = Path(os.environ.get("STUDIO_TEST_REPO") or Path(__file__).resolve().parents[1])
proc = subprocess.Popen(['node', 'scripts/document-browser-server.mjs', str(repo)], cwd=repo, stdout=subprocess.PIPE, text=True)
try:
    info = json.loads(proc.stdout.readline())
    url = f"http://127.0.0.1:{info['port']}/api/extensions/xangi-studio/ui"
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get('BROWSER_EXECUTABLE') or '/snap/bin/chromium', args=['--no-sandbox'])
        for width in [1440, 390]:
            for kind in ['pr', 'repository', 'google', 'pdf']:
                page = browser.new_page(viewport={'width': width, 'height': 900})
                errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))
                polls = [0]
                def pending(route):
                    polls[0] += 1
                    route.fulfill(json={'id': 'mock', 'status': 'running'} if polls[0] < 4 else {'id': 'mock', 'status': 'failed', 'error': 'Test import failure'})
                page.route('**/api/import/**/jobs/*', pending)
                page.goto(url + '?import=1')
                if kind in ['pr', 'repository']:
                    page.locator('#pr-url').fill('https://github.com/example/repo' + ('/pull/1' if kind == 'pr' else ''))
                    page.locator('#pr-url').press('Enter')
                elif kind == 'google':
                    page.locator('#google-url').fill('https://docs.google.com/document/d/example/edit')
                    page.locator('#google-url').press('Enter')
                else:
                    page.locator('#pdf-file').set_input_files(str(Path(info['root']) / 'sample.pdf'))
                    page.get_by_role('button', name='資料を取り込む', exact=True).click()
                expect(page.locator('.modal-backdrop')).to_have_count(0)
                expect(page.get_by_text('他の成果物も閲覧できます。', exact=False)).to_be_visible()
                toggle = page.locator('.artifact-sidebar-toggle')
                before = toggle.get_attribute('aria-expanded')
                toggle.click()
                assert toggle.get_attribute('aria-expanded') != before
                expect(page.get_by_role('alert').filter(has_text='Test import failure')).to_be_visible(timeout=15000)
                assert not errors, errors
                page.close()
        browser.close()
    print(json.dumps({'responsive_inputs': ['pr','repository','google','pdf'], 'widths': [1440,390], 'failure_recovered': True}))
finally:
    proc.terminate(); proc.wait(timeout=10)
