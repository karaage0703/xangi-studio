import json, os, subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
repo = Path(__file__).resolve().parents[1]
proc = subprocess.Popen(['node','scripts/document-browser-server.mjs',str(repo)], cwd=repo, stdout=subprocess.PIPE,text=True)
try:
 info=json.loads(proc.stdout.readline());base=f"http://127.0.0.1:{info['port']}";url=base+'/api/extensions/xangi-studio/ui'
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True, executable_path=os.environ.get('BROWSER_EXECUTABLE'),args=['--no-sandbox'])
  for width in [1440,390]:
   page=browser.new_page(viewport={'width':width,'height':900});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(url+'?import=1');page.locator('#pr-url').fill('https://github.com/example/repo');page.locator('#pr-url').press('Enter')
   expect(page.get_by_role('button',name='リポジトリ全体をレビュー',exact=True)).to_be_visible(timeout=15000)
   expect(page.locator('.repository-source .cm-content')).to_contain_text('export const n=2;')
   assert 'github-repository' in page.url
   stats=page.request.get(base+'/stats').json();assert len(stats['reviews'])==1
   if width == 1440: assert stats['chats']==0
   page.get_by_role('button',name='リポジトリ全体をレビュー',exact=True).click()
   page.screenshot(path=f'/tmp/studio-repository-{width}-review.png',full_page=True)
   # Confirm the actual review modal and submit using its visible action.
   page.get_by_role('button',name='レビューを開始する',exact=True).click()
   page.wait_for_timeout(6000)
   Path('/tmp/studio-repo-browser-stats.json').write_text(json.dumps(page.request.get(base+'/stats').json(),ensure_ascii=False))
   Path('/tmp/studio-repo-browser-text.txt').write_text(page.locator('body').inner_text())
   page.locator('.repository-findings summary').click()
   expect(page.locator('.pr-inline-review').first).to_contain_text('確認済み',timeout=5000)
   stats=page.request.get(base+'/stats').json();assert all('a'*40 in text for text in stats['prompts'])
   page.get_by_role('button',name='個別表示',exact=True).click()
   expect(page.get_by_role('button',name='このファイルをレビュー',exact=True)).to_be_visible()
   page.get_by_role('button',name='このファイルをレビュー',exact=True).click()
   page.get_by_role('button',name='レビューを開始する',exact=True).click()
   page.wait_for_timeout(6000)
   stats=page.request.get(base+'/stats').json()
   assert 'src/example.ts だけ' in stats['prompts'][-1]
   assert all(j['status']=='completed' for j in stats['jobs'])
   page.get_by_role('button',name='更新を確認',exact=True).click()
   expect(page.get_by_role('button',name='リポジトリ全体をレビュー',exact=True)).to_be_visible(timeout=15000)
   assert len(page.request.get(base+'/stats').json()['reviews'])==1
   page.screenshot(path=f'/tmp/studio-repository-{width}.png',full_page=True)
   assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
   assert not errors,errors
   page.close()
  browser.close()
 print(json.dumps({'widths':[1440,390],'import_review_refresh':'passed'}))
finally:
 proc.terminate();proc.wait(timeout=10)
