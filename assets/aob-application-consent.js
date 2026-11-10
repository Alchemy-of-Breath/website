// Parent WordPress page only. Read the installed WPConsent decision and send it
// only to this application's exact iframe. Never infer consent from URL tags.
(function () {
  'use strict';
  var childOrigin = 'https://website-5h3.pages.dev';
  function start() {
    var frame = document.getElementById('aob-fa-frame');
    if (!frame || ['https://alchemyofbreath.com', 'https://www.alchemyofbreath.com'].indexOf(location.origin) === -1) return;
    function publish() {
      var status = 'unknown';
      try {
        var consent = window.WPConsent;
        var prefs = consent && consent.lastPreferences;
        if (!prefs && consent && typeof consent.getCookie === 'function') {
          prefs = JSON.parse(consent.getCookie('wpconsent_preferences') || 'null');
        }
        if (prefs && typeof consent.shouldUnlockContent === 'function') {
          status = consent.shouldUnlockContent(prefs, 'facebook-pixel', 'marketing') === true ? 'granted' : 'denied';
        }
        if (navigator.globalPrivacyControl === true) status = 'denied';
        if (new URL(frame.src).origin !== childOrigin) return;
        frame.contentWindow.postMessage({ type: 'aob:application:consent', status: status }, childOrigin);
      } catch (e) { /* Missing or unreadable consent remains unknown. */ }
    }
    window.addEventListener('message', function (event) {
      if (event.origin === childOrigin && event.source === frame.contentWindow && event.data && event.data.type === 'aob:application:consent-request') publish();
    });
    frame.addEventListener('load', publish);
    window.addEventListener('wpconsent_consent_saved', publish);
    window.addEventListener('wpconsent_consent_updated', publish);
    document.addEventListener('wpconsent_consent_processed', publish);
    if (window.WPConsent && typeof window.WPConsent.registerListener === 'function') window.WPConsent.registerListener(publish);
    publish();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
