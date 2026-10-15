// Fake YouTube Data API v3: /search and /videos, with a few videos that must be filtered out.
import http from 'node:http';
const calls = { search: 0, videos: 0, chart: 0, badKey: 0, queries: [], maxIdsPerCheck: 0 };
const QUOTA_AFTER = Number(process.env.QUOTA_AFTER || 1e9);
const id = (n) => (`vid${n}`.padEnd(11, 'x')).slice(0, 11);
const BAD = { [id(2)]: 'private', [id(3)]: 'age', [id(4)]: 'region', [id(5)]: 'noembed', [id(6)]: 'upcoming', [id(7)]: 'vertical', [id(8)]: 'shorts-tag', [id(9)]: 'too-short' };
function video(vid, q) {
  const bad = BAD[vid];
  return {
    id: vid,
    snippet: { title: `${q} & "friends" — a longer video title to check wrapping ${vid}${bad === 'shorts-tag' ? ' #shorts' : ''}`, channelTitle: 'Some Channel', liveBroadcastContent: bad === 'upcoming' ? 'upcoming' : 'none' },
    player: { embedWidth: '480', embedHeight: bad === 'vertical' ? '853' : '270' },
    status: { privacyStatus: bad === 'private' ? 'private' : 'public', embeddable: bad !== 'noembed', uploadStatus: 'processed' },
    contentDetails: {
      duration: bad === 'too-short' ? 'PT40S' : 'PT4M2S',
      contentRating: bad === 'age' ? { ytRating: 'ytAgeRestricted' } : {},
      ...(bad === 'region' ? { regionRestriction: { blocked: ['IN', 'PK'] } } : {})
    }
  };
}
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Content-Type', 'application/json');
  if (u.pathname === '/__calls') return res.end(JSON.stringify(calls));
  if (u.searchParams.get('key') !== 'test-key') { calls.badKey++; res.statusCode = 400; return res.end(JSON.stringify({ error: { message: 'API key not valid' } })); }
  if (u.pathname === '/search') {
    if (calls.search >= QUOTA_AFTER) { res.statusCode = 403; return res.end(JSON.stringify({ error: { errors: [{ reason: 'quotaExceeded' }], message: 'quota' } })); }
    calls.search++; calls.queries.push(u.searchParams.get('q'));
    // Rows made for India search as seen from India; the others worldwide (no region)
    calls.searchRegions = calls.searchRegions || {}; const sr = u.searchParams.get('regionCode') || 'none'; calls.searchRegions[sr] = (calls.searchRegions[sr] || 0) + 1;
    const ok = u.searchParams.get('videoEmbeddable') === 'true' && u.searchParams.get('type') === 'video';
    if (!ok) { res.statusCode = 400; return res.end('{}'); }
    const base = calls.search * 100;
    const items = Array.from({ length: 14 }, (_, i) => ({ id: { videoId: i < 9 ? id(i + 1) : id(base + i) } }));
    return res.end(JSON.stringify({ items }));
  }
  if (u.pathname === '/videos') {
    if (u.searchParams.get('chart') === 'mostPopular') {
      calls.chart++;
      calls.charts = calls.charts || {}; const cat = u.searchParams.get('videoCategoryId'); calls.charts[cat] = (calls.charts[cat] || 0) + 1;
      const region = u.searchParams.get('regionCode');
      calls.chartRegions = calls.chartRegions || {}; calls.chartRegions[region] = (calls.chartRegions[region] || 0) + 1;
      if (cat === '28') { res.statusCode = 404; return res.end(JSON.stringify({ error: { errors: [{ reason: 'videoChartNotFound' }], message: 'chart not found' } })); }
      // Each country's chart has its own videos (vid9xx for India, vid19xx for the US, ...)
      const base = 900 + Number(cat) * 10 + Math.max(0, ['IN', 'US', 'GB', 'CA', 'AU', 'DE', 'FR', 'BR', 'JP', 'KR'].indexOf(region)) * 1000;
      return res.end(JSON.stringify({ items: [id(3), id(7), id(base), id(base + 1), id(base + 2), id(4), id(9)].map((v) => video(v, 'Trending ' + cat)) }));
      return res.end(JSON.stringify({ items: [id(3), id(900), id(901), id(4)].map((v) => video(v, 'Top hit')) }));
    }
    calls.videos++;
    const ids = u.searchParams.get('id').split(',');
    calls.maxIdsPerCheck = Math.max(calls.maxIdsPerCheck, ids.length);
    return res.end(JSON.stringify({ items: ids.map((v) => video(v, 'Result')) }));
  }
  res.statusCode = 404; res.end('{}');
}).listen(9911, () => console.log('fake youtube on 9911'));
