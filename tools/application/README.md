# Durable facilitator applications

This branch replaces the browser's direct GHL webhook POST with a same-origin
Cloudflare Pages Function. It needs a D1 binding and server-side credentials before
it can serve production. Do not merge or deploy an unconfigured receiver.

## Application and attribution contract

1. The form prepares a UUID and stable timestamp for one logical application.
   Identical pending retries reuse that ID, including after a browser reload when
   storage is available. Pending browser metadata holds a digest, not form answers.
2. The receiver validates the payload and derives source/event IDs itself. D1 has
   a unique application_id, original payload, server received_at, qualification,
   attribution and processing states. Existing rows cannot be replaced by different
   answers under the same ID. Concurrent requests claim processing once.
3. GHL resolves the contact by email. Its returned ID is verified against the email
   and linked to the application. Original acquisition source and Lead Source are
   populated only if blank and attribution is explicit. Existing values are kept.
4. The existing GHL workflow receives the application and resolved contact ID once.
   Only after CRM confirmation and workflow HTTP acknowledgement does the browser
   receive an accepted receipt. This is not proof that every downstream email or
   workflow action completed; those remain visible in GHL execution logs.
5. Both variants use SubmitApplication for every accepted application and Lead for
   qualified applications only. `outcome=booking` means calendar eligibility, not
   an appointment. Each event ID is `application_id:event_name`.
6. The Meta outbox sends the same IDs through CAPI when explicitly enabled and
   configured. It records Meta events_received receipts. Browser dispatch is a
   separate attempted timestamp: it never marks provider acceptance.

Standard SubmitApplication behavior is retained; coaches now also emit it. Standard
qualified applications now also emit Lead, matching coaches. Both event types remain
separate; do not add them as applicants or rename either as a Schedule event.

## Source rules

Use the submitted UTMs, not form version, campaign name or old contact fields:

| Captured input | Application source |
|---|---|
| facebook/ppc, facebook/paid, meta/paid_social | Meta Ads |
| meta-ads/paid_social and explicit Meta aliases | Meta Ads |
| facebook/organic | Social Direct |
| google/organic | Website Organic |
| newsletter/email, partner/referral, google/cpc | Preserve the source name |
| No utm_source, even with fbclid | Unknown |

The application ledger preserves the raw source/medium. The existing GHL Lead Source
picklist uses Other for explicitly captured sources outside its named categories;
GHL native source and the application ledger retain their actual source name. An
existing contact's original source is not a per-application source and is preserved.

Capture numeric campaign_id/adset_id/ad_id (or meta_* equivalents). Existing Meta
ads' numeric utm_id and utm_term are retained as campaign/adset IDs when utm_source
explicitly names Meta/Facebook/Instagram. Non-Meta utm_id is not reclassified as Meta.
No ad ID can be recovered if it was never supplied. Configure future ad URL tags:

```
utm_source=meta&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}
```

The inspected WordPress embed forwards the full URLSearchParams into the iframe,
including legacy and explicit IDs. Recheck the deployed embed before release.

## Required release configuration

Use the Cloudflare account that owns website-5h3.pages.dev, not another account.
Keep all existing Pages environment variables and bindings. Do not overwrite the
booking project's configuration. deployment.example.jsonc is a reference, not a
usable deployment config. wrangler.local.jsonc uses a dummy ID for local tests only.

- Create D1 `aob-facilitator-applications` in the AoB account. Bind it as
  APPLICATIONS_DB in production and use a separate database in preview.
- Apply migrations/0001_applications.sql before publishing the new form.
- Set APPLICATION_GHL_LOCATION_ID to 5lz2Wm44CNDwLSZWgAPf.
- Set APPLICATION_GHL_TOKEN as a scoped server-side GHL integration secret with
  contacts read/write permissions. Never expose it to the form or source control.
- Set APPLICATION_GHL_WEBHOOK_URL to the existing facilitator workflow's inbound
  webhook, retained in GHL. Preview must use an isolated workflow without customer
  communications; never point synthetic tests at the live workflow.
- Set APPLICATION_REPORT_TOKEN as an independent random secret of at least 32
  characters. The report endpoint is unavailable without it.
- CAPI: set APPLICATION_META_PIXEL_ID, APPLICATION_META_API_VERSION to an API version
  verified against the connected account, and APPLICATION_META_TOKEN as a secret.
  Set APPLICATION_META_CAPI_ENABLED=true only after the site's consent behavior and
  CAPI event delivery have been verified. Default is off; pending events are gaps,
  not silently successful conversions. Use APPLICATION_META_TEST_EVENT_CODE in
  isolated testing, then remove it before live traffic. A test receipt is not a live
  attributed conversion. Do not backfill old pending events automatically.
- Verify GHL no longer has an unconditional Meta Lead Source action, fixed contact
  source field, or fixed Meta opportunity source. The live source changes are
  snapshotted outside Git; this repository does not mutate workflow definitions.

Production release remains gated on the repository's PR acceptance. Preparing or
passing this branch's tests does not publish the form. Do not reopen PR #1; this
branch replaces the incomplete client-only proposal.

## Recovery and failure handling

D1 records the workflow attempt before the external POST. A timeout after GHL might
have accepted the request is needs_review/uncertain. It must not be retried blindly,
because an email/opportunity workflow is not an idempotent API. A crash can leave
processing or attempting visible in the report. No new application or Meta event is
invented to hide the gap.

For each stuck ID, inspect the original GHL inbound payload in execution logs and
match its applicationId, workflowStatusId and successful contact action. If the run
exists, reconcile its receipt into the ledger after checking the resolved contact;
if absence cannot be established, leave the delivery uncertain. A CRM-only failure
can be retried after checking the exact normalized email and contact. Do not reset
workflow_state without independent evidence that enrollment did not happen. Recovery
is an operator action, not a public HTTP endpoint. Back up D1 before any repair.

CAPI uncertain events retain stable IDs for a controlled retry within Meta's current
allowed event and deduplication window. Verify those limits before replay; an old
pending event must not be sent as a new conversion today. For duplicate/pending
browser deliveries, the endpoint returns the existing record and never resends GHL.

## Verification

```
node --test tools/application/test.mjs tools/application/receiver.test.mjs
npx wrangler pages functions build --outdir /private/tmp/aob-application-build
npx wrangler d1 migrations apply aob-application-local-check --local --config tools/application/wrangler.local.jsonc
```

The tests use actual SQLite schema/constraints with deterministic provider doubles.
They cover 25 parallel retries, altered-payload conflicts, both variants and all
outcomes, current Meta UTMs, future/unknown sources, original acquisition protection,
missing CRM receipt, ambiguous workflow delivery and CAPI failure/receipt handling.
They are not live GHL or Meta acceptance evidence.

Run local-harness.mjs with APPLICATION_TEST_DB pointing outside Git to a private test
SQLite file. It is localhost-only, uses production receiver/provider code with fake
GHL and Meta responses, and refuses unexpected external fetches. For browser checks,
proxy the virtual website-5h3.pages.dev origin to this local server in an isolated
browser; abort every other origin and install a pixel test double. Never navigate
that origin for this test without the proxy first. browser-journey.mjs drives both
qualified form variants; browser-finish.mjs covers the rejected coach ending.
The local fixture is test tooling, not an alternative production receiver.

## Reporting and parity

GET /api/application/report requires Bearer APPLICATION_REPORT_TOKEN. Use inclusive
from and exclusive to ISO timestamps; reporting is by server received_at, not mutable
contact creation date. Follow every next cursor before claiming complete counts.
Export all pages to one JSON with applications and events arrays and next=null, then:

```
node tools/application/reconcile.mjs private-complete-export.json
```

This checks one confirmed SubmitApplication event per CRM-confirmed application and
one Lead per qualified application by application ID. Missing/uncertain receipts
produce an explicit gap and a nonzero exit. It does not claim that Ads Manager's
attributed totals equal all GHL submissions. Attribution windows, view-through events,
consent and event-date settings remain distinct. Historical counts cannot be repaired
by deploying new code. A live test requires a real GHL receipt and Meta Test Events
acceptance with matching event IDs, followed by a like-for-like production cohort.
