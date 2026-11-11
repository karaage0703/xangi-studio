import subprocess,json,sys,os
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
repo=Path(__file__).resolve().parents[1];out=repo/'artifacts';out.mkdir(exist_ok=True)
proc=subprocess.Popen(['node',str(repo/'scripts/document-browser-server.mjs'),str(repo)],stdout=subprocess.PIPE,text=True)
try:
 info=json.loads(proc.stdout.readline());base=f"http://127.0.0.1:{info['port']}"
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path=os.environ.get('BROWSER_EXECUTABLE'),args=['--no-sandbox'])
  page=browser.new_page(viewport={'width':1440,'height':900});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(base+'/api/extensions/xangi-studio/ui?import=1')
  page.locator('#pdf-file').set_input_files(info['root']+'/sample.pdf')
  page.get_by_role('button',name='資料を取り込む',exact=True).click()
  expect(page.get_by_role('img',name='sample.pdf 1ページ')).to_be_visible(timeout=20000)
  sidebar=page.locator('#artifact-navigation')
  toggle=page.locator('.artifact-sidebar-toggle')
  expect(sidebar).to_be_visible()
  before_width=page.locator('.artifact-detail').bounding_box()['width']
  toggle.click();expect(sidebar).to_be_hidden()
  assert page.locator('.artifact-detail').bounding_box()['width']>before_width
  page.screenshot(path=str(out/'sidebar-closed-desktop.png'))
  page.reload();expect(sidebar).to_be_hidden()
  toggle.click();expect(sidebar).to_be_visible()
  sidebar.get_by_role('button',name='サイドバーを閉じる',exact=True).click()
  expect(sidebar).to_be_hidden();expect(toggle).to_be_focused()
  toggle.click()
  for width in [375,768]:
   page.set_viewport_size({'width':width,'height':900})
   expect(sidebar).to_be_hidden()
   toggle.click();expect(sidebar).to_be_visible()
   expect(sidebar).to_have_attribute('aria-modal','true')
   page.screenshot(path=str(out/f'sidebar-open-{width}.png'))
   page.keyboard.press('Shift+Tab')
   assert sidebar.evaluate('(e)=>e.contains(document.activeElement)')
   page.keyboard.press('Tab')
   expect(sidebar.get_by_role('button',name='サイドバーを閉じる',exact=True)).to_be_focused()
   page.keyboard.press('Escape');expect(sidebar).to_be_hidden();expect(toggle).to_be_focused()
   toggle.click()
   page.locator('.artifact-scrim').click(position={'x':width-5,'y':450})
   expect(sidebar).to_be_hidden()
  toggle.click()
  sidebar.get_by_role('link').filter(has_text='sample.pdf').click()
  expect(page.get_by_role('img',name='sample.pdf 1ページ')).to_be_visible()
  expect(sidebar).to_be_hidden()
  page.set_viewport_size({'width':1440,'height':900})
  expect(sidebar).to_be_visible()
  for width in [1440,768,414,375,320]:
   page.set_viewport_size({'width':width,'height':900})
   page.get_by_role('button',name='次のページ',exact=True).click()
   expect(page.get_by_role('img',name='sample.pdf 2ページ')).to_be_visible()
   page.get_by_role('button',name='前のページ',exact=True).click()
   expect(page.get_by_role('img',name='sample.pdf 1ページ')).to_be_visible()
   state=page.evaluate('''() => ({width:innerWidth, overflow:document.documentElement.scrollWidth>innerWidth, nested:[...document.querySelectorAll('.artifact-detail,.main-panel,.content-area,.document-view')].filter(e=>['auto','scroll'].includes(getComputedStyle(e).overflowY)&&e.scrollHeight>e.clientHeight+1).map(e=>e.className),fonts:[...document.querySelectorAll('.review-action')].map(e=>getComputedStyle(e).fontSize)})''')
   assert not state['overflow'],state
   assert not state['nested'],state
   assert state['fonts']==['13px','13px'],state
   expect(page.locator('.review-context .review-title')).to_have_count(0)
   expect(page.locator('.review-context .notion-export')).to_have_count(1)
   image_box=page.locator('.document-image').bounding_box()
   overview_box=page.locator('.document-overview').bounding_box()
   assert overview_box['y'] >= image_box['y'] + image_box['height'], (image_box,overview_box)
   assert abs(overview_box['x']-image_box['x'])<1, (image_box,overview_box)
   page.locator('.document-image').scroll_into_view_if_needed()
   page.evaluate('window.scrollTo(0,0)')
   page.screenshot(path=str(out/f'layout-{width}.png'),full_page=True)
   print(json.dumps(state))
  assert not errors,errors
  browser.close()
finally:
 proc.terminate();proc.wait(timeout=10)
