# TG pages (Tania Glavey)

New pages prepared by Tania Glavey (TG) for review. Every folder starts with `tg-` so it is clear who made it, and none of them replace an existing live page.

| Path | Page |
|------|------|
| `/tg-facilitator-training-online/` | 8-month online Facilitator Training landing page: currently enrolling dates, two-path earnings calculator (starting new / adding to a practice, by region), sticky section menu, embedded booking calendar and details form, personalized certificate |
| `/tg-live-residential-facilitator-training/` | 21-day Live Residential Facilitator Training at ASHA, Tuscany (June 20 to July 10, 2027): land gallery, rooms and 2027 prices with per-night breakdown, logistics FAQ |
| `/tg-breathcamp-2027/` | Public BreathCamp 2027 page (BreathCamp 1, July 11 to 17): arrival footage hero, nervous system regulation outcomes, day-by-day week, guest videos, 2027 public prices |
| `/tg-breathcamp-2027-graduates/` | Graduate booking page for BreathCamp 2027 (T33 weeks), student prices, how to book. Set to noindex |
| `/tg-breathcamp-2027-black-friday/` | Black Friday BreathCamp 2027 page for new members (Friday, November 27): sticky banner with countdown and waitlist button, 15% off every room (save up to €1,275), two bonus Quantum Shift recordings, timer ends at each visitor's local midnight |
| `/tg-facilitator-training-black-friday-call/` | Facilitator Training Black Friday pre-sale page: book a free Success Advisor call before Saturday, November 28. Countdown, call calendar (GHL HIsztrgjz5xPddzyqeSe); on the day the calendar hides and buttons point to the sales page |
| `/tg-facilitator-training-black-friday/` | Facilitator Training Black Friday sales page (Saturday, November 28): $5,040 instead of $7,200, online (T35) or Live Residential (June 2027), online vs Tuscany comparison table, checkout buttons, live Q&A with Amy and Anthony at 9am Pacific |
| `/tg-intuition-black-friday/` | Black Friday Monday (November 30): 15% off the 2027 Intuition Retreat with Amy Rachelle (August 29 to September 4, 2027, ASHA). Content from asha.global/intuition-retreat; countdown to the visitor's local midnight; waitlist button before Monday |
| `/tg-black-friday-last-chance/` | Black Friday Tuesday (December 1): "One last chance to say yes". All three offers in one place (BreathCamp, Facilitator Training, Intuition), each card links to its offer page. The BreathCamp, FT sales and Intuition pages reopen automatically for the whole of Tuesday, December 1, in each visitor's own time zone, with a "Last chance" countdown |
| `/tg-black-friday-waitlist/` | Black Friday waitlist ("Five days. Five invitations."; no prices or savings shown): dark page with gold orbs, countdown to Friday, November 27 (visitor's local midnight), the flipping five-day window, and the GHL form "Black Friday 2027 Waitlist form" (8N8JN6yKbRFFhwSrDV96) embedded inline. The BreathCamp Black Friday banner's waitlist button links here |
| `/tg-homepage-black-friday/` | The current homepage with its hero swapped for the Black Friday week hero: dark background with gold orbs, countdown, waitlist button and a flipping five-day window (Fri BreathCamp, Sat Facilitator Training, Sun Breathe the World with a surprise gift, Mon ASHA retreats incl. Intuition with Amy, Tue surprise). Everything below the hero is unchanged. Set to noindex. To go live, swap this hero into `/index.html` for November 18 to December 1, then switch it back |
| `/tg-facilitator-training-brochure/` | Facilitator Training brochure (web version) plus the PDF download |

## Live on alchemyofbreath.com

Pushed to `main` on November 18, 2026 (commit 9330463). The `tg-` copies here stay as the review versions; edit the live files on `main` for changes from now on.

- Homepage (`/index.html`): the Black Friday week hero from `/tg-homepage-black-friday/` is live, indexable as before. Its waitlist button goes to `/offer/black-friday/#join`. Switch the hero back after December 1 (the previous hero is in commit 2d795ed).
- `/offer/black-friday/`: the waitlist page from `/tg-black-friday-waitlist/`, with the GHL form.
- `/offer/facilitator-training-brochure/`: the brochure from `/tg-facilitator-training-brochure/`. Its images and the PDF moved to `/assets/brochure/` and load through jsDelivr, because alchemyofbreath.com doesn't serve the repo's image or PDF files itself. PDF link: https://cdn.jsdelivr.net/gh/Alchemy-of-Breath/website@9330463ce50865d33b178370d75e23356c047e5b/assets/brochure/alchemy-of-breath-facilitator-training-brochure.pdf
- Also live since November 18, 2026 (commit 38eb2ab), with the links between them pointing at the live addresses:
  - `/offer/breathcamp-2027-black-friday/` (from `/tg-breathcamp-2027-black-friday/`; waitlist buttons go to `/offer/black-friday/#join`)
  - `/offer/facilitator-training-black-friday-call/` (from `/tg-facilitator-training-black-friday-call/`)
  - `/offer/facilitator-training-black-friday/` (from `/tg-facilitator-training-black-friday/`)
  - `/offer/intuition-black-friday/` (from `/tg-intuition-black-friday/`)
  - `/offer/black-friday-last-chance/` (from `/tg-black-friday-last-chance/`)
- July BreathCamp and Intuition checkouts went live on November 18 (commit b1755ff): July buttons go to Retreat Guru "BreathCamp 2 (Jul 11 – Jul 17, 2027) | New Members", Intuition buttons to "Intuition with Amy (Aug 29 – Sep 4, 2027)".
- Still placeholders on the live pages: the three Facilitator Training checkouts and the Q&A registration button.

## Before going live

- BreathCamp booking buttons on the public and graduate pages still use Retreat Guru preview links (`/program/preview/717`, `718`, `719`). Swap for the live booking links.
- The online page's booking calendar and details form are GoHighLevel embeds and expect to run on alchemyofbreath.com.
- Black Friday BreathCamp page: the waitlist button links to `/tg-black-friday-waitlist/`. The June camp buttons go to the Retreat Guru program "BreathCamp 1 (June 6 - June 12, 2027) | New Members", which is the regular new-member checkout, so check that the 15% Black Friday price is applied there on November 27. The July camp buttons go to "BreathCamp 2 (Jul 11 – Jul 17, 2027) | New Members"; check the 15% there too.
- Prices: 2027 new-member BreathCamp prices updated on November 18, 2026 (from €2,061 for your own tent to €8,500 for the private cottage for two). Black Friday prices are 15% off those, so the most you can save is €1,275. Student prices on the graduate page are unchanged.
- The public BreathCamp page covers July 11 to 17 but calls it BreathCamp 1. On the live 2027 calendar, BreathCamp 1 is June 6 to 12 and July 11 to 17 is BreathCamp 2.
- Facilitator Training Black Friday pages: checkout buttons (`#checkout-online-full`, `#checkout-online-deposit`, `#checkout-residential-deposit`) and the Q&A registration button (`#qa-register`) are placeholders. The two pages link to each other by their `/tg-` paths; update those links if the pages move. Online class times still show the single Tuesday slot until the morning and 2pm times are confirmed.
- Intuition Black Friday page: the booking buttons go to Retreat Guru "Intuition with Amy (Aug 29 – Sep 4, 2027)"; check the 15% there on November 30. No euro prices are shown until the 2027 Intuition room prices are confirmed.
- Last-chance page: in the GHL copy the three cards use `#offer-breathcamp`, `#offer-facilitator-training` and `#offer-intuition`; swap for the final page URLs. Retreat Guru and GHL checkouts must also accept the Black Friday prices again on Tuesday, December 1.
- Page analytics events (Clarity and Meta Pixel) fire only once those tracking codes are installed.
