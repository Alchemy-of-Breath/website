# Alchemy of Breath — Website 2026

Multi-page static website for [Alchemy of Breath](https://alchemyofbreath.com/), the online breathwork school founded by Anthony Abbagnano.

## Structure

Each page lives in its own folder as an `index.html`, so URLs stay clean (`/facilitator-training/` etc.). Pages are fully self-contained: inline CSS and JS, no build step, no dependencies.

| Path | Page |
|------|------|
| `/` | Development index (placeholder, `noindex`) |
| `/facilitator-training/` | 8-month Facilitator Training landing page |
| `/live-residential-breathwork-facilitator-training/` | 4-month Live Residential Facilitator Training (ASHA, Tuscany) landing page |

## Working on the site

No build step — open any `index.html` directly in a browser, or serve the folder:

```bash
python3 -m http.server 8000
```

## Conventions

- Brand fonts: Marcellus (headings) + Roboto (body), loaded from Google Fonts
- Brand palette: gold `#E1B668` / `#D6A652`, teal `#00A5B2`, slate `#5B7889`, ink `#221F20`, paper `#FBF7EF`
- Images are served from the live `alchemyofbreath.com` WordPress uploads and `assets.cdn.filesafe.space`
- Every page carries its own meta tags, Open Graph tags, and JSON-LD structured data
