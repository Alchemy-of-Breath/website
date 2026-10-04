#!/usr/bin/env python3
"""Compile booking programs.

    python3 tools/booking/build.py

Reads every booking/programs/<id>.json and:
  1. writes booking-lib/programs.js, which the Cloudflare functions import (server-side
     prices, capacity and rules — the browser never decides what is charged);
  2. refreshes the program data inside book/<id>/index.html (between the PROGRAM-DATA markers)
     and the program list inside book/admin/index.html.

Edit a JSON file (prices, capacity, photos, deposit…), run this, commit, push.
Shared single-gender rooms use "same_gender": true, "units" (rooms still in play) and
"occupied" (beds taken outside this system, e.g. [{"gender": "Female", "beds": 1}]).
Rooms that sleep one use "capacity".
"programme" (optional) adds a per-guest programme fee, paid in full at booking; the deposit
percentage then applies to the accommodation only.
Rooms not priced per person ("unit": "cottage") count "capacity" in whole units; each booking
takes ceil(guests / sleeps) of them.
Also validated (content shown on the booking page): programme.includes, stay_includes,
not_included, payment_methods (Stripe types per mode, must include "card"), deposit.balance_due /
deposit.available_until (YYYY-MM-DD or null), policy (incl. health_note, medical_url, waiver_url),
arrival, trust, terms_url, privacy_url.
To add a new week: copy a JSON file in booking/programs/, change the id/dates/rooms, run this.
Every book/<id>/index.html is generated from tools/booking/page-template.html (edit the template,
never a generated page). Weeks moved to booking/archive/ are no longer compiled or listed.

Wellbeing sessions (upsell): booking/services.json is the catalogue (practitioners, services,
prices in whole euros, minutes, limits). A program opts in with "services": "all" or a list of
service ids; the resolved list is compiled into the program for the server (prices) and the page.
Rooms may list their physical rooms in "names" (shared rooms: one per unit; others: one per place);
the admin uses them for room assignment.
The hub page book/index.html gets the list of weeks (between the PROGRAMS-DATA markers).

The page gets a public copy of the program: internal notes ("about", "source" notes, RetreatGuru
ids) stay in booking-lib/programs.js only. Its hero (between the HERO markers) is written here too,
so the first paint already has its text, and its photo comes from jsDelivr pinned to the last commit
that touched assets/booking/rooms (served the same on pages.dev and alchemyofbreath.com). Commit and
push new room photos before running this, or the page points at the previous ones.
"""
import glob, html, json, os, re, subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
REQUIRED = ['id', 'title', 'dates', 'venue', 'currency', 'program_spaces', 'deposit', 'rooms', 'genders', 'terms_url']
DATE = re.compile(r'\d{4}-\d{2}-\d{2}')
PM_TYPE = re.compile(r'[a-z][a-z0-9_]{1,40}')


def check_content(p):
    """Validate the optional content blocks the booking page and the API read (never changes them)."""
    pid = p['id']

    def fail(msg):
        raise SystemExit(f'{pid}: {msg}')

    def text(v, path, optional=False):
        if v is None and optional:
            return
        if not isinstance(v, str) or not v.strip():
            fail(f'{path} must be non-empty text')

    def texts(v, path):
        if v is None:
            return
        if not isinstance(v, list) or not v:
            fail(f'{path} must be a non-empty list of text')
        for i, x in enumerate(v):
            text(x, f'{path}[{i}]')

    def date(v, path, optional=True):
        if v is None and optional:
            return
        if not isinstance(v, str) or not DATE.fullmatch(v):
            fail(f'{path} must be YYYY-MM-DD' + (' or null' if optional else ''))

    def https(v, path, optional=False):
        if v is None and optional:
            return
        if not isinstance(v, str) or not v.startswith('https://'):
            fail(f'{path} must be an https:// URL')

    d = p['dates']
    date(d.get('start'), 'dates.start', optional=False)
    date(d.get('end'), 'dates.end', optional=False)
    if d['end'] < d['start']:
        fail('dates.end is before dates.start')
    date(p.get('booking_closes'), 'booking_closes')
    if p.get('booking_closes') and p['booking_closes'] > d['start']:
        fail('booking_closes is after dates.start')
    https(p['terms_url'], 'terms_url')
    https(p.get('privacy_url'), 'privacy_url', optional=True)
    https(p.get('about_url'), 'about_url', optional=True)
    mg = p.get('max_guests_per_booking', 6)
    if not isinstance(mg, int) or not 1 <= mg <= 12:
        fail('max_guests_per_booking must be 1..12 (metadata holds 12 guests)')

    dep = p['deposit']
    if not isinstance(dep.get('percent'), int) or not 1 <= dep['percent'] <= 100:
        fail('deposit.percent must be 1..100')
    date(dep.get('balance_due'), 'deposit.balance_due')
    date(dep.get('available_until'), 'deposit.available_until')
    if dep.get('balance_due') and dep['balance_due'] > d['start']:
        fail('deposit.balance_due is after the start date')

    prog = p.get('programme')
    if prog is not None:
        texts(prog.get('includes'), 'programme.includes')
    texts(p.get('stay_includes'), 'stay_includes')
    texts(p.get('not_included'), 'not_included')

    pm = p.get('payment_methods')
    if pm is not None:
        for mode in ('payment', 'plan'):
            lst = pm.get(mode)
            if lst is None:
                continue
            if not isinstance(lst, list) or not all(isinstance(x, str) and PM_TYPE.fullmatch(x) for x in lst):
                fail(f'payment_methods.{mode} must be a list of Stripe payment method types (e.g. "card")')
            if 'card' not in lst:
                fail(f'payment_methods.{mode} must include "card" (it is the fallback)')
            if len(lst) != len(set(lst)):
                fail(f'payment_methods.{mode} has duplicates')

    pol = p.get('policy')
    if pol is not None:
        texts(pol.get('points'), 'policy.points')
        if not isinstance(pol.get('change_notice_days'), int) or pol['change_notice_days'] < 0:
            fail('policy.change_notice_days must be a whole number of days')
        text(pol.get('change_note'), 'policy.change_note')
        text(pol.get('health_note'), 'policy.health_note', optional=True)
        https(pol.get('medical_url'), 'policy.medical_url', optional=True)
        https(pol.get('waiver_url'), 'policy.waiver_url', optional=True)

    arr = p.get('arrival')
    if arr is not None:
        for k in ('checkin', 'checkout', 'travel'):
            text(arr.get(k), f'arrival.{k}', optional=True)

    tr = p.get('trust')
    if tr is not None:
        rt = tr.get('rating')
        if rt is not None:
            if not isinstance(rt.get('score'), (int, float)) or not 0 <= rt['score'] <= 5:
                fail('trust.rating.score must be 0..5')
            if not isinstance(rt.get('count'), int) or rt['count'] < 0:
                fail('trust.rating.count must be a whole number')
            https(rt.get('url'), 'trust.rating.url')
            date(rt.get('as_of'), 'trust.rating.as_of', optional=False)
            text(rt.get('source'), 'trust.rating.source')
        for i, t in enumerate(tr.get('testimonials') or []):
            text(t.get('quote'), f'trust.testimonials[{i}].quote')
            text(t.get('name'), f'trust.testimonials[{i}].name')
            text(t.get('place'), f'trust.testimonials[{i}].place', optional=True)
            https(t.get('video'), f'trust.testimonials[{i}].video', optional=True)
        h = tr.get('hosts')
        if h is not None:
            text(h.get('names'), 'trust.hosts.names')
            text(h.get('line'), 'trust.hosts.line')
            https(h.get('photo'), 'trust.hosts.photo', optional=True)
        texts(tr.get('facts'), 'trust.facts')

    wa = (p.get('contact') or {}).get('whatsapp')
    if wa is not None and not re.fullmatch(r'\+[1-9]\d{6,14}', str(wa)):
        fail('contact.whatsapp must be +<country code><number>, no spaces')


def load():
    programs = {}
    for f in sorted(glob.glob(os.path.join(ROOT, 'booking', 'programs', '*.json'))):
        p = json.load(open(f, encoding='utf-8'))
        missing = [k for k in REQUIRED if k not in p]
        if missing:
            raise SystemExit(f'{os.path.basename(f)}: missing {missing}')
        ids = [r['id'] for r in p['rooms']]
        if len(ids) != len(set(ids)):
            raise SystemExit(f"{p['id']}: duplicate room ids")
        genders = {g.lower() for g in p['genders']}
        for r in p['rooms']:
            for k in ('id', 'name', 'price', 'unit', 'sleeps', 'photos'):
                if k not in r:
                    raise SystemExit(f"{p['id']}/{r.get('id')}: missing {k}")
            if r.get('same_gender'):
                # shared, single-gender rooms: physical rooms + beds already taken
                if not isinstance(r.get('units'), int) or r['units'] < 0:
                    raise SystemExit(f"{p['id']}/{r['id']}: same_gender rooms need units (number of rooms)")
                for o in r.get('occupied', []):
                    if o.get('gender') is not None and o['gender'].lower() not in genders:
                        raise SystemExit(f"{p['id']}/{r['id']}: occupied gender must be one of {sorted(genders)} or null")
                    if not 0 < o.get('beds', 0) <= r['sleeps']:
                        raise SystemExit(f"{p['id']}/{r['id']}: occupied beds must be 1..{r['sleeps']}")
                if len(r.get('occupied', [])) > r['units']:
                    raise SystemExit(f"{p['id']}/{r['id']}: more occupied rooms than units")
            elif not isinstance(r.get('capacity'), int) or r['capacity'] < 0:
                raise SystemExit(f"{p['id']}/{r['id']}: missing capacity")
            if not isinstance(r['price'], int) or r['price'] < 0:
                raise SystemExit(f"{p['id']}/{r['id']}: price must be whole euros")
            if r.get('names') is not None:
                nm = r['names']
                want = r['units'] if r.get('same_gender') else r.get('capacity')
                if not isinstance(nm, list) or not all(isinstance(x, str) and x.strip() for x in nm) or len(set(nm)) != len(nm):
                    raise SystemExit(f"{p['id']}/{r['id']}: names must be a list of unique room names")
                if len(nm) != want:
                    raise SystemExit(f"{p['id']}/{r['id']}: {len(nm)} names but {want} {'units' if r.get('same_gender') else 'capacity'}")
            if not isinstance(r['sleeps'], int) or r['sleeps'] < 1:
                raise SystemExit(f"{p['id']}/{r['id']}: sleeps must be a whole number of beds")
            if r['unit'] != 'person':
                # priced per room/cottage: capacity counts whole units (each booking takes ceil(guests / sleeps))
                if r.get('same_gender'):
                    raise SystemExit(f"{p['id']}/{r['id']}: rooms not priced per person can't be same_gender")
                if r['sleeps'] < 2:
                    raise SystemExit(f"{p['id']}/{r['id']}: unit {r['unit']!r} needs sleeps >= 2 (else use unit \"person\")")
        prog = p.get('programme')
        if prog is not None and (not isinstance(prog.get('fee'), int) or prog['fee'] < 0 or not prog.get('name')):
            raise SystemExit(f"{p['id']}: programme needs a name and a fee in whole euros")
        lpb = (p.get('payment_plan') or {}).get('last_payment_by')
        if lpb not in (None, 'before_arrival') and not re.fullmatch(r'\d{4}-\d{2}-\d{2}', str(lpb)):
            raise SystemExit(f"{p['id']}: payment_plan.last_payment_by must be \"before_arrival\", YYYY-MM-DD or null")
        check_content(p)
        programs[p['id']] = p
    return programs


REPO = 'Alchemy-of-Breath/website'
ROOMS_DIR = 'assets/booking/rooms'
SERVICES_DIR = 'assets/booking/services'
SERVICE_ID = re.compile(r'[a-z0-9][a-z0-9-]{1,60}')


def load_services():
    """booking/services.json: the wellbeing-session catalogue (validated)."""
    path = os.path.join(ROOT, 'booking', 'services.json')
    if not os.path.exists(path):
        return None
    c = json.load(open(path, encoding='utf-8'))

    def fail(msg):
        raise SystemExit(f'services.json: {msg}')
    if c.get('currency') != 'EUR':
        fail('currency must be EUR')
    cats = c.get('categories') or {}
    pr = c.get('practitioners') or {}
    for k, v in pr.items():
        for f in ('name', 'role', 'photo', 'bio'):
            if not isinstance(v.get(f), str) or not v[f].strip():
                fail(f'practitioners.{k}.{f} must be text')
        if v.get('team_url') and not v['team_url'].startswith('https://'):
            fail(f'practitioners.{k}.team_url must be https')
        for size in ('sq-480', '43-960'):
            for ext in ('webp', 'jpg'):
                if not os.path.exists(os.path.join(ROOT, SERVICES_DIR, f"{v['photo']}-{size}.{ext}")):
                    fail(f'missing photo {SERVICES_DIR}/{v["photo"]}-{size}.{ext}')
    ids = set()
    for i, s in enumerate(c.get('services') or []):
        if not SERVICE_ID.fullmatch(str(s.get('id', ''))) or s['id'] in ids:
            fail(f'services[{i}].id must be unique lowercase-dash text')
        ids.add(s['id'])
        if s.get('practitioner') not in pr:
            fail(f'{s["id"]}: unknown practitioner')
        if s.get('category') not in cats:
            fail(f'{s["id"]}: unknown category')
        for f in ('title', 'tagline', 'description'):
            if not isinstance(s.get(f), str) or not s[f].strip():
                fail(f'{s["id"]}.{f} must be text')
        if not isinstance(s.get('price'), int) or s['price'] <= 0:
            fail(f'{s["id"]}.price must be whole euros > 0')
        if not isinstance(s.get('minutes'), int) or not 15 <= s['minutes'] <= 480:
            fail(f'{s["id"]}.minutes must be 15..480')
    lim = c.get('limits') or {}
    for k in ('per_service', 'per_booking'):
        if not isinstance(lim.get(k), int) or not 1 <= lim[k] <= 20:
            fail(f'limits.{k} must be 1..20')
    return c


def resolve_services(p, catalogue):
    """Replace a program's "services" ("all" | [ids] | absent) with the resolved list."""
    want = p.get('services')
    if not want or not catalogue:
        p.pop('services', None)
        return
    items = catalogue['services'] if want == 'all' else [s for s in catalogue['services'] if s['id'] in set(want)]
    if want != 'all':
        unknown = set(want) - {s['id'] for s in catalogue['services']}
        if unknown:
            raise SystemExit(f"{p['id']}: unknown services {sorted(unknown)}")
    used = {s['practitioner'] for s in items}
    cats = [k for k in catalogue['categories'] if any(s['category'] == k for s in items)]
    p['services'] = {
        'currency': catalogue['currency'],
        'note': catalogue.get('note', ''),
        'booking_url': catalogue.get('booking_url'),
        'limits': catalogue['limits'],
        'categories': {k: catalogue['categories'][k] for k in cats},
        'practitioners': {k: v for k, v in catalogue['practitioners'].items() if k in used},
        'items': items,
        'source': catalogue.get('source', ''),
    }
MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']


def image_base(folder=ROOMS_DIR):
    """jsDelivr URL of a photo folder, pinned to the last commit that changed it (immutable, so it
    can't serve a stale @main). Falls back to @main outside a git checkout."""
    ref = 'main'
    try:
        sha = subprocess.run(['git', '-C', ROOT, 'log', '-1', '--format=%H', '--', folder],
                             capture_output=True, text=True, check=True).stdout.strip()
        dirty = subprocess.run(['git', '-C', ROOT, 'status', '--porcelain', '--', folder],
                               capture_output=True, text=True, check=True).stdout.strip()
        if re.fullmatch(r'[0-9a-f]{40}', sha):
            ref = sha
        if dirty:
            print(f'warning: uncommitted changes in {folder}: pages point at the last committed photos ({ref[:7]})')
    except (OSError, subprocess.CalledProcessError):
        print(f'warning: git not available, {folder} from @main')
    return f'https://cdn.jsdelivr.net/gh/{REPO}@{ref}/{folder}/'


def public_copy(p, img_base, svc_base=None):
    """What the browser gets: no internal notes ("about" keys, source notes, RetreatGuru ids)."""
    def strip(v):
        if isinstance(v, dict):
            return {k: strip(x) for k, x in v.items() if k != 'about'}
        if isinstance(v, list):
            return [strip(x) for x in v]
        return v
    q = strip(p)
    q['source'] = {'snapshot': (p.get('source') or {}).get('snapshot')}
    for k in ('policy', 'arrival'):
        if isinstance(q.get(k), dict):
            q[k].pop('source', None)
    if isinstance(q.get('trust'), dict):
        q['trust'].pop('source', None)  # trust.rating.source ("Trustpilot") stays: the page shows it
    for r in q.get('rooms', []):
        r.pop('rg_id', None)
        r.pop('names', None)  # physical room names are for the team (admin), not the public page
    if isinstance(q.get('services'), dict):
        q['services'].pop('source', None)
        q['services']['img_cdn'] = svc_base
    q['img_cdn'] = img_base
    return q


def head_html(p):
    """<title> and meta description for a generated booking page."""
    e = lambda s: html.escape(str(s), quote=True)
    ed = p.get('edition') or p['title']
    d = p['dates']
    title = f'Book {ed} · {d.get("medium") or d["label"]} | Alchemy of Breath'
    fee = (p.get('programme') or {}).get('fee')
    desc = (f'Book {ed} at {p["venue"]["name"]} in Tuscany, {d.get("medium") or d["label"]}: '
            + (f'the €{fee} programme fee and your room in one booking. ' if fee else 'choose your room. ')
            + 'Live availability, a deposit on your room or pay in full, secure payment by Stripe.')
    return f'\n<title>{e(title)}</title>\n<meta name="description" content="{e(desc)}">\n'


def hub_entry(p):
    """Public summary of a week for the hub page (book/index.html)."""
    fee = (p.get('programme') or {}).get('fee') or 0
    def all_in(r):
        return r['price'] + fee * (1 if r['unit'] == 'person' else r['sleeps'])
    rooms = p['rooms']
    return {
        'id': p['id'], 'title': p['title'], 'edition': p.get('edition', ''), 'dates': p['dates'],
        'venue': p['venue']['name'], 'region': p['venue'].get('region', ''), 'currency': p['currency'],
        'url': f'/book/{p["id"]}/', 'booking_closes': p.get('booking_closes'), 'program_spaces': p['program_spaces'],
        'programme_fee': fee, 'from_all_in': min(all_in(r) for r in rooms if r['unit'] == 'person') if rooms else None,
        'room_from': min(r['price'] for r in rooms if r['unit'] == 'person') if rooms else None,
        'hero_image': p.get('hero_image') or 'asha-campus.jpg', 'services': len((p.get('services') or {}).get('items') or []),
        # so the hub can show a "from" price over rooms that are still bookable (live availability)
        'rooms': [{'id': r['id'], 'price': r['price'], 'unit': r['unit'], 'sleeps': r['sleeps']} for r in rooms],
    }


def day_month(iso):
    y, m, d = (int(x) for x in iso.split('-'))
    return f'{d} {MONTHS[m - 1]}'


def hero_html(p, img_base):
    """The slim booking header as the page script would draw it before availability arrives (no
    layout shift). The week itself is explained on the BreathCamp page (about_url)."""
    e = lambda s: html.escape(str(s), quote=True)
    d, v, n = p['dates'], p['venue'], p['dates']['nights']
    chips = ['<li class="live sk" id="placesChip"><span><b id="placesLeft">–</b> <span id="placesTxt">places left</span></span></li>',
             f'<li id="closesChip">Booking closes {e(day_month(p["booking_closes"]))}</li>' if p.get('booking_closes') else '<li id="closesChip" hidden></li>',
             '<li id="fromChip" hidden></li>']
    eyebrow = f'{p.get("edition") or p["title"]} · {v["name"].replace(" Retreat Centre", "")}, {v.get("region", "")}'
    about = (f'  <a class="about-link" href="{e(p["about_url"])}" target="_blank" rel="noopener">About {e(p["title"])} <span aria-hidden="true">&rarr;</span></a>\n'
             if p.get('about_url') else '')
    return (
        '\n  <div class="hb">\n'
        f'    <p class="eyebrow" id="heroEyebrow">{e(eyebrow)}</p>\n'
        '    <h1 id="heroH1">Book your place and <em>room</em>.</h1>\n'
        '    <p class="when"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>'
        f'<span id="heroWhen"><span class="wl">{e(d["label"])}</span><span class="ws">{e(d.get("medium") or d["label"])}</span> · {n} nights</span></p>\n'
        '    <ul class="chips" aria-label="At a glance">\n      ' + '\n      '.join(chips) + '\n    </ul>\n'
        '  </div>\n' + about
    )


def inject(path, start, end, block):
    if not os.path.exists(path):
        return False
    s = open(path, encoding='utf-8').read()
    pat = re.escape(start) + r'.*?' + re.escape(end)
    if not re.search(pat, s, re.S):
        raise SystemExit(f'{path}: markers not found')
    n = re.sub(pat, lambda m: start + block + end, s, count=1, flags=re.S)
    if n != s:
        open(path, 'w', encoding='utf-8').write(n)
    return True


TEMPLATE = os.path.join(ROOT, 'tools', 'booking', 'page-template.html')


def main():
    programs = load()
    catalogue = load_services()
    for p in programs.values():
        resolve_services(p, catalogue)
    js = ('// GENERATED by tools/booking/build.py from booking/programs/*.json. Do not edit by hand.\n'
          'export default ' + json.dumps(programs, ensure_ascii=False, indent=1) + ';\n')
    open(os.path.join(ROOT, 'booking-lib', 'programs.js'), 'w', encoding='utf-8').write(js)
    print(f'booking-lib/programs.js: {len(programs)} program(s)')
    img_base = image_base()
    svc_base = image_base(SERVICES_DIR)
    template = open(TEMPLATE, encoding='utf-8').read() if os.path.exists(TEMPLATE) else None
    for pid, p in programs.items():
        page = os.path.join(ROOT, 'book', pid, 'index.html')
        if template is not None:
            os.makedirs(os.path.dirname(page), exist_ok=True)
            if not os.path.exists(page) or open(page, encoding='utf-8').read() != template:
                open(page, 'w', encoding='utf-8').write(template)
        data = json.dumps(public_copy(p, img_base, svc_base), ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
        ok = inject(page, '<script type="application/json" id="programData">', '</script><!-- /PROGRAM-DATA -->', data)
        if ok:
            inject(page, '<!-- HERO:start -->', '<!-- HERO:end -->', hero_html(p, img_base))
            if '<!-- PROGRAM-HEAD -->' in open(page, encoding='utf-8').read():
                inject(page, '<!-- PROGRAM-HEAD -->', '<!-- /PROGRAM-HEAD -->', head_html(p))
        print(f"book/{pid}/index.html: {'generated' if ok else 'no page yet'} (photos {img_base.split('@')[1].split('/')[0][:7]})")
    weeks = sorted((hub_entry(p) for p in programs.values()), key=lambda w: w['dates']['start'])
    hub = json.dumps({'img_cdn': img_base, 'weeks': weeks}, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
    if inject(os.path.join(ROOT, 'book', 'index.html'),
              '<script type="application/json" id="programsData">', '</script><!-- /PROGRAMS-DATA -->', hub):
        print('book/index.html: updated')
    listing = json.dumps([{'id': p['id'], 'title': p['title'], 'edition': p.get('edition', ''), 'dates': p['dates']}
                          for p in sorted(programs.values(), key=lambda x: x['dates']['start'])], ensure_ascii=False, separators=(',', ':'))
    if inject(os.path.join(ROOT, 'book', 'admin', 'index.html'),
              '<script type="application/json" id="programList">', '</script><!-- /PROGRAM-LIST -->', listing):
        print('book/admin/index.html: updated')


if __name__ == '__main__':
    main()
