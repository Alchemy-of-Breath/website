#!/usr/bin/env python3
"""Build the weekly Breathe The World pages.

Each week, add an entry to issues.json and a letter file in issues/, then run:

    python3 tools/btw/build.py

It writes:
  btw/index.html               this week's message, the constant link for emails
  btw/<year>/week-<nn>/        a permanent page for every week
  btw/archive/index.html       the list of every week

The newest entry in issues.json is "this week". Every older week is rebuilt
as an archive page that points readers on to the current session.
"""
import datetime, html, json, os, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.dirname(os.path.abspath(__file__))
SITE = 'https://alchemyofbreath.com'
ZOOM = 'https://us06web.zoom.us/j/88515813912'
MEETING_ID = '885 1581 3912'
PASSCODE = 'Breathe'
AM, PM = (9, 30), (17, 0)  # London time, every Sunday

EXTRA_CSS = '''
/* weekly issues */
.more{text-align:center;font-size:.84rem;color:var(--slate);margin-top:10px}
.more a{color:var(--gold-deep)}
.letter-card .voice{margin:1.2em 0 1.4em;padding:18px 22px;border-left:2px solid var(--gold);background:var(--paper-2);border-radius:0 12px 12px 0}
.letter-card .voice p{font-family:var(--serif);font-style:italic;color:var(--slate);margin:0 0 .5em;font-size:1.02rem}
.letter-card .voice p:last-child{margin-bottom:0}
.ps p + p{margin-top:.7em}
.past{position:relative;z-index:2;max-width:820px;margin:-8px auto 0;padding:0 26px}
.past-card{background:var(--paper);border:1px solid rgba(225,182,104,.45);border-radius:22px;box-shadow:var(--shadow-soft);padding:30px 34px;text-align:center}
.past-card p{color:var(--slate);margin-bottom:20px}
.past-card .zoom-btn{display:inline-flex;margin:0}
.arch{padding:64px 0 90px;background:var(--paper)}
.arch-list{max-width:760px;margin:40px auto 0;display:grid;gap:14px}
.arch-item{display:flex;align-items:center;justify-content:space-between;gap:20px;text-decoration:none;background:var(--paper-2);border:1px solid rgba(225,182,104,.28);border-radius:16px;padding:22px 26px;transition:transform .25s,box-shadow .25s,border-color .25s}
.arch-item:hover{transform:translateY(-2px);box-shadow:var(--shadow-soft);border-color:var(--gold)}
.arch-item .wk{font-family:var(--sans);font-size:.66rem;font-weight:500;letter-spacing:.2em;text-transform:uppercase;color:var(--gold-deep)}
.arch-item h3{font-size:1.35rem;margin:4px 0 4px}
.arch-item .meta{font-size:.84rem;color:var(--slate)}
.arch-item .go{font-family:var(--sans);font-size:.72rem;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:var(--ink);white-space:nowrap}
.arch-item.now{background:var(--paper);border-color:var(--gold)}
.arch-item .badge{display:inline-block;margin-left:8px;background:var(--ink);color:var(--gold);border-radius:999px;padding:3px 10px;font-size:.58rem;letter-spacing:.14em;vertical-align:middle}
@media(max-width:560px){.arch-item{flex-direction:column;align-items:flex-start;gap:10px}.past{padding:0 16px}.past-card{padding:24px 20px}}
'''

EMBED_JS = """<script>(function(){if(window.self!==window.top){var st=document.createElement('style');st.textContent='.cv{content-visibility:visible !important}';document.head.appendChild(st);}function reportHeight(){var h=document.documentElement.scrollHeight;window.parent.postMessage({type:'aob-embed-resize',height:h},'*');}window.addEventListener('load',reportHeight);window.addEventListener('resize',reportHeight);var mo=new MutationObserver(reportHeight);mo.observe(document.body,{childList:true,subtree:true,attributes:true});setInterval(reportHeight,800);})();</script>"""


def load():
    issues = json.load(open(os.path.join(HERE, 'issues.json'), encoding='utf-8'))
    for i in issues:
        d = datetime.date.fromisoformat(i['date'])
        if d.weekday() != 6:
            raise SystemExit(f"{i['date']} is not a Sunday")
        y, w, _ = d.isocalendar()
        i['d'], i['year'], i['week'] = d, y, w
        i['path'] = f'/btw/{y}/week-{w:02d}/'
        i['long'] = f"Sunday {d.day} {d.strftime('%B %Y')}"
        i['short'] = f"Sunday {d.day} {d.strftime('%B')}"
        i['body'] = open(os.path.join(HERE, 'issues', i['letter']), encoding='utf-8').read().rstrip()
    issues.sort(key=lambda i: i['d'])
    return issues


def gcal(i, which):
    h, m = AM if which == 'AM' else PM
    start = i['d'].strftime('%Y%m%d') + f'T{h:02d}{m:02d}00'
    end = i['d'].strftime('%Y%m%d') + f'T{h + 1:02d}{m:02d}00'
    q = urllib.parse.urlencode({
        'action': 'TEMPLATE',
        'text': f"Breathe The World — {i['title']} ({which})",
        'dates': f'{start}/{end}',
        'ctz': 'Europe/London',
        'location': 'Zoom',
        'details': f'Join here: {ZOOM}\nMeeting ID: {MEETING_ID}\nPasscode: {PASSCODE}',
    }, quote_via=urllib.parse.quote)
    return html.escape('https://calendar.google.com/calendar/render?' + q)


def head(title, desc, canonical, css):
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{html.escape(title)}</title>
<meta name="description" content="{html.escape(desc)}">
<meta name="robots" content="noindex, follow">
<link rel="canonical" href="{canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Alchemy of Breath">
<meta property="og:title" content="{html.escape(title)}">
<meta property="og:description" content="{html.escape(desc)}">
<meta property="og:image" content="https://alchemyofbreath.com/wp-content/uploads/amy-rachelle-1.jpg">
<meta property="og:url" content="{canonical}">
<meta name="theme-color" content="#FBF7EF">
<link rel="icon" type="image/png" href="https://alchemyofbreath.com/wp-content/uploads/AOB-Gold-Black-Transparant-symbol.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Marcellus&family=Roboto:ital,wght@0,300;0,400;0,500;1,300;1,400&display=swap" rel="stylesheet">
<style>
{css}{EXTRA_CSS}</style>
</head>
<body>
'''


def nav(current):
    cta = (f'<a class="nav-cta" href="{ZOOM}" target="_blank" rel="noopener">Join on Zoom</a>' if current
           else '<a class="nav-cta" href="/btw/">This week&rsquo;s session</a>')
    return f'''
<header class="nav">
  <div class="nav-in">
    <a class="nav-logo" href="https://alchemyofbreath.com/" aria-label="Alchemy of Breath">
      <img src="https://alchemyofbreath.com/wp-content/uploads/AOB-Gold-Black-Transparant.png" alt="Alchemy of Breath" width="150" height="32">
    </a>
    {cta}
  </div>
</header>
'''


FOOT = '''
<footer class="foot">
  <div class="wrap">
    <p>&copy; Alchemy of Breath &middot; Breathe The World, every Sunday</p>
    <div class="foot-links">
      <a href="https://alchemyofbreath.com/">Home</a>
      <a href="/btw/">This week</a>
      <a href="/btw/archive/">Past weeks</a>
      <a href="/free-breathwork-sessions/">About Breathe The World</a>
      <a href="/the-alchemist/">The Inner Journey</a>
      <a href="https://alchemyofbreath.com/privacy-policy/">Privacy</a>
    </div>
  </div>
</footer>
'''


def session(i, which):
    am = which == 'AM'
    host, role = (i['am_host'], i['am_role']) if am else (i['pm_host'], i['pm_role'])
    ics = 'am' if am else 'pm'
    return f'''      <div class="sess">
        <p class="lbl">{'Morning' if am else 'Evening'} session</p>
        <p class="time">{'9:30 AM' if am else '5:00 PM'}<small>{i['short']} &middot; London time</small></p>
        <p class="local" id="local{'Am' if am else 'Pm'}"></p>
        <p class="host">Sharing this week: <b>{host}</b>, {role}</p>
        <div class="cal">
          <a href="{gcal(i, which)}" target="_blank" rel="noopener">Google Calendar</a>
          <a href="https://website-5h3.pages.dev/free-breathwork-sessions/welcome/breathe-the-world-{ics}.ics" download>Apple / Outlook</a>
        </div>
      </div>'''


def page(i, current, canonical, style):
    wk = f"Week {i['week']} &middot; {i['year']}"
    out = head(f"{i['title']} · Breathe The World | Alchemy of Breath", i['description'], canonical, style)
    out += nav(current)
    out += f'''
<main>

<section class="hero">
  <div class="orb g" style="width:560px;height:560px;top:-240px;left:-220px" aria-hidden="true"></div>
  <div class="orb t" style="width:520px;height:520px;bottom:-260px;right:-200px" aria-hidden="true"></div>
  <div class="wrap">
    <span class="eyebrow" style="justify-content:center">#BreatheTheWorld &middot; {'This Sunday' if current else wk}</span>
    <h1>{i['title_html']}</h1>
    <p class="when">{i['long']} &middot; <b>9:30 AM</b> and <b>5:00 PM</b></p>
    <p class="tz">{'London time &middot; free, online, everyone welcome' if current else 'London time &middot; this session has taken place'}</p>
  </div>
</section>
'''
    if current:
        out += f'''
<div class="join">
  <div class="join-card">
    <div class="join-head">
      <h2>Your room access</h2>
      <div class="creds"><span>Meeting ID: <b>{MEETING_ID}</b></span><span>Passcode: <b>{PASSCODE}</b></span></div>
    </div>
    <a class="zoom-btn" href="{ZOOM}" target="_blank" rel="noopener">Join Breathe The World on Zoom &rarr;</a>
    <div class="sessions">
{session(i, 'AM')}
{session(i, 'PM')}
    </div>
    <p class="join-note">Same link and passcode for both sessions. Come to whichever suits your day, or both.</p>
  </div>
  <p class="more">Missed a Sunday? <a href="/btw/archive/">Read past weeks&rsquo; messages</a></p>
</div>
'''
    else:
        out += f'''
<div class="past">
  <div class="past-card">
    <p>This was Amy&rsquo;s message for {i['long']}, with {i['am_host']} and {i['pm_host']}. Breathe The World is free and runs every Sunday.</p>
    <a class="zoom-btn" href="/btw/">Join this week&rsquo;s session &rarr;</a>
  </div>
  <p class="more"><a href="/btw/archive/">All past weeks</a></p>
</div>
'''
    out += f'''
<section class="letter">
  <div class="orb g" style="width:480px;height:480px;bottom:-200px;left:-200px" aria-hidden="true"></div>
  <div class="wrap">
    <div class="letter-grid">
      <div class="portrait">
        <div class="portrait-frame">
          <img src="https://alchemyofbreath.com/wp-content/uploads/amy-rachelle-1.jpg" alt="Amy Rachelle, co-founder of Alchemy of Breath" width="600" height="705">
        </div>
        <div class="portrait-cap"><strong>Amy Rachelle</strong><span>Co-founder, Alchemy of Breath &amp; ASHA</span></div>
      </div>

      <div class="letter-card">
        <span class="eyebrow">A note from Amy</span>
        <h2>{html.escape(i['title'])}</h2>
{i['body']}
      </div>
    </div>
  </div>
</section>
'''
    if current:
        out += f'''
<section class="closing">
  <div class="wrap">
    <span class="eyebrow" style="justify-content:center">This Sunday, {i['d'].day} {i['d'].strftime('%B')}</span>
    <h2>{html.escape(i['closing'])}</h2>
    <p>9:30 AM or 5:00 PM London time. Meeting ID {MEETING_ID}, passcode <b>{PASSCODE}</b>.</p>
    <a class="zoom-btn" href="{ZOOM}" target="_blank" rel="noopener">Join on Zoom &rarr;</a>
  </div>
</section>
'''
    else:
        out += '''
<section class="closing">
  <div class="wrap">
    <span class="eyebrow" style="justify-content:center">Every Sunday</span>
    <h2>Breathe with us this week.</h2>
    <p>Free, online, and open to everyone. 9:30 AM and 5:00 PM London time.</p>
    <a class="zoom-btn" href="/btw/">See this week&rsquo;s session &rarr;</a>
  </div>
</section>
'''
    out += '\n</main>\n' + FOOT
    if current:
        d = i['d']
        out += f'''
<script>
(function(){{
  // this week's date, shown in the visitor's own time zone when it differs from London
  var Y={d.year}, M={d.month - 1}, D={d.day};
  function londonToLocal(h,m){{
    var guess=new Date(Date.UTC(Y,M,D,h-1,m));
    try{{
      var fmt=new Intl.DateTimeFormat('en-GB',{{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit',hour12:false}});
      for(var i=0;i<3;i++){{
        var parts=fmt.format(guess).split(':');
        var diff=(h*60+m)-(parseInt(parts[0],10)*60+parseInt(parts[1],10));
        if(diff===0) break;
        guess=new Date(guess.getTime()+diff*60000);
      }}
      return guess;
    }}catch(e){{ return null; }}
  }}
  function show(id,h,m){{
    var el=document.getElementById(id); if(!el) return;
    var local=londonToLocal(h,m); if(!local) return;
    try{{
      var tz=Intl.DateTimeFormat().resolvedOptions().timeZone||'';
      var t=local.toLocaleTimeString([],{{hour:'numeric',minute:'2-digit'}});
      var lon=new Intl.DateTimeFormat('en-GB',{{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit'}}).format(local);
      var here=new Intl.DateTimeFormat('en-GB',{{hour:'2-digit',minute:'2-digit'}}).format(local);
      if(here!==lon) el.textContent='That\\u2019s '+t+' in your time zone'+(tz?' ('+tz.replace(/_/g,' ')+')':'');
    }}catch(e){{}}
  }}
  show('localAm',{AM[0]},{AM[1]});
  show('localPm',{PM[0]},{PM[1]});
}})();
</script>
'''
    out += EMBED_JS + '\n</body>\n</html>\n'
    return out


def archive(issues, style):
    items = []
    latest = issues[-1]
    for i in reversed(issues):
        now = i is latest
        href = '/btw/' if now else i['path']
        badge = '<span class="badge">This week</span>' if now else ''
        items.append(f'''    <a class="arch-item{' now' if now else ''}" href="{href}">
      <div>
        <span class="wk">Week {i['week']} &middot; {i['year']}</span>{badge}
        <h3>{html.escape(i['title'])}</h3>
        <p class="meta">{i['long']} &middot; with {i['am_host']} and {i['pm_host']}</p>
      </div>
      <span class="go">{'Join' if now else 'Read'} &rarr;</span>
    </a>''')
    out = head('Past weeks · Breathe The World | Alchemy of Breath',
               "Every week's Breathe The World message from Amy Rachelle and Alchemy of Breath.",
               SITE + '/btw/archive/', style)
    out += nav(False)
    out += f'''
<main>

<section class="hero">
  <div class="orb g" style="width:560px;height:560px;top:-240px;left:-220px" aria-hidden="true"></div>
  <div class="orb t" style="width:520px;height:520px;bottom:-260px;right:-200px" aria-hidden="true"></div>
  <div class="wrap">
    <span class="eyebrow" style="justify-content:center">#BreatheTheWorld &middot; Archive</span>
    <h1>Every week&rsquo;s <em>message</em></h1>
    <p class="tz">Amy&rsquo;s letters from each Sunday of Breathe The World</p>
  </div>
</section>

<section class="arch">
  <div class="wrap">
  <div class="arch-list">
{chr(10).join(items)}
  </div>
  </div>
</section>

</main>
''' + FOOT + EMBED_JS + '\n</body>\n</html>\n'
    return out


def write(rel, text):
    path = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, 'w', encoding='utf-8').write(text)
    print('  wrote', rel)


def main():
    style = open(os.path.join(HERE, 'style.css'), encoding='utf-8').read()
    issues = load()
    latest = issues[-1]
    for i in issues:
        current = i is latest
        write(i['path'].lstrip('/') + 'index.html', page(i, current, SITE + i['path'], style))
    write('btw/index.html', page(latest, True, SITE + '/btw/', style))
    write('btw/archive/index.html', archive(issues, style))
    print(f"this week: Week {latest['week']} {latest['year']}, {latest['title']} ({latest['date']})")


if __name__ == '__main__':
    main()
