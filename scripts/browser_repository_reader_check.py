import json, os, subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
repo=Path(__file__).resolve().parents[1]
proc=subprocess.Popen(['node','scripts/document-browser-server.mjs',str(repo)],cwd=repo,env={**os.environ,'REPOSITORY_READER_FIXTURE':'1'},stdout=subprocess.PIPE,text=True)
try:
 info=json.loads(proc.stdout.readline());base=f"http://127.0.0.1:{info['port']}";url=base+'/api/extensions/xangi-studio/ui'
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path='/snap/bin/chromium',args=['--no-sandbox'])
  for width in [1440,390]:
   page=browser.new_page(viewport={'width':width,'height':900});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.route('**/github-description',lambda route:route.fulfill(json={'title':'Example PR','body':'PR description','url':'https://github.com/example/repo/pull/1'}))
   page.goto(url+'?import=1');page.locator('#pr-url').fill('https://github.com/example/repo');page.locator('#pr-url').press('Enter')
   expect(page.get_by_role('heading',name='Project guide',exact=True)).to_be_visible(timeout=15000)
   expect(page.locator('.pr-diff-line')).to_have_count(0)
   expect(page.locator('.repository-toolbar')).to_have_count(0)
   assert page.locator('.repository-browser').bounding_box()['y'] < (450 if width == 1440 else 600)
   expect(page.locator('.repository-file')).to_have_count(1)
   page.screenshot(path=f'/tmp/studio-reader-{width}-readme.png',full_page=True)
   page.get_by_role('button',name='ソース表示',exact=True).click()
   expect(page.locator('.repository-source .cm-content')).to_contain_text('# Project guide')
   page.get_by_role('button',name='整形表示',exact=True).click()
   def open_files():
    if not page.locator('.repository-navigation').is_visible(): page.get_by_role('button', name='ファイル一覧を開く', exact=True).click()
   expect(page.locator('.detail-file-controls')).to_have_count(0)
   expect(page.locator('.workspace > .sidebar')).not_to_be_visible()
   open_files()
   if width <= 800: expect(page.locator('.repository-file')).not_to_be_visible()
   expanded=page.locator('.repository-file').bounding_box() if width > 800 else None
   page.get_by_role('button', name='ファイル一覧を閉じる', exact=True).click()
   expect(page.locator('.repository-navigation input')).not_to_be_visible()
   collapsed=page.locator('.repository-file').bounding_box()
   container=page.locator('.repository-browser').bounding_box()
   assert abs(collapsed['width']-container['width']) < 2
   if width > 800: assert collapsed['width'] > expanded['width'] + 180
   expect(page.get_by_role('heading',name='Project guide',exact=True)).to_be_visible()
   page.screenshot(path=f'/tmp/studio-reader-{width}-collapsed.png',full_page=True)
   open_files()
   if width > 800: assert abs(page.locator('.repository-file').bounding_box()['width']-expanded['width']) < 2
   search=page.locator('.repository-navigation input');search.fill('nothing-matches')
   expect(page.get_by_text('一致するファイルはありません。')).to_be_visible()
   search.fill('example.ts')
   page.locator('.repository-navigation .file-item').click()
   expect(page.locator('.repository-source .cm-content')).to_contain_text('export const n=2;')
   expect(page.locator('.cm-deletedChunk,.cm-insertedLine,.pr-diff-line.added')).to_have_count(0)
   open_files()
   search.fill('empty.txt');page.locator('.repository-navigation .file-item').click()
   expect(page.get_by_text('空のファイルです。')).to_be_visible()
   open_files()
   search.fill('example.ts');page.locator('.repository-navigation .file-item').click()
   expect(page.locator('.repository-source .cm-content')).to_contain_text('export const n=2;')
   page.screenshot(path=f'/tmp/studio-reader-{width}-code.png',full_page=True)
   assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
   page.get_by_role('button',name='個別表示',exact=True).click()
   expect(page.get_by_role('tab',name='表示',exact=True)).to_have_attribute('aria-selected','true')
   expect(page.get_by_role('tab',name='差分',exact=True)).to_have_count(0)
   page.go_back()
   expect(page.get_by_role('heading',name='Project guide',exact=True)).to_be_visible(timeout=15000)
   assert not errors,errors
   # PR still uses a diff, including added/removed lines.
   page.goto(url+'?import=1');page.locator('#pr-url').fill('https://github.com/example/repo/pull/1');page.locator('#pr-url').press('Enter')
   expect(page.locator('.pr-diff-line.added')).to_have_count(1,timeout=15000)
   assert not errors,errors
   page.close()
  browser.close()
 print(json.dumps({'widths':[1440,390],'readme_code_empty_search_individual_back_pr_diff':'passed'}))
finally:proc.terminate();proc.wait(timeout=10)
