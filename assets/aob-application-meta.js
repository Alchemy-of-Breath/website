// The application owns only submission/qualification events. Its WordPress parent
// owns PageView. Load/init the iframe pixel once, after consent and a CRM receipt.
(function (root) {
  'use strict';
  var status = 'unknown', initialized = false;
  var allowedParents = ['https://alchemyofbreath.com', 'https://www.alchemyofbreath.com'];
  root.addEventListener('message', function (event) {
    if (root.parent === root || event.source !== root.parent || allowedParents.indexOf(event.origin) === -1) return;
    if (!event.data || event.data.type !== 'aob:application:consent' || ['granted', 'denied', 'unknown'].indexOf(event.data.status) === -1) return;
    status = event.data.status;
    if (allowed() && root.AoBApplication.productionHost(root.location.hostname)) ensureSdk();
    if (typeof root.fbq === 'function' && initialized) root.fbq('consent', allowed() ? 'grant' : 'revoke');
  });
  if (root.parent !== root) {
    try {
      var parentOrigin = new URL(root.document.referrer || new URLSearchParams(root.location.search).get('embed_page')).origin;
      if (allowedParents.indexOf(parentOrigin) !== -1) root.parent.postMessage({ type: 'aob:application:consent-request' }, parentOrigin);
    } catch (e) {}
  }
  function allowed() { return status === 'granted' && root.navigator.globalPrivacyControl !== true; }
  function ensureSdk() {
    if (!root.fbq) {
        var n = root.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
        if (!root._fbq) root._fbq = n;
        n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
        var script = root.document.createElement('script'); script.async = true;
        script.src = 'https://connect.facebook.net/en_US/fbevents.js'; root.document.head.appendChild(script);
      }
  }
  function initialize(payload) {
    if (!allowed() || !root.AoBApplication.productionHost(root.location.hostname)) return false;
    if (!initialized) {
      ensureSdk();
      // This form has explicit submission/qualification events; do not infer
      // extra conversions from its buttons or page metadata.
      root.fbq('set', 'autoConfig', false, '713374525487066');
      // Use the dataset's already-connected Conversions API with Meta. Meta's
      // official pixel template signals this before init; no second sender/token.
      root.fbq('optinMetaEnabledCapi', '713374525487066');
      // Matching fields go in init, never in custom event data or a URL.
      root.fbq('init', '713374525487066', {
        em: String(payload.email || '').trim().toLowerCase(),
        ph: String(payload.phone || '').replace(/\D/g, ''),
        fn: String(payload.first_name || '').trim().toLowerCase(),
        ln: String(payload.last_name || '').trim().toLowerCase(),
        external_id: String(payload.ghl_contact_id || '')
      });
      initialized = true;
    }
    return true;
  }
  root.AoBMeta = { consent: function () { return allowed() ? 'granted' : status === 'granted' ? 'denied' : status; }, initialize: initialize };
})(window);
