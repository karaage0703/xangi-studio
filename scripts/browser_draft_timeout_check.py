import json, os, subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
repo=Path(__file__).resolve().parents[1]
proc=subprocess.Popen(['node','scripts/draft-browser-server.mjs'],cwd=repo,stdout=subprocess.PIPE,text=True)
try:
 info=json.loads(proc.stdout.readline());base=f"http://127.0.0.1:{info['port']}"
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path=os.environ.get('BROWSER_EXECUTABLE','/snap/bin/chromium'),args=['--no-sandbox'])
  page=browser.new_page();page.on('dialog',lambda d:d.accept())
  page.goto(base+'/api/extensions/xangi-studio/ui'+f"?review={info['reviewId']}&mode=edit")
  editor=page.get_by_role('textbox',name='ファイルを編集',exact=True);expect(editor).to_be_visible()
  # Keep the real server request open beyond the client's 15 second deadline.
  page.request.post(base+'/control',data={'delay':20000})
  editor.fill('応答がない場合にも下書きを残す')
  bar=page.get_by_label('下書きの保存状態',exact=True)
  expect(bar).to_contain_text('保存失敗',timeout=20000)
  expect(editor).to_contain_text('応答がない場合にも下書きを残す')
  assert any('応答がない場合' in value for value in page.evaluate('Object.values(localStorage)'))
  browser.close()
 print(json.dumps({'timeout_seconds':15,'preserved_editor_and_recovery_copy':'passed'}))
finally:proc.terminate();proc.wait(timeout=10)
