"""Generates the static SEO pages in client/public. Edit the copy here, then run:
    python3 client/seo/build_pages.py
and commit the regenerated .html files (and add new pages to public/sitemap.xml)."""
import json, html, pathlib

OUT = pathlib.Path(__file__).resolve().parent.parent / 'public'
SITE = 'https://3rtc.me'
NAV = [('/about', 'About'), ('/youtube-watch-party', 'YouTube'), ('/watch-movies-together', 'Movies'), ('/play-ludo-online', 'Ludo')]
FOOT = [('/', 'Open 3RTC'), ('/about', 'About & FAQ'), ('/youtube-watch-party', 'YouTube watch party'),
        ('/watch-movies-together', 'Watch movies together'), ('/watch-videos-together', 'Watch your own videos together'),
        ('/watch-links-together', 'Twitch, Vimeo & video links'), ('/play-ludo-online', 'Play Ludo online'),
        ('/netflix-watch-party', 'Netflix watch party?'), ('/watch2gether-alternative', 'Watch2Gether alternative'),
        ('/privacy', 'Privacy')]


def faq(items):
    """(html, structured data) for a list of (question, answer)."""
    block = ''.join(f'<details><summary>{html.escape(q)}</summary><p>{html.escape(a)}</p></details>' for q, a in items)
    ld = {'@type': 'FAQPage', 'mainEntity': [
        {'@type': 'Question', 'name': q, 'acceptedAnswer': {'@type': 'Answer', 'text': a}} for q, a in items]}
    return block, ld


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
    ('How many people can watch together?', 'A room holds up to 4 people. Everyone connects directly to everyone else, which keeps voice and chat fast and private, and when someone shares a video file, viewers pass it along to each other so the person sharing it doesn\u2019t have to upload it to everyone.'),
    ('Do my friends need to install anything?', 'No. 3RTC runs in any modern browser, on computers and phones. You can also install it from the browser menu ("Install app" or "Add to Home screen") so it opens like a normal app.'),
    ('Can we watch a video file that only I have?', 'Yes. Pick an MP4, WebM or MKV file on your device and the others can stream it straight from you. Playback starts after a few seconds, the file is never uploaded to a server, and your friends do not need their own copy.'),
    ('Does it work with YouTube?', 'Yes. Paste any YouTube link, including live streams, and play, pause and seeking stay in sync for everyone in the room. You can also line up a queue of videos and vote to skip.'),
    ('What else can we watch besides YouTube?', 'Paste a Vimeo video, a Twitch channel or video, or a direct link to a video file (.mp4, .webm) or a live stream (.m3u8), and it plays in sync for everyone. You can also share a movie file from your own device.'),
    ('Do subtitles work?', 'Yes. Drop an .srt or .vtt file on the player, or pick a subtitle track that is already inside an MKV file, and everyone in the room gets the subtitles. Each person can change the size, colour and timing for themselves.'),
    ('Can we play games too?', 'Yes. Open Ludo from the menu: 2 to 4 players, computer players if you are short of people, and everyone else in the room can watch, with voice chat the whole time.'),
    ('Is the voice chat good quality?', 'Voice goes directly between you at high bitrate, with echo cancellation and noise suppression that removes background noise like fans and keyboards. You can use an always-on mic or push-to-talk, and choose which microphone and speaker or headphones to use.'),
    ('Does my video or voice go through your servers?', 'No. A small connection server introduces the devices in a room to each other, and after that video, voice, chat and images go directly between devices, encrypted by WebRTC.'),
    ('Can we watch Netflix, Prime Video or Disney+ together?', 'Not inside 3RTC. Those services protect their videos so they only play in their own apps and sites, so no outside watch party app can play them. You can still use a 3RTC room for voice chat while each of you plays it on your own account; see the Netflix watch party page for how.'),
    ('Is it good for long-distance movie nights?', 'Yes. That’s what it’s built for: everyone stays on the same frame, you can talk the whole time, and nobody needs an account. Pause for snacks and it pauses for everyone.'),
    ('Why can’t my friend connect?', 'Direct connections work on most home Wi-Fi and mobile networks, but some very strict networks (some offices, schools and public Wi-Fi) block them. Trying a different network, such as mobile data, usually fixes it.'),
    ('Can I use it on my phone?', 'Yes. 3RTC has a phone layout with the video on top and chat, queue and people in tabs below, plus hold-to-talk for voice.'),
]
faq_html, faq_ld = faq(FAQ)

about = f'''<p class="eyebrow">About 3RTC</p>
<h1>Watch together online with friends, in perfect sync</h1>
<p class="lede">3RTC is a free online watch party app. Play a YouTube video, a Vimeo or Twitch link, or a movie file from your own device, and everyone in the room sees the same moment at the same time, while you talk over voice chat and react in the chat. It’s made for watching (and playing) together with friends who aren’t in the same room.</p>
{CTA}

<h2>What you can do</h2>
<ul class="features">
<li><strong>YouTube in sync</strong><span>Play, pause and seek once, and it happens for everyone. Live streams too.</span></li>
<li><strong>Paste any link</strong><span>Vimeo, Twitch, or a direct .mp4, .webm or .m3u8 link.</span></li>
<li><strong>Your own video files</strong><span>Stream an MP4, WebM or MKV file straight from your device. No uploading.</span></li>
<li><strong>Subtitles</strong><span>Drop an .srt file, or pick the subtitles inside an MKV, for everyone.</span></li>
<li><strong>Clear voice chat</strong><span>Noise suppression, echo cancellation, push-to-talk, your choice of mic and speaker.</span></li>
<li><strong>Live chat</strong><span>Messages, images, links, emoji reactions and a soundboard.</span></li>
<li><strong>Shared queue</strong><span>Line up what to watch next and vote to skip.</span></li>
<li><strong>Ludo</strong><span>Play Ludo with up to 4 players while the rest watch.</span></li>
<li><strong>Stays in sync by itself</strong><span>Anyone who drifts behind is quietly brought back in step.</span></li>
<li><strong>Phone and computer</strong><span>Works in the browser, and installs like an app.</span></li>
</ul>

<h2>How it works</h2>
<ol class="steps">
<li>Open <a href="/">3rtc.me</a>, type your name and tap <strong>Create a room</strong>.</li>
<li>Share the 5-digit room code, link or QR code with up to five friends.</li>
<li>Paste a YouTube, Vimeo or Twitch link, or pick a video file, and press play. Everyone stays in sync.</li>
</ol>

<h2>Peer to peer, by design</h2>
<p>Most watch party services send everything through their own servers. 3RTC connects your devices directly using WebRTC, the same technology video-call apps use. A small connection server only helps the devices in a room find each other; video, voice, chat and images then travel straight between you, encrypted. That is what keeps it fast, private and free to run. See the <a href="/privacy">privacy page</a> for exactly what is and isn’t shared.</p>

<h2>Frequently asked questions</h2>
{faq_html}

<div class="related"><h2>More about 3RTC</h2><ul>
<li><a href="/youtube-watch-party">How to host a YouTube watch party</a></li>
<li><a href="/watch-movies-together">Watch movies together online</a></li>
<li><a href="/watch-videos-together">Watch your own video files together online</a></li>
<li><a href="/watch-links-together">Watch Twitch, Vimeo and video links together</a></li>
<li><a href="/play-ludo-online">Play Ludo online with friends</a></li>
<li><a href="/watch2gether-alternative">How 3RTC compares with Watch2Gether and Teleparty</a></li>
</ul></div>'''

# ---------------------------------------------------------------- /youtube-watch-party
YT_FAQ = [
    ('How do I watch YouTube together with friends?', 'Create a room at 3rtc.me, share the 5-digit code or link, paste a YouTube link and press play. Everyone in the room watches the same moment, and play, pause and seeking are shared.'),
    ('Is it free? Do we need accounts?', 'It is free, with no account, no sign-up and no ads. Your friends only need a browser.'),
    ('Can we watch YouTube live streams together?', 'Yes. Paste the link of a live stream and everyone watches it live together.'),
    ('What if one person falls behind?', '3RTC checks everyone’s position every few seconds and quietly brings anyone who drifted more than a moment out of step back in line, without interrupting the others.'),
    ('Does it work on phones?', 'Yes. Open 3rtc.me in the phone’s browser; the video sits on top with chat, queue and people below, and voice works with hold-to-talk.'),
    ('Why does a video say it can’t be played?', 'Its owner has turned off playing it on other websites (embedding), or it is age- or region-restricted. Those videos can’t be watched in any watch party app; 3RTC skips to the next one in the queue.'),
]
yt_faq_html, yt_faq_ld = faq(YT_FAQ)

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
<p>Each person’s browser plays the video from YouTube itself, so everyone gets YouTube’s full quality and subtitles, and you can pick your own quality setting. A few videos can’t be embedded on other sites because their owner has turned that off; those won’t play in any watch party app, and 3RTC tells you so and skips to the next one in the queue.</p>

<h2>Ideas for a YouTube watch party</h2>
<ul>
<li><strong>Music and lo-fi radio</strong>: keep a live music stream running while you talk or study together.</li>
<li><strong>Premieres and live streams</strong>: watch a launch, a match or a concert live with friends.</li>
<li><strong>Video essays and documentaries</strong>: pause anytime to discuss; it pauses for everyone.</li>
<li><strong>Reaction night</strong>: take turns adding videos to the queue and vote to skip the duds.</li>
<li><strong>Tutorials with a friend</strong>: follow a cooking or coding video together, step by step.</li>
</ul>

<h2>Questions</h2>
{yt_faq_html}

<div class="related"><h2>Related</h2><ul>
<li><a href="/watch-links-together">Watch Twitch, Vimeo and other video links together</a></li>
<li><a href="/watch-videos-together">Watch a movie file from your computer together</a></li>
<li><a href="/about">About 3RTC and FAQ</a></li>
</ul></div>'''

# ---------------------------------------------------------------- /watch-videos-together
LOCAL_FAQ = [
    ('Is my video uploaded anywhere?', 'No. It goes directly from your device to the devices in your room over an encrypted peer-to-peer connection. No server stores or even sees it.'),
    ('Do my friends need to download the whole file first?', 'No. They can start watching within seconds; the video keeps loading just ahead of where you are watching, and jumping to another point fetches that part first.'),
    ('Which formats work?', 'MP4 and WebM play everywhere; MKV plays in Chrome and Edge. What matters most is the video and audio format inside the file: H.264 or VP9 video with AAC or Opus audio is the safest choice. 3RTC checks the file and tells everyone in advance if it won’t play for them.'),
    ('Can we use the subtitles inside an MKV?', 'Yes. Text subtitle tracks (SRT, ASS, WebVTT) inside the file are listed on the player, and anyone can pick one for the whole room. Picture-based subtitles (PGS, VobSub) can’t be shown in a browser; use an .srt file instead.'),
]
local_faq_html, local_faq_ld = faq(LOCAL_FAQ)

local = f'''<p class="eyebrow">Your own videos</p>
<h1>Watch your own video files together online</h1>
<p class="lede">Have a movie or a clip on your computer or phone? Pick it in 3RTC and your friends can watch it with you in sync, streamed straight from your device. Nothing is uploaded to a server, and they don’t need their own copy.</p>
{CTA}

<h2>How it works</h2>
<ol class="steps">
<li>Create a room at <a href="/">3rtc.me</a> and invite up to five friends with the room code.</li>
<li>Choose a video file (MP4, WebM or MKV) or drag it onto the page. Add subtitles by dropping an .srt file, or pick a track inside the MKV.</li>
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

<h2>Subtitles, also from inside the file</h2>
<p>Drop an .srt or .vtt subtitle file on the player and everyone in the room gets it. MKV files often carry their own subtitle tracks: 3RTC lists them, and anyone can pick one (English, Spanish, …); it is read straight out of the file and shared with the room. Each person can change the subtitle size, colour, background and timing for themselves.</p>

<h2>Will the file play for everyone?</h2>
<p>As soon as you pick a file, 3RTC reads what’s inside it (MP4, MKV, WebM, the video and audio formats, the audio and subtitle tracks) and checks it on every device in the room. If a friend’s browser can’t play the picture or the sound, they are told before they start, and you see who is affected, so you can switch to another file instead of finding out halfway through the film.</p>

<h2>Tips for smooth playback</h2>
<p>MP4 files (H.264 video with AAC audio) play in every browser. MKV files play in Chrome and Edge when the video and audio inside are formats they support; files with Dolby Digital (AC-3) or DTS audio play without sound in most browsers, and 3RTC warns about that. Because the video streams from your device, a steady upload connection on your side helps, and keeping 3RTC open in the foreground prevents your device from pausing the stream. In bigger rooms, viewers also pass the parts they already have on to each other, so your upload isn’t shared out six ways; each piece is checked against your original so nothing can be tampered with on the way.</p>

<h2>Questions</h2>
{local_faq_html}

<div class="related"><h2>Related</h2><ul>
<li><a href="/watch-movies-together">Plan a movie night online</a></li>
<li><a href="/youtube-watch-party">Host a YouTube watch party</a></li>
<li><a href="/about">About 3RTC and FAQ</a></li>
</ul></div>'''

# ---------------------------------------------------------------- /watch-movies-together
MOVIE_FAQ = [
    ('How do we watch a movie together online?', 'One of you opens 3RTC, creates a room and shares the 5-digit code. Pick the movie file on your device (or a YouTube video), and everyone else taps Stream. Play, pause and seeking stay in sync for everyone.'),
    ('Do my friends need the movie file too?', 'No. Only the person sharing it needs the file. It streams straight from their device to everyone in the room, starting within seconds, and it is never uploaded to a server.'),
    ('Can we watch Netflix or Prime Video together?', 'Not inside 3RTC: Netflix, Prime Video, Disney+ and similar services only play inside their own apps and sites. 3RTC works with YouTube, Vimeo, Twitch, video links and movie files you have on your device. For Netflix, you can still open a 3RTC room for voice chat while each of you plays it on your own account.'),
    ('Can we have subtitles?', 'Yes. Drop an .srt subtitle file on the player, or pick a subtitle track inside an MKV movie, and everyone gets it. Each person can change the size and timing for themselves.'),
    ('How many people can join a movie night?', 'Up to 4 people per room. When someone shares a movie file, viewers pass it along to each other, so the person sharing it doesn’t have to upload a copy for everyone.'),
]
movies_faq_html, movies_faq_ld = faq(MOVIE_FAQ)

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
<li><strong>Subtitles for everyone</strong><span>An .srt file or the subtitles inside an MKV, shared with the room.</span></li>
<li><strong>Reactions and chat</strong><span>Emoji, images and clickable timestamps like 1:12:30.</span></li>
<li><strong>Host controls</strong><span>Lock playback so only the host can pause or skip.</span></li>
<li><strong>Phone or computer</strong><span>Join from any browser; the screen stays on while you watch.</span></li>
</ul>

<h2>Long-distance friends and couples</h2>
<p>3RTC is built for the people you can’t sit next to: friends who moved away, long-distance partners, family in another city. There’s no account to create and nothing to install, so getting everyone into the room takes one link or a 5-digit code.</p>

<h2>Tips for a good online movie night</h2>
<ul>
<li><strong>Check the file first.</strong> Pick it a few minutes early: 3RTC tells you if anyone’s browser can’t play its video or sound.</li>
<li><strong>Use headphones</strong> if you can, or push-to-talk, so the movie’s sound doesn’t echo into the voice chat.</li>
<li><strong>Lock playback</strong> with host controls if too many hands on the remote cause chaos.</li>
<li><strong>Plan the next one in the queue</strong>: trailers, a short film, or the next episode.</li>
<li><strong>Intermission</strong>: pause for snacks, play a round of Ludo, then carry on from the same frame.</li>
</ul>

<h2>Questions</h2>
{movies_faq_html}

<div class="related"><h2>Related</h2><ul>
<li><a href="/youtube-watch-party">Host a YouTube watch party</a></li>
<li><a href="/watch-videos-together">Watch your own video files together</a></li>
<li><a href="/netflix-watch-party">Netflix watch party: what works and what doesn’t</a></li>
<li><a href="/about">About 3RTC and FAQ</a></li>
</ul></div>"""

# ---------------------------------------------------------------- /watch-links-together
LINKS_FAQ = [
    ('Which links can we watch together?', 'YouTube (videos and live streams), Vimeo videos, Twitch channels (live) and Twitch videos, and direct links to video files (.mp4, .webm, .mov) or live streams (.m3u8). Paste the link and it plays for everyone in the room.'),
    ('Can we watch a Twitch stream together?', 'Yes. Paste the channel link (twitch.tv/name) and everyone watches the stream live in the same room, talking over voice chat instead of typing in Twitch chat.'),
    ('Why won’t a link play?', 'Some sites don’t allow their videos to be played on other websites (Netflix, Prime Video, Disney+, Instagram, TikTok and most TV services), and some links point to a web page rather than to a video. 3RTC explains which case it is when you paste the link.'),
    ('Does everyone stay in sync?', 'Yes. Play, pause and seeking are shared, and anyone who drifts more than a moment behind is quietly brought back in step. Live streams simply play live for everyone.'),
]
links_faq_html, links_faq_ld = faq(LINKS_FAQ)

links = f"""<p class="eyebrow">Paste any link</p>
<h1>Watch Twitch, Vimeo and video links together</h1>
<p class="lede">Not just YouTube: paste a Vimeo video, a Twitch channel or video, or a direct link to a video file or live stream into 3RTC, and everyone in the room watches it together, in sync, with voice chat.</p>
{CTA}

<h2>How it works</h2>
<ol class="steps">
<li>Create a room at <a href="/">3rtc.me</a> and share the code with up to five friends.</li>
<li>Paste the link into the box on the player: YouTube, Vimeo, Twitch, or a link ending in .mp4, .webm or .m3u8.</li>
<li>Press play. Play, pause and seeking are shared; live streams play live for everyone.</li>
<li>Paste the next link into the queue while you watch.</li>
</ol>

<h2>What you can paste</h2>
<ul class="features">
<li><strong>YouTube</strong><span>Videos, Shorts and live streams.</span></li>
<li><strong>Vimeo</strong><span>Vimeo videos that allow embedding.</span></li>
<li><strong>Twitch</strong><span>Live channels and past broadcasts.</span></li>
<li><strong>Video files</strong><span>Direct links to .mp4, .webm or .mov files.</span></li>
<li><strong>Live streams</strong><span>HLS links (.m3u8), like many live event streams.</span></li>
<li><strong>Your own files</strong><span>Or share a file from your own device.</span></li>
</ul>

<h2>Questions</h2>
{links_faq_html}

<div class="related"><h2>Related</h2><ul>
<li><a href="/youtube-watch-party">Host a YouTube watch party</a></li>
<li><a href="/watch-videos-together">Watch your own video files together</a></li>
<li><a href="/about">About 3RTC and FAQ</a></li>
</ul></div>"""

# ---------------------------------------------------------------- /play-ludo-online
LUDO_FAQ = [
    ('How do I play Ludo online with friends?', 'Create a room at 3rtc.me, share the code, then open Ludo from the menu. Everyone picks a colour, the host presses Start, and you play with voice chat on the whole time.'),
    ('How many players can play?', 'Two to four players. If you are only two or three, add computer players. Anyone else in the room can watch the game live.'),
    ('Is it free? Do we need to download an app?', 'It is free, with no account, no download and no ads. It runs in the browser on phones and computers, and you can add it to your home screen like an app.'),
    ('Can we change the rules?', 'Yes. Before the game the host can switch house rules on or off: a 6 to bring a token out, three sixes lose the turn, safe star squares, and an extra turn for capturing and for reaching home.'),
    ('What if someone leaves in the middle of a game?', 'The computer can play for them, or their turns can be skipped (the host chooses). If they come back, even after closing the tab, they get their own colour back and carry on.'),
    ('Can we watch a video and play at the same time?', 'Yes. 3RTC is a watch party app too: watch YouTube or a movie together, then open Ludo for a break, in the same room with the same voice chat.'),
]
ludo_faq_html, ludo_faq_ld = faq(LUDO_FAQ)

ludo = f"""<p class="eyebrow">Ludo</p>
<h1>Play Ludo online with friends, with voice chat</h1>
<p class="lede">Classic Ludo for 2 to 4 players, right in your browser. Create a room, send your friends the code, and play while you talk: no app to download, no account, no ads. Short of players? Add the computer.</p>
<div class="cta-row"><a class="btn" href="/">Start a game</a>
<span class="cta-note">Free · no sign-up · phones and computers</span></div>

<h2>How to play Ludo with friends online</h2>
<ol class="steps">
<li>Open <a href="/">3rtc.me</a>, type your name and create a room.</li>
<li>Share the 5-digit room code or link with your friends.</li>
<li>Open the menu and choose <strong>Ludo</strong>. Everyone picks a colour; fill empty seats with computer players if you like.</li>
<li>The host presses <strong>Start</strong>. Roll, tap a glowing token to move it, and talk the whole time.</li>
</ol>

<h2>Why play on 3RTC</h2>
<ul class="features">
<li><strong>Voice chat built in</strong><span>Talk, tease and celebrate captures, no separate call needed.</span></li>
<li><strong>House rules</strong><span>Six to start, three sixes, safe stars, bonus turns: on or off.</span></li>
<li><strong>Computer players</strong><span>Play with two or three people, or against the computer.</span></li>
<li><strong>Watchers welcome</strong><span>Everyone else in the room sees the game live.</span></li>
<li><strong>Rejoin anytime</strong><span>Dropped out? Come back to your own colour and tokens.</span></li>
<li><strong>Big, clear board</strong><span>Full screen on computers, made for touch on phones.</span></li>
</ul>

<h2>The rules, briefly</h2>
<p>Each player has four tokens. Roll a 6 to bring a token out of the base onto the start square, then move around the board by the number rolled. A 6 gives another roll, but three 6s in a row lose the turn. Land on an opponent’s token to send it back to its base (except on star squares, which are safe) and take another turn. The first player to bring all four tokens home wins. The host can switch each of these rules off before the game starts.</p>

<h2>Questions</h2>
{ludo_faq_html}

<div class="related"><h2>Related</h2><ul>
<li><a href="/watch-movies-together">Watch movies together online</a></li>
<li><a href="/about">About 3RTC and FAQ</a></li>
</ul></div>"""

# ---------------------------------------------------------------- /netflix-watch-party
NETFLIX_FAQ = [
    ('Can I watch Netflix in 3RTC?', 'No. Netflix, like Prime Video, Disney+ and Hotstar, protects its videos so they only play in its own apps and website. No outside watch party site can play Netflix inside it, and sharing your screen of a Netflix film usually shows only a black picture.'),
    ('So how do we watch Netflix together?', 'Each person plays the show on their own Netflix account, and you meet in a 3RTC room for voice chat and text chat. Count down together and press play at the same moment; if someone gets out of step, pause and line up the time shown on screen.'),
    ('What about browser extensions?', 'Some browser extensions can sync Netflix playback between people who each have their own subscription. They work on computers in supported browsers; you can still use a 3RTC room alongside for voice chat.'),
    ('What can we watch fully in sync on 3RTC?', 'YouTube (including live streams), Vimeo, Twitch, direct video links, and movie or video files that one of you has on your device: they stream from that person to everyone else.'),
]
netflix_faq_html, netflix_faq_ld = faq(NETFLIX_FAQ)

netflix = f"""<p class="eyebrow">Netflix watch party</p>
<h1>Netflix watch party: what works and what doesn’t</h1>
<p class="lede">Want to watch Netflix together with friends far away? The honest answer first: no website can play Netflix inside its own player, 3RTC included. But you can still watch together and talk the whole time. Here’s how, plus what 3RTC can play in perfect sync.</p>
{CTA}

<h2>Why no watch party site can play Netflix</h2>
<p>Netflix, Prime Video, Disney+, Hotstar and other subscription services encrypt their films so they only play inside their own apps and website, for people signed in to an account. That’s why a site like 3RTC can’t load a Netflix link, and why sharing your screen of Netflix in a call often shows only a black picture.</p>

<h2>How to watch Netflix together anyway</h2>
<ol class="steps">
<li>Everyone opens the same show on their own Netflix account (on a TV, laptop or phone).</li>
<li>Create a room at <a href="/">3rtc.me</a> and share the code. That’s your voice chat and text chat for the evening.</li>
<li>Pause at the start, count down “3, 2, 1” over voice, and everyone presses play.</li>
<li>If someone gets out of step, pause together and line up the time shown on screen.</li>
</ol>
<p>Use headphones, or push-to-talk, so the show’s sound doesn’t echo into the voice chat.</p>

<h2>What plays fully in sync on 3RTC</h2>
<ul class="features">
<li><strong>Your own movie files</strong><span>An MP4 or MKV on your device streams to everyone.</span></li>
<li><strong>YouTube</strong><span>Including the many full films and documentaries on YouTube.</span></li>
<li><strong>Vimeo and Twitch</strong><span>And direct video or live stream links.</span></li>
</ul>

<h2>Questions</h2>
{netflix_faq_html}

<div class="related"><h2>Related</h2><ul>
<li><a href="/watch-videos-together">Watch a movie file from your device together</a></li>
<li><a href="/watch-movies-together">Plan a movie night online</a></li>
<li><a href="/watch2gether-alternative">How 3RTC compares with other watch party apps</a></li>
</ul></div>"""

# ---------------------------------------------------------------- /watch2gether-alternative
ALT_FAQ = [
    ('Is 3RTC a good Watch2Gether alternative?', 'If you watch with a small group of friends and want to talk, yes: 3RTC has voice chat built in, connects your devices directly, and lets you share a movie file from your own device without uploading it. For big public rooms with many people, a server-based site suits better.'),
    ('Is 3RTC a Teleparty alternative?', 'For YouTube, Vimeo, Twitch and your own video files, yes, with voice chat and no extension to install. For Netflix, Prime Video or Disney+, no: those only play in their own apps; see the Netflix watch party page for how to watch those together.'),
    ('Do my friends need an account or an extension?', 'No. They open the link or type the 5-digit code in any browser, on a phone or a computer.'),
    ('How many people can join?', 'Up to 4 people per room. Everyone connects directly to everyone else, which keeps voice and sync fast and private.'),
]
alt_faq_html, alt_faq_ld = faq(ALT_FAQ)

alt = f"""<p class="eyebrow">Compare</p>
<h1>A Watch2Gether and Teleparty alternative with voice chat</h1>
<p class="lede">Looking for another way to watch videos together online? 3RTC is a free watch party app for small groups of friends: synced playback, voice chat built in, your own movie files streamed straight from your device, and no account or extension.</p>
{CTA}

<h2>What makes 3RTC different</h2>
<ul class="features">
<li><strong>Voice chat built in</strong><span>Talk while you watch, with noise removal and push-to-talk. No separate call app.</span></li>
<li><strong>Share your own files</strong><span>A movie on your device streams straight to friends. Nothing is uploaded.</span></li>
<li><strong>Direct, private</strong><span>Devices connect peer to peer; video, voice and chat don’t pass through our servers.</span></li>
<li><strong>Nothing to install</strong><span>No account, no browser extension, works on phones.</span></li>
<li><strong>Many sources</strong><span>YouTube, Vimeo, Twitch, video links and live streams, with subtitles.</span></li>
<li><strong>Games too</strong><span>Take a break with a round of Ludo in the same room.</span></li>
</ul>

<h2>When another tool fits better</h2>
<p>Every watch party app makes different trade-offs. Server-based rooms such as Watch2Gether suit large public rooms with many people. Browser extensions such as Teleparty sync streaming services like Netflix for people who each have their own subscription, on a computer. 3RTC is made for a small group of friends (up to 4 people) who want to talk the whole time, and for sharing video files you have yourself.</p>

<table>
<tr><th>You want to…</th><th>3RTC</th></tr>
<tr><td>Watch YouTube in sync and talk over voice</td><td>Yes, voice is built in</td></tr>
<tr><td>Watch a movie file only you have</td><td>Yes, streamed from your device, no upload</td></tr>
<tr><td>Watch Twitch, Vimeo or a video link</td><td>Yes</td></tr>
<tr><td>Join on a phone without installing anything</td><td>Yes</td></tr>
<tr><td>Watch Netflix or Prime Video inside the app</td><td>No, no website can (<a href="/netflix-watch-party">what you can do instead</a>)</td></tr>
<tr><td>Host a room for dozens of people</td><td>No, up to 4 people</td></tr>
</table>

<h2>Questions</h2>
{alt_faq_html}

<div class="related"><h2>Related</h2><ul>
<li><a href="/about">About 3RTC and FAQ</a></li>
<li><a href="/watch-movies-together">Watch movies together online</a></li>
<li><a href="/play-ludo-online">Play Ludo online with friends</a></li>
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
                                     yt, 'YouTube watch party', [yt_faq_ld]),
    'watch-videos-together.html': page('/watch-videos-together', 'Watch Your Own Video Files Together Online | 3RTC',
                                       'Stream a movie or video file from your device to friends and watch it together in sync. No uploading, no copy needed on their side. MP4, WebM and MKV.',
                                       local, 'Watch your own videos together', [local_faq_ld]),
    'watch-movies-together.html': page('/watch-movies-together', 'Watch Movies Together Online – Free Movie Night | 3RTC',
                                       'Watch movies together online with friends far away: synced playback, voice chat and live chat. Free, no sign-up. Use your own movie files or YouTube.',
                                       movies, 'Watch movies together', [movies_faq_ld]),
    'watch-links-together.html': page('/watch-links-together', 'Watch Twitch, Vimeo & Video Links Together in Sync | 3RTC',
                                      'Watch Twitch streams, Vimeo videos and any video link together with friends, in sync, with voice chat. Paste a link, share the code. Free, no sign-up.',
                                      links, 'Watch links together', [links_faq_ld]),
    'play-ludo-online.html': page('/play-ludo-online', 'Play Ludo Online with Friends – Free, with Voice Chat | 3RTC',
                                  'Play Ludo online with friends in your browser: 2–4 players or the computer, house rules, voice chat built in. Free, no download, no sign-up.',
                                  ludo, 'Play Ludo online', [ludo_faq_ld]),
    'netflix-watch-party.html': page('/netflix-watch-party', 'Netflix Watch Party: How to Watch Netflix Together Online | 3RTC',
                                     'Can you have a Netflix watch party? Why no website can play Netflix, how to watch it together with voice chat anyway, and what plays fully in sync.',
                                     netflix, 'Netflix watch party', [netflix_faq_ld]),
    'watch2gether-alternative.html': page('/watch2gether-alternative', 'Watch2Gether & Teleparty Alternative with Voice Chat | 3RTC',
                                          'A free Watch2Gether and Teleparty alternative for small groups: synced YouTube, Twitch and your own movie files, voice chat built in, no account or extension.',
                                          alt, 'Watch2Gether alternative', [alt_faq_ld]),
    'privacy.html': page('/privacy', 'Privacy – 3RTC', 'What 3RTC shares and with whom: no accounts, no ads, no analytics. Video, voice and chat go directly between devices.',
                         privacy, 'Privacy'),
    '404.html': page('/404', 'Page not found – 3RTC', 'This page does not exist.', nf, None, noindex=True),
}
for name, content in pages.items():
    (OUT / name).write_text(content)
    print('wrote', name, len(content))
