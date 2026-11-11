import subprocess,json,time,urllib.request,sys,os
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
repo=str(Path(__file__).resolve().parents[1]);out=Path(repo)/'artifacts';out.mkdir(exist_ok=True)
proc=subprocess.Popen(['node',str(Path(repo)/'scripts/document-browser-server.mjs'),repo],stdout=subprocess.PIPE,text=True)
try:
 info=json.loads(proc.stdout.readline());base=f"http://127.0.0.1:{info['port']}"
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path=os.environ.get('BROWSER_EXECUTABLE'),args=['--no-sandbox'])
  page=browser.new_page(viewport={'width':1440,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(base+'/api/extensions/xangi-studio/ui?import=1');expect(page.get_by_text('試用版',exact=True)).to_have_count(0);page.locator('#pdf-file').set_input_files({'name':'sample.pdf','mimeType':'application/pdf','buffer':Path(info['root']+'/sample.pdf').read_bytes()});page.locator('.pdf-import summary').click();page.locator('#file-context').fill('初心者向けの説明と数値の根拠を確認。参考資料：社内仕様の抜粋');page.get_by_role('button',name='資料を取り込む',exact=True).click()
  expect(page.get_by_role('img',name='sample.pdf 1ページ')).to_be_visible(timeout=20000);expect(page.get_by_role('link',name='xangiホーム',exact=True)).to_have_attribute('href','/')
  page.get_by_role('button',name='次のページ',exact=True).click();expect(page.get_by_role('img',name='sample.pdf 2ページ')).to_be_visible()
  expect(page.get_by_text('AIレビュー中 — 完了後に自動保存します',exact=False)).to_have_count(2)
  page.reload();expect(page.get_by_text('AIレビュー中 — 完了後に自動保存します',exact=False)).to_have_count(2);saved=page.url;page.close()
  for _ in range(30):
   stats=json.load(urllib.request.urlopen(base+'/stats'))
   if len(stats['jobs'])==2 and all(j['status']=='completed' for j in stats['jobs']):break
   time.sleep(.3)
  assert stats['jobs'][0]['status']=='completed',stats
  assert all('初心者向け' in j['changeSet']['reviewContext'] for j in stats['jobs']),stats
  assert all('初心者向け' in prompt for prompt in stats['prompts']),stats
  page=browser.new_page(viewport={'width':1440,'height':1000});page.on('pageerror',lambda e:errors.append(str(e)));page.goto(saved)
  expect(page.locator('.document-note').filter(has_text='確認済みページ2').first).to_be_visible()
  page.screenshot(path=str(out/'pdf-desktop.png'))
  page.get_by_role('button',name='コード・画像付きでNotionに保存',exact=True).click();expect(page.get_by_role('link',name='保存したNotionページを開く')).to_be_visible()
  page.get_by_role('button',name='コード・画像付きでNotionに保存',exact=True).click();expect(page.get_by_role('link',name='保存したNotionページを開く')).to_be_visible()
  page.set_viewport_size({'width':390,'height':844});page.get_by_role('button',name='前のページ',exact=True).click();expect(page.get_by_role('img',name='sample.pdf 1ページ')).to_be_visible()
  page.locator('.document-note').first.scroll_into_view_if_needed();expect(page.locator('.document-note')).to_have_count(2);page.screenshot(path=str(out/'pdf-mobile.png'))
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),page.evaluate('[document.documentElement.scrollWidth,innerWidth]')
  stats=json.load(urllib.request.urlopen(base+'/stats'));assert stats['notionCalls']==1,stats;assert stats['chats']==2,stats;assert not errors,errors
  print(json.dumps({'pdf_bytes':Path(info['root']+'/sample.pdf').stat().st_size,'pages':len(stats['reviews']),'closed_browser_collection':stats['jobs'][0]['status'],'notion_calls':stats['notionCalls'],'js_errors':errors,'mobile_width':390}))
  # Additional source formats use the same real conversion and multi-review path.
  page.set_viewport_size({'width':1440,'height':1000})
  for index,name in enumerate(['two-slides.pptx','two-pages.docx','two-pages.doc']):
   page.get_by_role('button',name='変更セット一覧を開く').click();page.get_by_role('button',name='PR・資料を取り込む',exact=True).click()
   page.locator('#pdf-file').set_input_files(str(Path(repo)/'tests/fixtures'/name));page.get_by_role('button',name='資料を取り込む',exact=True).click()
   expect(page.get_by_role('img',name=f'{name} 1ページ')).to_be_visible(timeout=20000)
   expect(page.locator('.document-note').filter(has_text='Reviewer B').first).to_be_visible(timeout=20000)
  expect(page.get_by_role('region',name='資料全体の概要').get_by_text('初心者向けに生成AIの活用方法と具体例を紹介する資料です。',exact=True)).to_have_count(2)
  for kind,title in [('presentation','Google Slides sample'),('document','Google Docs sample')]:
   page.get_by_role('button',name='変更セット一覧を開く').click();page.get_by_role('button',name='PR・資料を取り込む',exact=True).click()
   page.locator('#google-url').fill(f'https://docs.google.com/{kind}/d/test_{kind}/edit')
   page.locator('#google-context').locator('..').locator('summary').click() if not page.locator('#google-context').is_visible() else None
   page.locator('#google-context').fill('Google資料の構成を確認:'+kind)
   page.locator('#google-url').press('Enter')
   expect(page.get_by_role('img',name=f'{title} 1ページ')).to_be_visible(timeout=20000)
   expect(page.locator('.document-note').filter(has_text='Reviewer B').first).to_be_visible(timeout=20000)
  page.get_by_role('button',name='変更セット一覧を開く').click();page.get_by_role('button',name='PR・資料を取り込む',exact=True).click()
  page.locator('#pr-url').fill('https://github.com/example/repo/pull/1');page.locator('#pr-context').locator('..').locator('summary').click();page.locator('#pr-context').fill('認証の境界を重点確認');page.locator('#pr-url').press('Enter')
  expect(page.get_by_text('AIレビュー完了: 1/1ファイル',exact=False)).to_have_count(2,timeout=20000)
  before=json.load(urllib.request.urlopen(base+'/stats'))
  assert before['chats']==14,before
  assert all('認証の境界を重点確認' in p for p in before['prompts'][-2:]),before
  assert all('Google資料の構成を確認' in p for p in before['prompts'][8:12]),before
  assert all('初心者向けの説明と数値' not in p for p in before['prompts'][2:]),before
  page.get_by_role('button',name='更新を確認',exact=True).click()
  page.get_by_text('PRに更新はありません。取り込みは行いませんでした。').wait_for()
  stats=json.load(urllib.request.urlopen(base+'/stats'));assert stats['chats']==14,stats
  pr=next(r for r in stats['reviews'] if r['changeSet']['kind']=='github-pr')
  assert len(pr['explanations'])==2,pr
  page.set_viewport_size({'width':390,'height':844})
  page.reload()
  expect(page.locator('.change-notes')).to_be_visible()
  page.get_by_role('button',name='変更セット一覧を開く').click()
  expect(page.locator('.review-folder > summary').filter(has_text='src')).to_be_visible()
  assert page.locator('.review-folder > summary').filter(has_text='changes').count()==0
  page.locator('.review-folder > summary').filter(has_text='src').click()
  expect(page.locator('.file-item').filter(has_text='example.ts')).not_to_be_visible()
  page.locator('.review-folder > summary').filter(has_text='src').click()
  expect(page.locator('.file-item').filter(has_text='example.ts')).to_be_visible()
  assert not errors,errors
  page.screenshot(path=str(out/'multi-review-pr.png'))
  print(json.dumps({'formats':['PDF','PPTX','DOCX','DOC','Google Slides','Google Docs','GitHub PR'],'reviewer_jobs':len(stats['jobs']),'pr_import_auto_review':True,'unchanged_pr_no_new_review':True,'js_errors':errors}))
  # Results are a read operation. Re-review requires an explicit confirmation.
  page.goto(saved)
  expect(page.get_by_role('button',name='レビュー結果を見る',exact=True)).to_be_visible()
  prior=json.load(urllib.request.urlopen(base+'/stats'));before_chats=prior['chats']
  page.get_by_role('button',name='レビュー結果を見る',exact=True).click()
  assert json.load(urllib.request.urlopen(base+'/stats'))['chats']==before_chats
  page.get_by_role('button',name='再レビュー…',exact=True).click()
  expect(page.get_by_role('button',name='レビューを開始する',exact=True)).to_be_disabled()
  page.get_by_role('checkbox',name='この対象・観点・担当で実行する').check()
  page.get_by_role('button',name='レビューを開始する',exact=True).click()
  expect(page.get_by_role('button',name='AIレビュー中',exact=True)).to_be_disabled()
  for _ in range(60):
   stats=json.load(urllib.request.urlopen(base+'/stats'))
   if stats['chats']==before_chats+2 and all(j['status']=='completed' for j in stats['jobs']):break
   time.sleep(.3)
  assert stats['chats']==before_chats+2 and all(j['status']=='completed' for j in stats['jobs'])
  expect(page.get_by_role('button',name='レビュー結果を見る',exact=True)).to_be_visible()
  original_reviews=stats['reviews']
  page.get_by_role('button',name='編集用原稿を開く',exact=True).click()
  expect(page.get_by_label('編集する本文')).to_be_visible(timeout=15000)
  stats=json.load(urllib.request.urlopen(base+'/stats'));assert stats['studioStarts']==0;task=stats['studio']['tasks'][0]
  assert task['importSource']['reviewContext'].startswith('初心者向け')
  assert task['review']['findings']
  page.get_by_label('編集する本文').fill('# 手編集した資料')
  page.get_by_role('button',name='保存してレビュー',exact=True).click()
  for _ in range(60):
   stats=json.load(urllib.request.urlopen(base+'/stats'));task=stats['studio']['tasks'][0]
   if task['status']=='succeeded':break
   time.sleep(.3)
  assert task['status']=='succeeded' and len(task['runs'])==1 and len(task['versions'])==2,task
  assert task['versions'][-1]['content']=='# 手編集した資料'
  assert stats['reviews']==original_reviews
  page.get_by_role('textbox',name='追加の修正指示',exact=True).fill('指摘を反映して短くする')
  page.get_by_role('button',name='指示で修正・再レビュー',exact=True).click()
  for _ in range(60):
   stats=json.load(urllib.request.urlopen(base+'/stats'));task=stats['studio']['tasks'][0]
   if task['status']=='succeeded' and len(task['runs'])==3:break
   time.sleep(.3)
  assert [r['stage'] for r in task['runs']]==['review','revision','review'],task
  assert stats['reviews']==original_reviews
  page.get_by_role('link',name='成果物一覧',exact=True).click()
  expect(page.get_by_role('heading',name='成果物',exact=True)).to_be_visible()
  expect(page.locator('.workspace-artifacts li')).to_have_count(8)
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
  page.screenshot(path=str(out/'unified-home-mobile.png'),full_page=True)
  print(json.dumps({'unified_home':True,'results_do_not_start_ai':True,'explicit_rereview':True,'review_to_edit_to_review':True,'originals_preserved':True,'review_only_no_auto_revision':True}))
  browser.close()
finally:
 proc.terminate();proc.wait(timeout=10)
