// Classify captured URL claims, never the form variant or a contact's old source.
export function attribution(payload) {
  const clean = key => String(payload[key] || '').trim().slice(0, 250);
  const source = clean('utm_source').toLowerCase();
  const medium = clean('utm_medium').toLowerCase();
  const social = ['meta', 'meta-ads', 'meta_ads', 'facebook', 'facebook_ads', 'fb', 'instagram', 'ig'].includes(source);
  const paid = ['paid_social', 'paid-social', 'paid', 'ppc', 'cpc'].includes(medium);
  const organicSocial = ['organic', 'social', 'organic_social', 'social_media'].includes(medium);
  const numeric = value => /^\d{5,25}$/.test(value) ? value : '';
  return {
    application_lead_source: source ? (social && paid ? 'Meta Ads' : social && organicSocial ? 'Social Direct' : medium === 'organic' ? 'Website Organic' : source) : 'Unknown',
    attribution_status: source ? 'captured_utm' : 'unknown',
    // Legacy current ads put campaign.id in utm_id and adset.id in utm_term.
    // Promote those only for an explicitly named Meta source; preserve raw values too.
    meta_campaign_id: numeric(clean('meta_campaign_id')) || numeric(clean('campaign_id')) || (social ? numeric(clean('utm_id')) : ''),
    meta_adset_id: numeric(clean('meta_adset_id')) || numeric(clean('adset_id')) || (social ? numeric(clean('utm_term')) : ''),
    meta_ad_id: numeric(clean('meta_ad_id')) || numeric(clean('ad_id')),
  };
}
