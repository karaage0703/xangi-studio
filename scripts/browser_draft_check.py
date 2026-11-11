import json, os, subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
repo=Path(__file__).resolve().parents[1]
output=Path(os.environ.get('DRAFT_ARTIFACTS','/tmp/studio-draft-check'));output.mkdir(parents=True,exist_ok=True)
proc=subprocess.Popen(['node','scripts/draft-browser-server.mjs'],cwd=repo,stdout=subprocess.PIPE,text=True)
try:
 info=json.loads(proc.stdout.readline());base=f"http://127.0.0.1:{info['port']}";url=base+'/api/extensions/xangi-studio/ui'
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path=os.environ.get('BROWSER_EXECUTABLE','/snap/bin/chromium'),args=['--no-sandbox'])
  context=browser.new_context()
  for width in [1440,390]:
   page=context.new_page();page.set_viewport_size({'width':width,'height':900});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   file_url=url+f"?review={info['reviewId']}&mode=edit"
   page.goto(file_url);editor=page.get_by_role('textbox',name='ファイルを編集',exact=True)
   expect(editor).to_be_visible(timeout=10000)
   bar=page.get_by_label('下書きの保存状態',exact=True)
   expect(bar).to_contain_text('保存済み')
   expect(bar.get_by_label('文字数',exact=True)).to_contain_text('文字')
   editor.fill('日本語😀\n');expect(bar.get_by_label('文字数',exact=True)).to_have_text('5文字')
   editor.fill('');expect(bar.get_by_label('文字数',exact=True)).to_have_text('0文字')
   text=f'下書き {width}\n'+'長い本文です。\n'*900
   # Real editing event through CodeMirror; no mock of the draft API.
   editor.fill(text)
   expect(bar).to_contain_text('保存中')
   page.evaluate('scrollTo(0, document.documentElement.scrollHeight)')
   expect(bar).to_be_visible();box=bar.bounding_box();assert box['y']+box['height']<=905 and box['y']>=0
   expect(bar).to_contain_text('保存済み',timeout=10000)
   assert page.request.get(base+'/stats').json()['review']['content']!=text
   page.screenshot(path=str(output/f'file-{width}-saved.png'))
   page.reload();expect(editor).to_contain_text(f'下書き {width}');expect(bar).to_contain_text('保存済み')
   # An edit arriving during a slow save is queued and must survive reload.
   page.request.post(base+'/control',data={'delay':900})
   editor.fill('保存中の一つ目');page.wait_for_timeout(850);editor.fill(f'保存中の最終入力 {width}')
   expect(bar).to_contain_text('保存済み',timeout=10000)
   page.request.post(base+'/control',data={});page.reload();expect(editor).to_contain_text(f'保存中の最終入力 {width}')
   # Transport failure stays visible below long content and preserves local recovery.
   page.request.post(base+'/control',data={'fail':True});editor.fill(f'通信失敗時の内容 {width}\n'+'本文\n'*900)
   expect(bar).to_contain_text('保存失敗',timeout=10000);page.evaluate('scrollTo(0,document.documentElement.scrollHeight)');expect(bar).to_be_visible()
   page.screenshot(path=str(output/f'file-{width}-failed.png'))
   page.on('dialog',lambda d:d.accept());page.reload();expect(editor).to_contain_text('通信失敗時の内容');expect(bar).to_contain_text('保存失敗',timeout=10000)
   page.request.post(base+'/control',data={});bar.get_by_role('button',name='再試行',exact=True).click();expect(bar).to_contain_text('保存済み',timeout=10000)
   # Explicit application remains distinct from autosaving drafts.
   bar.get_by_role('button',name='保存',exact=True).click();expect(bar.get_by_role('button',name='保存',exact=True)).to_be_disabled(timeout=10000);expect(bar).to_contain_text('保存済み',timeout=10000)
   assert page.request.get(base+'/stats').json()['review']['content'].startswith('通信失敗時の内容')
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
   assert not errors,errors
   page.close()
  # Separate tabs use last-write-wins without locking either editor.
  a=context.new_page();b=context.new_page()
  for tab in [a,b]:
   tab.on('dialog',lambda d:d.accept());tab.goto(file_url);expect(tab.get_by_role('textbox',name='ファイルを編集',exact=True)).to_be_visible();expect(tab.get_by_label('下書きの保存状態',exact=True)).to_contain_text('保存済み')
  for tab,text in [(a,'タブAの保存内容'),(b,'タブBの保存内容')]:
   tab.get_by_role('textbox',name='ファイルを編集',exact=True).fill(text)
   expect(tab.get_by_label('下書きの保存状態',exact=True)).to_contain_text('保存済み',timeout=10000)
  draft_path=base+'/api/extensions/xangi-studio/service/api/drafts/review/'+info['reviewId']
  assert b.request.get(draft_path).json()['content']=='タブBの保存内容'
  expect(a.get_by_role('textbox',name='ファイルを編集',exact=True)).to_contain_text('タブAの保存内容')
  # Reproduce the screenshot: local recovery text no longer matches the server revision.
  a.evaluate("""id => localStorage.setItem('studio-draft:'+location.pathname+':review:'+id+':repro',JSON.stringify({content:'競合していた未保存本文',baseVersion:'old',expectedVersion:'old',at:Date.now()}))""",info['reviewId'])
  a.reload();abar=a.get_by_label('下書きの保存状態',exact=True)
  expect(a.get_by_role('textbox',name='ファイルを編集',exact=True)).to_contain_text('競合していた未保存本文')
  expect(abar).to_contain_text('保存済み',timeout=10000)
  expect(abar.get_by_role('button',name='保存済みの下書きに戻す',exact=True)).to_have_count(0)
  assert a.request.get(draft_path).json()['content']=='競合していた未保存本文'
  # Explicit Save is not blocked by a draft endpoint failure.
  a.request.post(base+'/control',data={'fail':True})
  a.get_by_role('textbox',name='ファイルを編集',exact=True).fill('下書き失敗でも保存できる本文')
  expect(abar).to_contain_text('保存失敗',timeout=10000)
  abar.get_by_role('button',name='保存',exact=True).click()
  expect(abar).to_contain_text('保存済み',timeout=10000)
  assert a.request.get(base+'/stats').json()['review']['content']=='下書き失敗でも保存できる本文'
  assert a.request.get(draft_path).json()['content']=='下書き失敗でも保存できる本文'
  a.request.post(base+'/control',data={})
  # A late failed draft request cannot turn a successful file Save into an error.
  a.request.post(base+'/control',data={'fail':True,'delay':1200})
  a.get_by_role('textbox',name='ファイルを編集',exact=True).fill('遅れた下書きエラーを残さず保存')
  a.wait_for_timeout(900)
  abar.get_by_role('button',name='保存',exact=True).click()
  expect(a.get_by_text('保存しました',exact=True)).to_be_visible()
  a.wait_for_timeout(1800)
  expect(abar).to_contain_text('保存済み')
  expect(abar).not_to_contain_text('保存失敗')
  expect(abar.get_by_role('button',name='再試行',exact=True)).to_have_count(0)
  assert a.request.get(base+'/stats').json()['review']['content']=='遅れた下書きエラーを残さず保存'
  a.request.post(base+'/control',data={})
  # One Save applies the visible draft even when its base version is old.
  for reload in [False, True]:
   text='基準版が古くても保存する本文😀' + str(reload)
   a.get_by_role('textbox',name='ファイルを編集',exact=True).fill(text)
   abar=a.get_by_label('下書きの保存状態',exact=True)
   expect(abar).to_contain_text('保存済み',timeout=10000)
   a.request.post(base+'/control',data={'external':True})
   if reload: a.reload()
   expect(a.get_by_role('textbox',name='ファイルを編集',exact=True)).to_contain_text(text)
   expect(abar.get_by_role('button',name='保存',exact=True)).to_be_enabled()
   expect(abar.get_by_role('button',name='最新の版へ編集を載せ直す',exact=True)).to_have_count(0)
   abar.get_by_role('button',name='保存',exact=True).click()
   expect(abar.get_by_role('button',name='保存',exact=True)).to_be_disabled(timeout=10000)
   expect(abar).to_contain_text('保存済み',timeout=10000)
   saved_review=a.request.get(base+'/stats').json()['review']
   assert saved_review['content']==text
   history_id=saved_review['history'][-1]['id']
   snapshot=a.request.get(base+'/api/extensions/xangi-studio/service/api/reviews/'+info['reviewId']+'/history/'+history_id).json()
   assert snapshot['content']=='外部から更新された本文'
  # Source-save errors preserve text and allow retrying the same Save button.
  a.get_by_role('textbox',name='ファイルを編集',exact=True).fill('再試行で保存する本文')
  expect(abar).to_contain_text('保存済み',timeout=10000)
  a.request.post(base+'/control',data={'sourceFail':True})
  abar.get_by_role('button',name='保存',exact=True).click()
  expect(abar).to_contain_text('ファイル保存に失敗しました',timeout=10000)
  expect(a.get_by_role('textbox',name='ファイルを編集',exact=True)).to_contain_text('再試行で保存する本文')
  assert a.request.get(base+'/stats').json()['review']['content']==text
  a.request.post(base+'/control',data={})
  abar.get_by_role('button',name='保存',exact=True).click()
  expect(abar.get_by_role('button',name='保存',exact=True)).to_be_disabled(timeout=10000)
  assert a.request.get(base+'/stats').json()['review']['content']=='再試行で保存する本文'
  a.screenshot(path=str(output/'simple-save-desktop.png'))
  a.close();b.close()
  context.close();browser.close()
 print(json.dumps({'widths':[1440,390],'fixed_bar_restore_serialization_failure_retry_single_save_stale_history_count':'passed'}))
finally:proc.terminate();proc.wait(timeout=10)
