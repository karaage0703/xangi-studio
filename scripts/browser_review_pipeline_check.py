"""Isolated UI acceptance: no external AI/GitHub/Notion requests."""
import json, os, subprocess, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo=Path(__file__).resolve().parents[1]
out=Path(os.environ.get('PIPELINE_ARTIFACTS','/tmp/studio-review-pipeline'));out.mkdir(parents=True,exist_ok=True)
results=[]
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path=os.environ.get('BROWSER_EXECUTABLE','/snap/bin/chromium'),args=['--no-sandbox'])
 try:
  for width in ([] if os.environ.get('PIPELINE_DOCUMENT_ONLY') else [1440,390]):
   for kind,target in [('pr','https://github.com/example/repo/pull/1'),('repository','https://github.com/example/repo')]:
    proc=subprocess.Popen(['node','scripts/document-browser-server.mjs',str(repo)],cwd=repo,env={**os.environ,'SOFTWARE_OVERVIEW_FIXTURE':'1','REVIEW_PIPELINE_FIXTURE':'1','REVIEW_PIPELINE_FAIL_ONCE':'1'},stdout=subprocess.PIPE,text=True)
    try:
     info=json.loads(proc.stdout.readline());base=f"http://127.0.0.1:{info['port']}"
     stats=lambda:json.load(urllib.request.urlopen(base+'/stats'))
     page=browser.new_page(viewport={'width':width,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
     page.route('**/github-description',lambda route:route.fulfill(json={'title':'Example','body':'Description','url':target}))
     page.goto(base+'/api/extensions/xangi-studio/ui?import=1');page.locator('#pr-url').fill(target);page.locator('#pr-url').press('Enter')
     review_label='PR全体をレビュー' if kind=='pr' else 'リポジトリ全体をレビュー'
     expect(page.get_by_role('button',name=review_label,exact=True)).to_be_visible(timeout=15000)
     assert stats()['chats']==0
     initial_explanations={r['file']:r['explanations'] for r in stats()['reviews']}
     page.get_by_role('button',name='概要を作成',exact=True).click()
     expect(page.locator('#review-instruction')).to_have_count(0)
     expect(page.get_by_role('radio')).to_have_count(2)
     page.get_by_role('button',name='概要の作成を開始する',exact=True).click()
     page.get_by_role('button',name='概要・図解',exact=True).click()
     expect(page.get_by_role('heading',name='構成と関係',exact=True)).to_be_visible(timeout=15000)
     s=stats();assert len(s['jobs'])==1 and s['jobs'][0]['purpose']=='overview'
     assert {r['file']:r['explanations'] for r in s['reviews']}==initial_explanations
     page.screenshot(path=str(out/f'{kind}-{width}-overview-only.png'),full_page=True)
     # One selected project must start THREE independent review conversations.
     page.get_by_role('button',name=review_label,exact=True).click()
     page.get_by_role('checkbox',name='Reviewer B',exact=True).uncheck()
     page.get_by_role('button',name='レビューを開始する',exact=True).click()
     deadline=time.time()+10
     while time.time()<deadline:
      s=stats(); jobs=[j for j in s['jobs'] if j.get('purpose')=='review']
      if len(jobs)==3 and len(s['prompts'])==4:break
      time.sleep(.05)
     assert len(jobs)==3 and all(j['reviewer']['id']=='xangi-default' for j in jobs),s
     scope=[f for j in jobs for f in j['files']]; assert len(scope)==len(set(scope))==6
     assert all('"overview"' not in prompt for prompt in s['prompts'][1:])
     starts=[x['at'] for x in s['chatStarts'] if x['sessionId'] in {j['sessionId'] for j in jobs}]
     assert len(starts)==3
     # Overview can run while review groups are still running.
     page.get_by_role('button',name='概要を作成',exact=True).click()
     page.get_by_role('button',name='概要の作成を開始する',exact=True).click()
     deadline=time.time()+10
     while time.time()<deadline:
      s=stats()
      if len(s['prompts'])==5:break
      time.sleep(.05)
     assert len(s['prompts'])==5 and any(j['status']=='running' and j.get('purpose')=='review' for j in s['jobs'])
     saved=page.url;page.close()
     deadline=time.time()+15
     while time.time()<deadline:
      s=stats()
      if len(s['jobs'])==5 and all(j['status']!='running' for j in s['jobs']):break
      time.sleep(.2)
     jobs=[j for j in s['jobs'] if j.get('purpose')=='review']
     assert sorted(j['status'] for j in jobs)==['completed','completed','failed'],s
     finishes=[x['at'] for x in s['chatFinishes'] if x['sessionId'] in {j['sessionId'] for j in jobs}]
     assert max(starts)<min(finishes),'review requests did not overlap'
     assert all(r.get('explanations') for r in s['reviews'] if r['file'] not in next(j['files'] for j in jobs if j['status']=='failed'))
     page=browser.new_page(viewport={'width':width,'height':1000});page.on('pageerror',lambda e:errors.append(str(e)));page.goto(saved)
     expect(page.get_by_role('button',name=review_label,exact=True)).to_be_visible(timeout=10000)
     expect(page.get_by_text('AI処理失敗:',exact=False)).to_be_visible()
     page.screenshot(path=str(out/f'{kind}-{width}-partial-failure.png'),full_page=True)
     # Two projects must each receive all three groups, with no new overview.
     page.get_by_role('button',name=review_label,exact=True).click()
     expect(page.get_by_role('checkbox',name='Reviewer B',exact=True)).to_be_checked()
     page.get_by_role('button',name='レビューを開始する',exact=True).click()
     deadline=time.time()+15
     while time.time()<deadline:
      s=stats()
      if len(s['jobs'])==11 and all(j['status']!='running' for j in s['jobs']):break
      time.sleep(.2)
     latest=s['jobs'][-6:];assert all(j['status']=='completed' for j in latest),s
     for reviewer in ['xangi-default','reviewer-b']:
      assert len([j for j in latest if j['reviewer']['id']==reviewer])==3
     assert len([j for j in s['jobs'] if j.get('purpose')=='overview'])==2
     assert all(len(r['reviewerResults'])==2 for r in s['reviews'])
     page.reload();expect(page.get_by_role('button',name='概要・図解',exact=True)).to_be_visible()
     expect(page.get_by_text('AI処理失敗:',exact=False)).to_have_count(0)
     page.get_by_role('button',name='概要・図解',exact=True).click()
     expect(page.get_by_role('heading',name='構成と関係',exact=True)).to_be_visible()
     assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
     page.screenshot(path=str(out/f'{kind}-{width}-completed.png'),full_page=True)
     page.locator('.pr-conversations summary').click()
     expect(page.locator('.pr-conversations a')).to_have_count(7)
     expect(page.locator('.pr-conversations')).to_contain_text('Reviewer B / レビュー 1/3')
     assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
     page.screenshot(path=str(out/f'{kind}-{width}-conversations.png'),full_page=True)
     page.locator('.pr-conversations summary').click()
     assert not errors,errors;page.close()
     results.append({'target':kind,'width':width,'overview_only':True,'single_groups':3,'multi_groups':6,'parallel_overlap':True,'partial_failure_preserved':True,'closed_browser_collection':True,'reload':True})
    finally:proc.terminate();proc.wait(timeout=10)
  # Existing PDF reviews keep one whole-document conversation per reviewer.
  proc=subprocess.Popen(['node','scripts/document-browser-server.mjs',str(repo)],cwd=repo,stdout=subprocess.PIPE,text=True)
  try:
   info=json.loads(proc.stdout.readline());base=f"http://127.0.0.1:{info['port']}"
   stats=lambda:json.load(urllib.request.urlopen(base+'/stats'))
   page=browser.new_page(viewport={'width':1440,'height':1000})
   page.goto(base+'/api/extensions/xangi-studio/ui?import=1')
   page.locator('#pdf-file').set_input_files({'name':'sample.pdf','mimeType':'application/pdf','buffer':Path(info['root']+'/sample.pdf').read_bytes()})
   page.get_by_role('button',name='資料を取り込む',exact=True).click()
   expect(page.get_by_role('img',name='sample.pdf 1ページ')).to_be_visible(timeout=20000)
   assert stats()['chats']==0
   page.get_by_role('button',name='資料をレビュー',exact=True).click()
   page.locator('#review-instruction').fill('初心者向けに構成を確認')
   page.get_by_role('button',name='レビューを開始する',exact=True).click()
   deadline=time.time()+15
   while time.time()<deadline:
    s=stats()
    if len(s['jobs'])==2 and all(j['status']=='completed' for j in s['jobs']):break
    time.sleep(.2)
   assert len(s['jobs'])==2 and all(j['status']=='completed' and j.get('group') is None for j in s['jobs'])
   assert all(len(r['reviewerResults'])==2 for r in s['reviews'])
   assert all('初心者向け' in prompt for prompt in s['prompts'])
   page.reload();expect(page.locator('.document-note').first).to_be_visible(timeout=10000)
   page.get_by_role('button',name='次のページ',exact=True).click()
   expect(page.get_by_role('img',name='sample.pdf 2ページ')).to_be_visible()
   page.screenshot(path=str(out/'pdf-1440-review.png'),full_page=True)
   page.set_viewport_size({'width':390,'height':844})
   expect(page.get_by_role('img',name='sample.pdf 2ページ')).to_be_visible()
   assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
   page.screenshot(path=str(out/'pdf-390-review.png'),full_page=True);page.close()
   results.append({'target':'PDF','manual_review':True,'whole_document_per_reviewer':True,'reviewers':2,'pages':len(s['reviews']),'reload':True})
  finally:proc.terminate();proc.wait(timeout=10)
 finally:browser.close()
print(json.dumps(results))
