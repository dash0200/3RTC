"""Quick picks: YouTube trending for the viewer's own country (from the time zone / language),
a worldwide mix elsewhere, and a "Trending in" choice that is remembered. Uses the fake YouTube
API: each country's chart has its own videos (India vid10xx, US vid20xx ... for Music)."""
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
    wait(lambda: pg.locator('.qp-region select').count() == 1, 10)
    return pg


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)

    india = open_page(b, 'Asia/Kolkata')
    sel = lambda pg: pg.locator('.qp-region select')
    check('India time zone: "Trending in India"', sel(india).input_value() == 'IN', sel(india).input_value())
    ids = trending_ids(india)
    check("...India's trending videos", len([i for i in ids if i.startswith('vid10')]) >= 3 and not any(i.startswith('vid20') for i in ids), ids)
    india.locator('.qp-group', has_text='Music').click()
    chips = india.locator('.qp-chips .qp-chip').all_inner_texts()
    check('...Bollywood and South Hits first in Music', len(chips) >= 2 and 'Bollywood' in chips[0] and 'South' in chips[1], chips)

    us = open_page(b, 'America/New_York')
    check('US time zone: "Trending in United States"', sel(us).input_value() == 'US', sel(us).input_value())
    ids = trending_ids(us)
    check("...the US trending videos", len([i for i in ids if i.startswith('vid20')]) >= 3 and not any(i.startswith('vid10') for i in ids), ids)
    us.locator('.qp-group', has_text='Music').click()
    chips = us.locator('.qp-chips .qp-chip').all_inner_texts()
    check('...Bollywood and South Hits still there, later in Music', 'Bollywood' in ' '.join(chips) and 'Bollywood' not in chips[0], chips)

    dubai = open_page(b, 'Asia/Dubai', locale='ar-AE')
    check('a country without its own list: Worldwide', sel(dubai).input_value() == 'GLOBAL', sel(dubai).input_value())
    ids = trending_ids(dubai)
    check('...a mix of the countries\' trending', len({i[:4] for i in ids}) >= 3, ids)

    # Picking another country
    sel(dubai).select_option('JP')
    check('choosing Japan shows Japan\'s trending', wait(lambda: len([i for i in trending_ids(dubai) if i.startswith('vid90')]) >= 3, 8), trending_ids(dubai))
    dubai.goto(BASE + '/about')  # leave, and come back another day
    dubai.goto(BASE)
    dubai.wait_for_timeout(1200)
    dubai.locator('button.btn.btn-primary', has_text=re.compile('Create', re.I)).first.click()
    dubai.get_by_role('button', name=re.compile('Generate 5-Digit Room')).click()
    dubai.wait_for_selector('.qp-card')
    check('...and it is remembered', wait(lambda: sel(dubai).count() and sel(dubai).input_value() == 'JP', 10), sel(dubai).input_value() if sel(dubai).count() else None)
    dubai.screenshot(path=str(harness.OUT / 'quick_picks_region.png'))
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
