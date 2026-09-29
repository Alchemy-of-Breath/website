#!/usr/bin/env python3
"""Inline tools/utm/aob-utm.js into every site page, right after <meta charset>.

    python3 tools/utm/inject.py

Idempotent: an existing copy (between the AOB-UTM markers) is replaced, so edit
aob-utm.js and rerun. Pages hosted in GoHighLevel (breathcamp/) are skipped:
GHL funnels capture UTM tags from their own URL. The Breathe The World pages
get the snippet from tools/btw/build.py, which calls snippet() below.
"""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, 'tools', 'utm', 'aob-utm.js')
SKIP = ('email-templates', 'tools', 'wordpress-plugin', '.git', 'breathcamp' + os.sep)
START, END = '<!-- AOB-UTM:start -->', '<!-- AOB-UTM:end -->'


def snippet():
    return f'{START}\n<script>\n{open(SRC, encoding="utf-8").read().strip()}\n</script>\n{END}'


def apply(text):
    block = snippet()
    if START in text:
        return re.sub(re.escape(START) + r'.*?' + re.escape(END), lambda m: block, text, count=1, flags=re.S)
    m = re.search(r'<meta charset="[^"]*"\s*/?>\n?', text, re.I)
    if not m:
        raise ValueError('no <meta charset>')
    return text[:m.end()] + block + '\n' + text[m.end():]


def main():
    done = []
    for dirpath, dirs, files in os.walk(ROOT):
        rel = os.path.relpath(dirpath, ROOT) + os.sep
        if rel.startswith(SKIP) or rel.startswith(('btw' + os.sep,)):
            continue
        if 'index.html' in files:
            p = os.path.join(dirpath, 'index.html')
            s = open(p, encoding='utf-8').read()
            n = apply(s)
            if n != s:
                open(p, 'w', encoding='utf-8').write(n)
            done.append(os.path.relpath(p, ROOT))
    print(f'{len(done)} pages carry the UTM keeper:'); print('\n'.join(sorted(done)))


if __name__ == '__main__':
    main()
