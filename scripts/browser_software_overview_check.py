import json, os, subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
repo=Path(__file__).resolve().parents[1]
artifacts=Path(os.environ.get('OVERVIEW_ARTIFACTS','/tmp/studio-software-overview'));artifacts.mkdir(parents=True,exist_ok=True)
proc=subprocess.Popen(['node','scripts/document-browser-server.mjs',str(repo)],cwd=repo,env={**os.environ,'SOFTWARE_OVERVIEW_FIXTURE':'1'},stdout=subprocess.PIPE,text=True)
try:
 info=json.loads(proc.stdout.readline());base=f"http://127.0.0.1:{info['port']}";url=base+'/api/extensions/xangi-studio/ui'
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path=os.environ.get('BROWSER_EXECUTABLE','/snap/bin/chromium'),args=['--no-sandbox'])
  for width in [1440,390]:
   for kind,target in [('repository','https://github.com/example/repo'),('pr','https://github.com/example/repo/pull/1')]:
    page=browser.new_page(viewport={'width':width,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.route('**/github-description',lambda route:route.fulfill(json={'title':'Example','body':'Description','url':target}))
    page.goto(url+'?import=1');page.locator('#pr-url').fill(target);page.locator('#pr-url').press('Enter')
    overview=page.get_by_role('button',name='概要・図解',exact=True)
    expect(overview).to_be_visible(timeout=15000);overview.click()
    if page.get_by_role('heading',name='概要はまだ生成されていません').is_visible():
     page.get_by_role('button',name='概要を生成する',exact=True).click()
     page.get_by_role('button',name='概要の作成を開始する',exact=True).click()
    expect(page.get_by_role('heading',name='構成と関係',exact=True)).to_be_visible(timeout=15000)
    expect(page.get_by_label('要素間の関係')).to_contain_text('検証済みの値を渡す')
    expect(page.get_by_label('人に確認したい判断点')).to_contain_text('空値を許可しない仕様でよいか')
    expect(page.get_by_label('検証と未確認')).to_contain_text('テスト未実行')
    expect(page.locator('.software-overview img')).to_have_count(0)
    assert page.evaluate('window.overviewInjected') is None
    page.get_by_text('対象版と確認範囲',exact=True).click()
    expect(page.locator('.software-revision')).to_contain_text('a'*40 if kind=='repository' else 'a:b')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(artifacts/f'{kind}-{width}.png'),full_page=True)
    page.get_by_label('検証と未確認',exact=True).scroll_into_view_if_needed()
    expect(page.get_by_label('検証と未確認',exact=True)).to_be_visible()
    page.screenshot(path=str(artifacts/f'{kind}-{width}-decisions.png'),full_page=True)
    page.locator('.software-source-links button').first.click()
    expect(page.get_by_role('button',name='このファイルをレビュー',exact=True)).to_be_visible(timeout=5000)
    page.go_back();expect(overview).to_be_visible(timeout=10000);overview.click()
    expect(page.get_by_role('heading',name='構成と関係',exact=True)).to_be_visible(timeout=10000)
    page.reload();overview.click();expect(page.get_by_role('heading',name='構成と関係',exact=True)).to_be_visible(timeout=10000)
    page.get_by_role('button',name='ファイル',exact=True).click()
    expect(page.locator('.repository-browser' if kind=='repository' else '.pr-files-all')).to_be_visible()
    assert not errors,errors
    page.close()
  browser.close()
 print(json.dumps({'widths':[1440,390],'targets':['PR','repository'],'generate_diagram_evidence_back_reload_files_xss':'passed'}))
finally:proc.terminate();proc.wait(timeout=10)
