"""Generates the static SEO pages in client/public. Edit the copy here, then run:
    python3 client/seo/build_pages.py
and commit the regenerated .html files (and add new pages to public/sitemap.xml)."""
import json, html, pathlib

OUT = pathlib.Path(__file__).resolve().parent.parent / 'public'
SITE = 'https://3rtc.me'
NAV = [('/about', 'About'), ('/youtube-watch-party', 'YouTube'), ('/watch-movies-together', 'Movies'), ('/watch-videos-together', 'Your videos')]
FOOT = [('/', 'Open 3RTC'), ('/about', 'About & FAQ'), ('/youtube-watch-party', 'YouTube watch party'),
        ('/watch-movies-together', 'Watch movies together'), ('/watch-videos-together', 'Watch your own videos together'),
        ('/privacy', 'Privacy')]


def page(slug, title, description, body, crumb, extra_ld=None, noindex=False):
    url = f'{SITE}{slug}'
    nav = ''.join(f'<a href="{h}"{" aria-current=\"page\"" if h == slug else ""}>{t}</a>' for h, t in NAV)
    foot = ''.join(f'<a href="{h}">{t}</a>' for h, t in FOOT)
    graph = []
    if crumb:
        graph.append({
            '@type': 'BreadcrumbList',
            'itemListElement': [
                {'@type': 'ListItem', 'position': 1, 'name': '3RTC', 'item': f'{SITE}/'},
                {'@type': 'ListItem', 'position': 2, 'name': crumb, 'item': url},
            ],
        })
    if extra_ld:
        graph.extend(extra_ld)
    ld = ''
    if graph:
        ld = ('<script type="application/ld+json">'
              + json.dumps({'@context': 'https://schema.org', '@graph': graph}, ensure_ascii=False, indent=1)
              + '</script>')
    t, d = html.escape(title), html.escape(description)
    head_seo = ('<meta name="robots" content="noindex">' if noindex else f'''<link rel="canonical" href="{url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="3RTC">
<meta property="og:url" content="{url}">
<meta property="og:title" content="{t}">
<meta property="og:description" content="{d}">
<meta property="og:image" content="{SITE}/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="{SITE}/og-image.png">''')
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{t}</title>
<meta name="description" content="{d}">
{head_seo}
<meta name="theme-color" content="#0b0b0e">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<link rel="stylesheet" href="/site.css">
{ld}
</head>
<body>
<header class="site-header"><div class="wrap">
<a class="logo" href="/"><img src="/favicon.svg" alt="" width="30" height="30">3RTC</a>
<nav class="site-nav" aria-label="Site">{nav}<a class="btn btn-sm" href="/">Open app</a></nav>
</div></header>
<main class="wrap">
{body}
</main>
<footer class="site-footer"><div class="wrap">
<nav aria-label="Footer">{foot}</nav>
<p>3RTC · watch videos together, peer to peer</p>
</div></footer>
</body>
</html>
'''


CTA = '''<div class="cta-row"><a class="btn" href="/">Start a watch party</a>
<span class="cta-note">Free · no sign-up · works in your browser</span></div>'''

# ---------------------------------------------------------------- /about (with FAQ)
FAQ = [
    ('Is 3RTC free?', 'Yes. There is no account, no subscription and no ads. Open 3rtc.me, create a room and share the code.'),
    ('How many people can watch together?', 'A room holds up to 6 people. Everyone connects directly to everyone else, which keeps voice and chat fast and private, and when someone shares a video file, viewers pass it along to each other so the person sharing it doesn\u2019t have to upload it to everyone.'),
    ('Do my friends need to install anything?', 'No. 3RTC runs in any modern browser, on computers and phones. You can also install it from the browser menu ("Install app" or "Add to Home screen") so it opens like a normal app.'),
    ('Can we watch a video file that only I have?', 'Yes. Pick an MP4, WebM or MKV file on your device and the others can stream it straight from you. Playback starts after a few seconds, the file is never uploaded to a server, and your friends do not need their own copy.'),
    ('Does it work with YouTube?', 'Yes. Paste any YouTube link and play, pause and seeking stay in sync for everyone in the room. You can also line up a queue of videos and vote to skip.'),
    ('Is the voice chat good quality?', 'Voice goes directly between you at high bitrate, with echo cancellation and noise suppression that removes background noise like fans and keyboards. You can use an always-on mic or push-to-talk.'),
    ('Does my video or voice go through your servers?', 'No. A small connection server introduces the devices in a room to each other, and after that video, voice, chat and images go directly between devices, encrypted by WebRTC.'),
    ('Can we watch Netflix, Prime Video or Disney+ together?', 'Not inside 3RTC. Those services protect their videos so they only play in their own apps and sites, so no outside watch party app can play them. With 3RTC you can watch YouTube together, or a movie or video file one of you has on your device.'),
    ('Is it good for long-distance movie nights?', 'Yes. That’s what it’s built for: everyone stays on the same frame, you can talk the whole time, and nobody needs an account. Pause for snacks and it pauses for everyone.'),
    ('Why can’t my friend connect?', 'Direct connections work on most home Wi-Fi and mobile networks, but some very strict networks (some offices, schools and public Wi-Fi) block them. Trying a different network, such as mobile data, usually fixes it.'),
    ('Can I use it on my phone?', 'Yes. 3RTC has a phone layout with the video on top and chat, queue and people in tabs below, plus hold-to-talk for voice.'),
]
faq_html = ''.join(f'<details><summary>{html.escape(q)}</summary><p>{html.escape(a)}</p></details>' for q, a in FAQ)
faq_ld = {'@type': 'FAQPage', 'mainEntity': [
    {'@type': 'Question', 'name': q, 'acceptedAnswer': {'@type': 'Answer', 'text': a}} for q, a in FAQ]}

about = f'''<p class="eyebrow">About 3RTC</p>
<h1>Watch together online with friends, in perfect sync</h1>
<p class="lede">3RTC is a free online watch party app. Play a YouTube video or a movie file from your own device, and everyone in the room sees the same moment at the same time, while you talk over voice chat and react in the chat. It’s made for watching together with friends who aren’t in the same room.</p>
{CTA}

<h2>What you can do</h2>
<ul class="features">
<li><strong>YouTube in sync</strong><span>Play, pause and seek once, and it happens for everyone.</span></li>
<li><strong>Your own video files</strong><span>Stream an MP4, WebM or MKV file straight from your device. No uploading.</span></li>
<li><strong>Clear voice chat</strong><span>Noise suppression, echo cancellation and push-to-talk.</span></li>
<li><strong>Live chat</strong><span>Messages, images, emoji reactions and a soundboard.</span></li>
<li><strong>Shared queue</strong><span>Line up what to watch next and vote to skip.</span></li>
<li><strong>Phone and computer</strong><span>Works in the browser, and installs like an app.</span></li>
</ul>

<h2>How it works</h2>
<ol class="steps">
<li>Open <a href="/">3rtc.me</a>, type your name and tap <strong>Create a room</strong>.</li>
<li>Share the 5-digit room code, link or QR code with up to five friends.</li>
<li>Add a YouTube link or pick a video file, and press play. Everyone stays in sync.</li>
</ol>

<h2>Peer to peer, by design</h2>
<p>Most watch party services send everything through their own servers. 3RTC connects your devices directly using WebRTC, the same technology video-call apps use. A small connection server only helps the devices in a room find each other; video, voice, chat and images then travel straight between you, encrypted. That is what keeps it fast, private and free to run. See the <a href="/privacy">privacy page</a> for exactly what is and isn’t shared.</p>

<h2>Frequently asked questions</h2>
{faq_html}

<div class="related"><h2>More about 3RTC</h2><ul>
<li><a href="/youtube-watch-party">How to host a YouTube watch party</a></li>
<li><a href="/watch-movies-together">Watch movies together online</a></li>
<li><a href="/watch-videos-together">Watch your own video files together online</a></li>
</ul></div>'''

# ---------------------------------------------------------------- /youtube-watch-party
yt = f'''<p class="eyebrow">YouTube watch party</p>
<h1>Watch YouTube together, in sync, with voice chat</h1>
<p class="lede">Paste a YouTube link into 3RTC and everyone in the room watches the same second of the same video. It’s an online watch party for YouTube: watch together with friends anywhere. Pause to talk, skip ahead, line up the next video, all while chatting by voice or text.</p>
{CTA}

<h2>How to host a YouTube watch party</h2>
<ol class="steps">
<li>Go to <a href="/">3rtc.me</a> and create a room. No account needed.</li>
<li>Send the room code or link to up to five friends. They join from any browser, on a phone or a computer.</li>
<li>Paste a YouTube link and press play. Play, pause and seeking are synced for everyone.</li>
<li>Add more links to the queue, or start from quick picks like lo-fi radio, synthwave and Blender\u2019s open movies.</li>
</ol>

<h2>Why watch YouTube on 3RTC</h2>
<ul class="features">
<li><strong>Stays in sync</strong><span>If someone pauses or jumps ahead, everyone follows.</span></li>
<li><strong>Talk while you watch</strong><span>Voice chat with noise suppression, or push-to-talk.</span></li>
<li><strong>Queue and vote skip</strong><span>Build a playlist together and skip what nobody wants.</span></li>
<li><strong>Chat and reactions</strong><span>Messages, images, emoji and soundboard effects.</span></li>
</ul>

<h2>Good to know</h2>
<p>Each person’s browser plays the video from YouTube itself, so everyone gets YouTube’s full quality and subtitles, and you can pick your own quality setting. A few videos can’t be embedded on other sites because their owner has turned that off; those won’t play in any watch party app.</p>

<div class="related"><h2>Related</h2><ul>
<li><a href="/watch-videos-together">Watch a movie file from your computer together</a></li>
<li><a href="/about">About 3RTC and FAQ</a></li>
</ul></div>'''

# ---------------------------------------------------------------- /watch-videos-together
local = f'''<p class="eyebrow">Your own videos</p>
<h1>Watch your own video files together online</h1>
<p class="lede">Have a movie or a clip on your computer or phone? Pick it in 3RTC and your friends can watch it with you in sync, streamed straight from your device. Nothing is uploaded to a server, and they don’t need their own copy.</p>
{CTA}

<h2>How it works</h2>
<ol class="steps">
<li>Create a room at <a href="/">3rtc.me</a> and invite up to five friends with the room code.</li>
<li>Choose a video file (MP4, WebM or MKV) or drag it onto the page.</li>
<li>Your friends tap <strong>Stream</strong>. Playback starts within seconds and keeps loading just ahead of where you are watching.</li>
<li>Play, pause and seek together. Everyone stays on the same frame.</li>
</ol>

<h2>Why it’s different</h2>
<ul class="features">
<li><strong>No uploading</strong><span>The video goes directly from your device to your friends’.</span></li>
<li><strong>Starts fast</strong><span>Friends can start watching without waiting for the whole file.</span></li>
<li><strong>Private</strong><span>Your file never sits on anyone else’s server.</span></li>
<li><strong>Voice and chat</strong><span>Talk and react while you watch.</span></li>
</ul>

<h2>Tips for smooth playback</h2>
<p>MP4 files (H.264 video with AAC audio) play in every browser. MKV and other formats play wherever the browser supports the codecs inside them; Chrome and Edge handle the most. Because the video streams from your device, a steady upload connection on your side helps, and keeping 3RTC open in the foreground prevents your device from pausing the stream.</p>

<div class="related"><h2>Related</h2><ul>
<li><a href="/youtube-watch-party">Host a YouTube watch party</a></li>
<li><a href="/about">About 3RTC and FAQ</a></li>
</ul></div>'''

# ---------------------------------------------------------------- /watch-movies-together
MOVIE_FAQ = [
    ('How do we watch a movie together online?', 'One of you opens 3RTC, creates a room and shares the 5-digit code. Pick the movie file on your device (or a YouTube video), and everyone else taps Stream. Play, pause and seeking stay in sync for everyone.'),
    ('Do my friends need the movie file too?', 'No. Only the person sharing it needs the file. It streams straight from their device to everyone in the room, starting within seconds, and it is never uploaded to a server.'),
    ('Can we watch Netflix or Prime Video together?', 'No. Netflix, Prime Video, Disney+ and similar services only play inside their own apps and sites. 3RTC works with YouTube and with movie or video files you have on your device.'),
    ('How many people can join a movie night?', 'Up to 6 people per room. When someone shares a movie file, viewers pass it along to each other, so the person sharing it doesn’t have to upload a copy for everyone.'),
]
movies_faq_html = ''.join(f'<details><summary>{html.escape(q)}</summary><p>{html.escape(a)}</p></details>' for q, a in MOVIE_FAQ)
movies_faq_ld = {'@type': 'FAQPage', 'mainEntity': [
    {'@type': 'Question', 'name': q, 'acceptedAnswer': {'@type': 'Answer', 'text': a}} for q, a in MOVIE_FAQ]}

movies = f"""<p class="eyebrow">Movie night</p>
<h1>Watch movies together online, with friends far away</h1>
<p class="lede">Have a movie night with friends in other cities. Everyone watches the same movie at the same moment, talks over voice chat and reacts in the chat, like sitting on the same couch. The easiest way to watch together when you can’t be in the same room: free, no sign-up, nothing to install.</p>
{CTA}

<h2>Movie night in three steps</h2>
<ol class="steps">
<li>Open <a href="/">3rtc.me</a>, create a room and send the room code to up to five friends.</li>
<li>Pick the movie: a file on your computer (MP4, WebM, MKV) or a YouTube film or trailer.</li>
<li>Press play. If anyone pauses for snacks, it pauses for everyone.</li>
</ol>

<h2>Made for watching together</h2>
<ul class="features">
<li><strong>Perfect sync</strong><span>Play, pause and seek once; everyone stays on the same frame.</span></li>
<li><strong>Talk while you watch</strong><span>Clear voice chat with noise removal, or push-to-talk.</span></li>
<li><strong>Your own movie files</strong><span>Streamed straight from your device. Friends don’t need a copy.</span></li>
<li><strong>Reactions and chat</strong><span>Emoji, images and clickable timestamps like 1:12:30.</span></li>
<li><strong>Host controls</strong><span>Lock playback so only the host can pause or skip.</span></li>
<li><strong>Phone or computer</strong><span>Join from any browser; the screen stays on while you watch.</span></li>
</ul>

<h2>Long-distance friends and couples</h2>
<p>3RTC is built for the people you can’t sit next to: friends who moved away, long-distance partners, family in another city. There’s no account to create and nothing to install, so getting everyone into the room takes one link or a 5-digit code.</p>

<h2>Questions</h2>
{movies_faq_html}

<div class="related"><h2>Related</h2><ul>
<li><a href="/youtube-watch-party">Host a YouTube watch party</a></li>
<li><a href="/watch-videos-together">Watch your own video files together</a></li>
<li><a href="/about">About 3RTC and FAQ</a></li>
</ul></div>"""

# ---------------------------------------------------------------- /privacy
privacy = '''<p class="eyebrow">Privacy</p>
<h1>Privacy at 3RTC</h1>
<p class="lede">3RTC has no accounts, no ads and no analytics. Your video, voice, chat and images travel directly between the devices in your room. Here is exactly what is shared, and with whom.</p>

<h2>What goes directly between devices</h2>
<p>Video streams, voice, chat messages, images, reactions and playback sync are sent straight from one device to the others in your room over WebRTC, which encrypts everything in transit. None of it passes through or is stored on 3RTC’s servers.</p>

<h2>What the connection server sees</h2>
<p>To introduce devices to each other, 3RTC runs a small connection (signaling) server. It handles your room code, the display name you choose, a random session ID and the network details your browser needs to connect (which include IP addresses). It keeps this only while your room is open, and its logs record room codes and session IDs, not names or messages.</p>

<h2>Other services involved</h2>
<table>
<tr><th>Service</th><th>Why</th><th>What it receives</th></tr>
<tr><td>Google STUN servers</td><td>Helps devices find a direct route to each other</td><td>Your IP address</td></tr>
<tr><td>YouTube</td><td>Plays YouTube videos inside the room</td><td>What YouTube normally receives when you watch an embedded video, under Google’s privacy policy</td></tr>
<tr><td>noembed.com</td><td>Looks up a YouTube video’s title</td><td>The video link</td></tr>
<tr><td>Google Fonts</td><td>Loads the app’s fonts</td><td>Your IP address and browser details</td></tr>
<tr><td>Vercel</td><td>Hosts the website</td><td>Standard web request information</td></tr>
</table>

<h2>The people in your room</h2>
<p>Because devices connect directly, people in the same room can see each other’s IP addresses, as with any peer-to-peer app. Only share your room code with people you trust.</p>

<h2>What is stored on your device</h2>
<p>Your browser keeps your display name and settings (audio, volume, layout) in local storage so you don’t have to set them again, and the installed app caches its own files so it opens quickly. 3RTC sets no tracking cookies. Clearing your browser data removes all of this.</p>'''

# ---------------------------------------------------------------- 404
nf = '''<p class="eyebrow">404</p>
<h1>This page doesn’t exist</h1>
<p class="lede">The link may be old or mistyped. If you were given a room code, open 3RTC and enter it there.</p>
<div class="cta-row"><a class="btn" href="/">Open 3RTC</a></div>'''

pages = {
    'about.html': page('/about', 'About 3RTC – Free Watch Party App with Voice Chat',
                       'Watch YouTube or your own video files together in sync, with voice chat and live chat. How 3RTC works, what it can do, and answers to common questions.',
                       about, 'About', [faq_ld]),
    'youtube-watch-party.html': page('/youtube-watch-party', 'YouTube Watch Party – Watch YouTube Together in Sync | 3RTC',
                                     'Watch YouTube together with friends in perfect sync. Free, no sign-up: create a room, share the code, paste a link, and talk over voice chat while you watch.',
                                     yt, 'YouTube watch party'),
    'watch-videos-together.html': page('/watch-videos-together', 'Watch Your Own Video Files Together Online | 3RTC',
                                       'Stream a movie or video file from your device to friends and watch it together in sync. No uploading, no copy needed on their side. MP4, WebM and MKV.',
                                       local, 'Watch your own videos together'),
    'watch-movies-together.html': page('/watch-movies-together', 'Watch Movies Together Online – Free Movie Night | 3RTC',
                                       'Watch movies together online with friends far away: synced playback, voice chat and live chat. Free, no sign-up. Use your own movie files or YouTube.',
                                       movies, 'Watch movies together', [movies_faq_ld]),
    'privacy.html': page('/privacy', 'Privacy – 3RTC', 'What 3RTC shares and with whom: no accounts, no ads, no analytics. Video, voice and chat go directly between devices.',
                         privacy, 'Privacy'),
    '404.html': page('/404', 'Page not found – 3RTC', 'This page does not exist.', nf, None, noindex=True),
}
for name, content in pages.items():
    (OUT / name).write_text(content)
    print('wrote', name, len(content))
