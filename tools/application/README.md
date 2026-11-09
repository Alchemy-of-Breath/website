# Application identity and attribution contract

## What this change does

Both form variants now carry a random application ID and a stable submission timestamp.
Unchanged retries (including a reload in the same browser with storage available) reuse
that identity for up to 14 days. Edited answers or attribution are a different logical
application, with a new identity. On acceptance, the form prevents a second submit in
the current page. Restarting the demo explicitly starts a new application.

The browser stores only ID/timestamp/status and a SHA-256 digest in its pending-identity
entry. The pre-existing answer draft is separate and unchanged. If embedded storage is
blocked, `identity_persistence=memory` makes the reduced guarantee explicit; identity
then survives retries in that document but not reloads. The form requires HTTPS (or a
secure localhost context) for Web Crypto. Failure to prepare identity does not post a
submission or send a conversion.

The current webhook still responds before the GHL workflow completes. **An ID is a
correlation key, not server-side deduplication or a durable receipt.** This PR does not
make the webhook idempotent, prove a contact was saved, or implement an application ledger.

## Identifier ownership

| Field | Owner and meaning |
| --- | --- |
| `application_id` | Form-generated UUID, identifies one logical submission |
| `submitted_at` | First attempt's browser timestamp (UTC); retain server receipt time separately |
| `meta_event_id` | `application_id:SubmitApplication`, also passed as Pixel `eventID` |
| `qualified_lead_event_id` | `application_id:Lead` for qualified coaches only |
| GHL contact ID | Assigned/resolved by GHL after the contact action, never fabricated in the browser or accepted from a URL |
| `meta_campaign_id`, `meta_adset_id`, `meta_ad_id` | Captured explicit URL IDs, empty if absent |

The payload preserves raw `campaign_id`, `adset_id`, `ad_id`, `utm_*`, click IDs,
`h_ad_id` and `fbc_id`. Legacy `fbc_id` and `utm_id` are not guessed to be campaign IDs.
The calendar handoff retains the application ID and captured ad parameters, but the
calendar must separately persist the application ID to make a durable appointment join.

Configure actual Meta ad URL parameters (in Ads Manager, separately from this PR), e.g.:

```text
utm_source=meta&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}
```

The form cannot recover IDs the ad never supplied. UTMs are captured claims, not proof
of an ad impression, and must not be treated as Meta's advertising attribution model.

## GHL follow-up — not applied by this PR

Open **Facilitator Application – Web Form (Typeform replacement)** in the account's
Automation workflow list. Existing actions map webhook fields into contact fields.
The unconditional **Update contact field → Lead Source = Meta Ads** must be removed.
Also remove the unconditional **Create/update opportunity → source = Meta Ads –
Application Funnel – Indirect**. Changing form code cannot change those actions.

Use the following receiver contract after separate approval:

1. Store a separate application record per `application_id` with server receipt time,
   `submitted_at`, variant, outcome, raw attribution, event IDs and processing status.
   Enforce ID uniqueness at the receiver; repeated deliveries return the same receipt.
   Do not use mutable contact fields as the historical ledger.
2. Create/update the contact, then bind the application to the **resolved `contact.id`**.
   The receipt/ledger owns `application_id → contact_id`; do not send a GHL API token
   to the browser. A webhook acknowledgement without this result is still pending CRM
   processing, not proof of a saved contact.
3. Store `application_lead_source` on the application. Its proposed labels match the
   current contact picklist: explicit paid Meta UTMs → `Meta Ads`, explicit organic
   social → `Social Direct`, other organic → `Website Organic`, otherwise `Other`.
   Missing attribution remains `attribution_status=unknown`; do not equate it with
   organic traffic. Preserve raw source/medium so future sources remain distinguishable.
4. Keep original contact acquisition source separate from application source. If the
   business chooses to populate the contact's Lead Source from this value, do so only
   when the original field is blank. Do not overwrite an existing contact's history.
5. Store `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `utm_id`,
   campaign/ad-set/ad IDs and click IDs per application. The current workflow retains
   only source/medium/campaign on the contact; adding payload fields alone does not save them.
6. Keep receipt recording separate from follow-up email enrollment. Do not enable
   re-entry blindly: retries must not send additional emails or create opportunities.

The smallest complete durable receiver is one server-side application table with a
unique application ID and a recorded GHL delivery/contact result. That requires an
approved receiver/storage deployment beyond this form-only PR. A transitional set of
contact custom fields improves visibility but is **not** a historical application ledger.

## Meta events and pixel scope

After a successful webhook HTTP response, both variants send `SubmitApplication`.
Qualified coaches also retain their existing `Lead` event and `coach-ad` content
category. The two event types have different IDs; do not sum them as unique applicants.
Existing campaign optimization settings are unchanged. Reporting must name the exact
action type, variant, attribution window, timezone and date basis. Record the rollout
date: coach `SubmitApplication` coverage starts with this release and is not backfilled.

Browser events are suppressed on local/preview hosts, even when `embed_page` claims a
production URL. Only the production WordPress hosts and the stable Pages origin may
post to the live webhook. Preview/local paths use the existing demo ending.

This PR does not change WordPress PixelYourSite, its server-side integration, cookie
consent, GTM, or account-wide event rules. Inspect those separately. If a server later
sends an application conversion, it must use the corresponding event name and ID;
an unrelated PageView ID cannot deduplicate an application conversion. Do not assume
the presence of server-side pixel configuration proves duplicate applications.

## Validation and deployment

Run `node --test tools/application/test.mjs`. The suite executes the shipped inline
helper and actual submit handler with synthetic responses; it checks retry identity,
failure handling, event semantics, attribution and preview safety without live traffic.
The proposed **Application contract / application-contract** CI workflow is provided at
`tools/application/application-contract.yml`. It is not installed: the available GitHub
OAuth credential lacks the `workflow` scope. A repository administrator must review and
copy it to `.github/workflows/application-contract.yml`, then require its passing check.
Local tests pass independently of hosted CI. This is not a browser
UI acceptance test or end-to-end GHL/Meta proof. There is no `.reticle.json`, so there
is no Reticle verdict; UI behavior remains unverified by Reticle. Reticle can be wired
with `reticle init` in a separate verification setup.

Keep this PR draft until the receiver/mappings and reporting definitions are agreed.
No production workflow, ad, pixel setting, infrastructure or WordPress install is changed
by opening the PR. Branches may receive Cloudflare preview builds, which run demo mode.
Production promotion depends on the actual Cloudflare production-branch configuration,
not on a successful PR test alone. Check it before merging. Required reviews/checks must
be configured as repository rules; adding a CI YAML does not enforce a merge gate.

After approval and coordinated rollout, verify the persisted application/contact link,
one event per declared conversion, failed-delivery visibility, and campaign joins in a
bounded test. Compare historical data separately; missing IDs and submission dates cannot
be reconstructed just by deploying this change.
