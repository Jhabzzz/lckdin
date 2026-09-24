// ── LCKD—IN analytics wrapper ──────────────────────────────────────────────
// Single entry point for all product analytics. Wraps PostHog so the rest of
// the app never talks to a vendor SDK directly — swapping providers later
// means editing this file only.
//
// Hard rules enforced here, not just documented:
//   - Never throws. Every public function is wrapped in try/catch.
//   - Never blocks. No awaited calls on any app code path.
//   - Only sends events from the production hostnames (lckd-in.com /
//     www.lckd-in.com). Localhost and *.vercel.app previews no-op to
//     console.debug instead.
//   - Only allowlisted property keys with primitive values are ever sent —
//     anything else is silently dropped, not passed through.
//   - No PII, no user content, no raw error text ever leaves this file.
//
// See docs/analytics.md for the full event taxonomy and privacy rules.

(function (global) {
  'use strict';

  var POSTHOG_KEY = 'phc_mixTga5aQuvj5LA36FTfSUqJ7VyvRdA2yv4opN4yfTYE';
  var POSTHOG_HOST = 'https://us.i.posthog.com';

  var PROD_HOSTNAMES = ['lckd-in.com', 'www.lckd-in.com'];

  var ALLOWED_PROPS = {
    protocol_length: true,
    previous_length: true,
    new_length: true,
    current_day: true,
    day_number: true,
    score_bucket: true,
    rule_count: true,
    pivot_count: true,
    pivots_remaining: true,
    pivots_used_total: true,
    feature: true,
    device_type: true,
    referrer_category: true,
    error_category: true,
    cta_location: true,
    auth_method: true
  };

  var posthogReady = false;

  function isProduction() {
    try {
      return PROD_HOSTNAMES.indexOf(global.location.hostname) !== -1;
    } catch (e) {
      return false;
    }
  }

  function sanitizeProperties(props) {
    var out = {};
    if (!props || typeof props !== 'object') return out;
    for (var key in props) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
      if (!ALLOWED_PROPS[key]) continue;
      var v = props[key];
      if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        out[key] = v;
      }
    }
    return out;
  }

  function getDeviceType() {
    try {
      return global.matchMedia('(max-width: 768px)').matches ? 'mobile' : 'desktop';
    } catch (e) {
      return 'unknown';
    }
  }

  function getReferrerCategory() {
    try {
      var ref = document.referrer;
      if (!ref) return 'direct';
      var host = new URL(ref).hostname.replace(/^www\./, '');
      var search = ['google.', 'bing.', 'duckduckgo.', 'yahoo.'];
      var social = ['twitter.com', 'x.com', 'instagram.com', 'linkedin.com', 'facebook.com', 'tiktok.com', 't.co'];
      for (var i = 0; i < search.length; i++) if (host.indexOf(search[i]) !== -1) return 'search';
      for (var j = 0; j < social.length; j++) if (host.indexOf(social[j]) !== -1) return 'social';
      return 'other';
    } catch (e) {
      return 'other';
    }
  }

  function initPostHog() {
    if (!isProduction()) return;
    try {
      var assetHost = POSTHOG_HOST.replace('.i.posthog.com', '-assets.i.posthog.com');
      var script = document.createElement('script');
      script.async = true;
      script.src = assetHost + '/static/array.js';
      script.onload = function () {
        try {
          global.posthog.init(POSTHOG_KEY, {
            api_host: POSTHOG_HOST,
            autocapture: false,        // intentional events only — no click/form autocapture
            capture_pageview: true,    // powers PostHog's "Web Analytics" tab
            capture_pageleave: true,
            capture_performance: true, // Web Vitals autocapture
            disable_session_recording: true,
            persistence: 'localStorage', // avoid cookies; no consent banner needed
            loaded: function () {
              posthogReady = true;
            }
          });
        } catch (e) { /* analytics must never break the app */ }
      };
      script.onerror = function () { /* network/blocked — stay a no-op */ };
      document.head.appendChild(script);
    } catch (e) { /* analytics must never break the app */ }
  }

  function trackEvent(name, properties) {
    try {
      var safeProps = sanitizeProperties(properties);
      if (!isProduction()) {
        console.debug('[analytics:noop]', name, safeProps);
        return;
      }
      if (!posthogReady || !global.posthog || typeof global.posthog.capture !== 'function') return;
      global.posthog.capture(name, safeProps);
    } catch (e) { /* analytics must never break the app */ }
  }

  function identifyUser(userId) {
    try {
      if (!userId || !isProduction()) return;
      if (!posthogReady || !global.posthog || typeof global.posthog.identify !== 'function') return;
      global.posthog.identify(userId); // opaque Supabase UUID only — never email/name
    } catch (e) { /* analytics must never break the app */ }
  }

  function resetAnalyticsIdentity() {
    try {
      if (!isProduction()) return;
      if (!posthogReady || !global.posthog || typeof global.posthog.reset !== 'function') return;
      global.posthog.reset();
    } catch (e) { /* analytics must never break the app */ }
  }

  function trackError(category, source) {
    trackEvent('app_error', { error_category: category, feature: source });
  }

  // Global safety nets — report that *a* failure category occurred, never the
  // message/stack, which could incidentally contain user-entered content.
  global.addEventListener('error', function () {
    trackError('js_exception', 'window');
  });
  global.addEventListener('unhandledrejection', function () {
    trackError('unhandled_rejection', 'window');
  });

  global.LckdAnalytics = {
    trackEvent: trackEvent,
    identifyUser: identifyUser,
    resetAnalyticsIdentity: resetAnalyticsIdentity,
    trackError: trackError,
    getDeviceType: getDeviceType,
    getReferrerCategory: getReferrerCategory,
    isProduction: isProduction
  };

  // Direct globals too, so call sites read as plain trackEvent('x', {...})
  // rather than LckdAnalytics.trackEvent(...).
  global.trackEvent = trackEvent;
  global.identifyUser = identifyUser;
  global.resetAnalyticsIdentity = resetAnalyticsIdentity;

  initPostHog();
})(window);
