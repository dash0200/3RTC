"""Quick picks: YouTube trending is a worldwide mix by default (wherever you are), and "Trending in"
switches to one country's charts, remembered. Uses the fake YouTube API: each country's chart has
its own videos (India vid10xx, US vid20xx ... Japan vid90xx for Music)."""
import os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = harness.dev()
INIT = harness.signal_init(harness.quickpicks()) + "localStorage.removeItem('3rtc_quick_picks');"
errors = []


def trending_ids(pg):
    """Video ids of the Trending > Music row, from the thumbnails."""
    pg.locator('.qp-group', has_text='Trending').click()
    pg.locator('.qp-chip', has_text='Music').first.click()
    pg.wait_for_timeout(200)
    return pg.evaluate("[...document.querySelectorAll('.qp-card img')].map(i => (i.src.match(/vi\\/([^/]+)\\//) || [])[1])")


def open_page(b, tz, locale='en-US', keep=False):
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id=tz, locale=locale)
    pg = ctx.new_page()
    pg.add_init_script(INIT if not keep else INIT.replace("localStorage.removeItem('3rtc_quick_picks');", ''))
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto(BASE)
    pg.wait_for_timeout(1200)
    pg.locator('button.btn.btn-primary', has_text=re.compile('Create', re.I)).first.click()
    pg.get_by_role('button', name=re.compile('Generate 5-Digit Room')).click()
    pg.wait_for_selector('.qp-card', timeout=20000)
    wait(lambda: pg.locator('.qp-region-btn').count() == 1, 10)
    return pg


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    sel = lambda pg: pg.locator('.qp-region-btn')
    current = lambda pg: pg.locator('.qp-region-btn').get_attribute('data-region')

    def choose(pg, code):
        pg.locator('.qp-region-btn').click()
        pg.locator(f'.qp-region-option[data-region="{code}"]').click()

    india = open_page(b, 'Asia/Kolkata', locale='en-IN')
    check('by default: Worldwide, even in India', current(india) == 'GLOBAL', current(india))
    ids = trending_ids(india)
    check('...a mix of the countries\' trending', len({i[:4] for i in ids}) >= 3, ids)
    us = open_page(b, 'America/New_York')
    check('...and in the US', current(us) == 'GLOBAL', current(us))

    # Picking a country
    choose(india, 'IN')
    check("choosing India shows India's trending", wait(lambda: (lambda x: len([i for i in x if i.startswith('vid10')]) >= 3 and not any(i.startswith('vid20') for i in x))(trending_ids(india)), 8), trending_ids(india))
    india.locator('.qp-group', has_text='Music').click()
    chips = india.locator('.qp-chips .qp-chip').all_inner_texts()
    check('...with Bollywood and South Hits first in Music', len(chips) >= 2 and 'Bollywood' in chips[0] and 'South' in chips[1], chips)
    us.locator('.qp-group', has_text='Music').click()
    chips = us.locator('.qp-chips .qp-chip').all_inner_texts()
    check('Worldwide: Bollywood and South Hits still there, later in Music', 'Bollywood' in ' '.join(chips) and 'Bollywood' not in chips[0], chips)
    trending_ids(us)  # back on the Trending tab, where the choice is
    choose(us, 'JP')
    check("choosing Japan shows Japan's trending", wait(lambda: len([i for i in trending_ids(us) if i.startswith('vid90')]) >= 3, 8), trending_ids(us))

    us.goto(BASE + '/about')  # leave, and come back another day
    us.goto(BASE)
    us.wait_for_timeout(1200)
    us.locator('button.btn.btn-primary', has_text=re.compile('Create', re.I)).first.click()
    us.get_by_role('button', name=re.compile('Generate 5-Digit Room')).click()
    us.wait_for_selector('.qp-card')
    check('...and the choice is remembered', wait(lambda: sel(us).count() and current(us) == 'JP', 10), current(us) if sel(us).count() else None)
    choose(us, 'GLOBAL')
    check('back to Worldwide', wait(lambda: len({i[:4] for i in trending_ids(us)}) >= 3, 8))
    trending_ids(us)
    us.locator('.qp-region-btn').click()
    check('the menu lists Worldwide and the countries', us.locator('.qp-region-option').count() == 11 and 'Worldwide' in us.locator('.qp-region-option').first.inner_text())
    us.screenshot(path=str(harness.OUT / 'quick_picks_region.png'))
    us.keyboard.press('Escape')
    check('Escape closes it', wait(lambda: us.locator('.qp-region-menu').count() == 0, 3))
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
