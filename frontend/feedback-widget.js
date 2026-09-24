// ── LCKD—IN feedback widget ─────────────────────────────────────────────────
// Small floating "Feedback" button + panel, injected on every page that loads
// this script. Writes straight into the `feedback` table in Supabase using
// the page's own `sb` client (declared inline on index.html / dashboard.html
// / profile.html) — no extra auth, no extra service.
//
// Hard rules enforced here, matching analytics.js:
//   - Never throws out to the host page. Every public path is try/catch'd.
//   - Waits for `window.load` before touching `sb`, since that client is
//     declared in a later inline <script> on the host page.
//   - Degrades to a no-op (button still shows, submit just reports an error)
//     if `sb` never shows up — the widget must never break the page around it.

(function (global) {
  'use strict';

  var STYLE_ID = 'fb-widget-styles';
  var MAX_LEN = 2000;
  var COOLDOWN_MS = 30000; // submit stays disabled this long after each send

  var css = [
    '.fb-fab{position:fixed;bottom:24px;left:24px;width:56px;height:56px;border-radius:50%;background:var(--text);color:var(--bg);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:var(--shadow-card);z-index:480;transition:transform .25s var(--ease),box-shadow .25s var(--ease)}',
    '.fb-fab:hover{transform:scale(1.06);box-shadow:var(--shadow-glow)}',
    '.fb-fab.open svg{transform:rotate(90deg)}',
    '.fb-fab svg{transition:transform .25s var(--ease)}',
    '@media(max-width:640px){.fb-fab{left:16px;bottom:88px}.fb-panel{left:12px;right:12px;width:auto;bottom:150px}}',
    '.fb-panel{position:fixed;bottom:92px;left:24px;width:340px;max-width:calc(100vw - 32px);max-height:min(480px,calc(100vh - 160px));background:var(--bg2);border:1px solid var(--glass-brd2);border-radius:var(--r-lg);box-shadow:var(--shadow-card);z-index:480;display:flex;flex-direction:column;overflow:hidden;opacity:0;transform:translateY(16px) scale(.98);pointer-events:none;transition:opacity .25s var(--ease),transform .25s var(--ease)}',
    '.fb-panel.open{opacity:1;transform:none;pointer-events:auto}',
    '.fb-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--line);flex-shrink:0}',
    '.fb-head b{font-family:var(--sans);font-size:14px;color:var(--text)}',
    '.fb-head span{display:block;font-family:var(--mono);font-size:11px;color:var(--text3);margin-top:2px}',
    '.fb-close{background:none;border:none;color:var(--text3);font-size:14px;cursor:pointer;line-height:1;padding:4px}',
    '.fb-close:hover{color:var(--text)}',
    '.fb-body{padding:14px 16px 16px;display:flex;flex-direction:column;gap:12px;overflow-y:auto}',
    '.fb-stars{display:flex;gap:6px}',
    '.fb-star{background:none;border:none;cursor:pointer;padding:2px;color:var(--line3);transition:color .15s var(--ease)}',
    '.fb-star.on{color:var(--lime)}',
    '.fb-textarea{width:100%;min-height:88px;resize:vertical;background:var(--bg3);border:1px solid var(--glass-brd2);border-radius:var(--r-sm);padding:10px 12px;font-family:var(--sans);font-size:13px;color:var(--text);outline:none;box-sizing:border-box}',
    '.fb-textarea:focus{border-color:var(--lime2)}',
    '.fb-textarea::placeholder{color:var(--text3)}',
    '.fb-submit{background:var(--grad);color:var(--on-accent);border:none;border-radius:var(--r-sm);padding:10px 14px;font-family:var(--sans);font-size:13px;font-weight:600;cursor:pointer;transition:transform .2s var(--ease),opacity .2s var(--ease)}',
    '.fb-submit:hover{transform:scale(1.02)}',
    '.fb-submit:disabled{opacity:.55;cursor:default;transform:none}',
    '.fb-msg{font-family:var(--sans);font-size:12px;color:var(--text3)}',
    '.fb-msg.err{color:var(--error)}',
    '.fb-msg.ok{color:var(--text)}'
  ].join('');

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var tag = document.createElement('style');
    tag.id = STYLE_ID;
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  function starIcon(filled) {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="' + (filled ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.63 22 9.24 16.5 14.14 18.18 21 12 17.27 5.82 21 7.5 14.14 2 9.24 8.91 8.63 12 2"/></svg>';
  }

  function buildDom() {
    var fab = document.createElement('button');
    fab.className = 'fb-fab';
    fab.id = 'fb-fab';
    fab.type = 'button';
    fab.setAttribute('aria-label', 'Send feedback');
    fab.setAttribute('aria-expanded', 'false');
    fab.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

    var panel = document.createElement('div');
    panel.className = 'fb-panel';
    panel.id = 'fb-panel';
    panel.innerHTML =
      '<div class="fb-head">' +
        '<div><b>Got feedback?</b><span>Bugs, UI/UX, ideas — anything</span></div>' +
        '<button class="fb-close" id="fb-close" type="button" aria-label="Close">✕</button>' +
      '</div>' +
      '<div class="fb-body">' +
        '<div class="fb-stars" id="fb-stars" role="radiogroup" aria-label="Rating (optional)">' +
          [1, 2, 3, 4, 5].map(function (n) {
            return '<button class="fb-star" type="button" data-val="' + n + '" role="radio" aria-checked="false" aria-label="' + n + ' star">' + starIcon(false) + '</button>';
          }).join('') +
        '</div>' +
        '<textarea class="fb-textarea" id="fb-text" maxlength="' + MAX_LEN + '" placeholder="What\'s working, what\'s not, what would make this better?"></textarea>' +
        // Honeypot: invisible to people and screen readers, but naive bots fill every field.
        '<input type="text" id="fb-website" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px">' +
          '<span class="fb-msg" id="fb-msg"></span>' +
          '<button class="fb-submit" id="fb-submit" type="button">Send</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(fab);
    document.body.appendChild(panel);
    return { fab: fab, panel: panel };
  }

  function getClient() {
    try {
      if (typeof sb !== 'undefined' && sb && sb.from) return sb;
    } catch (e) { /* sb not declared on this page */ }
    return null;
  }

  function wire(dom) {
    var rating = 0;
    var open = false;
    var stars = dom.panel.querySelectorAll('.fb-star');
    var textarea = dom.panel.querySelector('#fb-text');
    var submitBtn = dom.panel.querySelector('#fb-submit');
    var msgEl = dom.panel.querySelector('#fb-msg');
    var closeBtn = dom.panel.querySelector('#fb-close');
    var honeypot = dom.panel.querySelector('#fb-website');
    var sending = false;
    var cooldownUntil = 0;

    function setOpen(next) {
      open = next;
      dom.fab.classList.toggle('open', open);
      dom.fab.setAttribute('aria-expanded', String(open));
      dom.panel.classList.toggle('open', open);
      if (open) {
        try { textarea.focus(); } catch (e) {}
        try { global.trackEvent && global.trackEvent('feedback_opened', { feature: 'feedback' }); } catch (e) {}
      }
    }

    dom.fab.addEventListener('click', function () { setOpen(!open); });
    closeBtn.addEventListener('click', function () { setOpen(false); });

    for (var i = 0; i < stars.length; i++) {
      stars[i].addEventListener('click', function () {
        var val = parseInt(this.getAttribute('data-val'), 10);
        rating = (rating === val) ? 0 : val; // click same star again to clear
        for (var j = 0; j < stars.length; j++) {
          var v = parseInt(stars[j].getAttribute('data-val'), 10);
          var on = v <= rating;
          stars[j].classList.toggle('on', on);
          stars[j].setAttribute('aria-checked', String(v === rating));
          stars[j].innerHTML = starIcon(on);
        }
      });
    }

    function setMsg(text, kind) {
      msgEl.textContent = text || '';
      msgEl.className = 'fb-msg' + (kind ? ' ' + kind : '');
    }

    function resetForm() {
      rating = 0;
      textarea.value = '';
      for (var j = 0; j < stars.length; j++) {
        stars[j].classList.remove('on');
        stars[j].setAttribute('aria-checked', 'false');
        stars[j].innerHTML = starIcon(false);
      }
      setMsg('');
    }

    // Enforced here, not just via the disabled button, because Cmd/Ctrl+Enter
    // calls submit() directly.
    function startCooldown() {
      cooldownUntil = Date.now() + COOLDOWN_MS;
      submitBtn.disabled = true;
      setTimeout(function () {
        if (Date.now() >= cooldownUntil) submitBtn.disabled = false;
      }, COOLDOWN_MS);
    }

    function showSent() {
      setMsg('Thanks — got it.', 'ok');
      setTimeout(function () {
        resetForm();
        setOpen(false);
      }, 1400);
    }

    function isRateLimited(err) {
      return !!err && (err.code === 'PT429' || err.message === 'rate_limited');
    }

    async function submit() {
      if (sending) return;
      if (Date.now() < cooldownUntil) {
        setMsg('Just sent one — give it a few seconds.', 'err');
        return;
      }
      var message = (textarea.value || '').trim();
      if (!message) {
        setMsg('Say a little more first.', 'err');
        return;
      }
      if (message.length > MAX_LEN) {
        setMsg('Keep it under ' + MAX_LEN + ' characters.', 'err');
        return;
      }
      // Honeypot filled: act exactly like a real send, but never insert.
      if (honeypot && honeypot.value) {
        startCooldown();
        showSent();
        return;
      }
      var client = getClient();
      if (!client) {
        setMsg('Feedback is temporarily unavailable — try again shortly.', 'err');
        return;
      }

      sending = true;
      submitBtn.disabled = true;
      setMsg('Sending…');

      var userId = null;
      try {
        var res = await client.auth.getUser();
        userId = (res && res.data && res.data.user && res.data.user.id) || null;
      } catch (e) { /* anonymous submit is fine */ }

      try {
        var row = {
          message: message,
          rating: rating > 0 ? rating : null,
          user_id: userId,
          page: global.location ? global.location.pathname : null,
          user_agent: (navigator && navigator.userAgent) ? navigator.userAgent.slice(0, 300) : null
        };
        var result = await client.from('feedback').insert(row);
        if (result && result.error) throw result.error;

        startCooldown();
        showSent();
        try { global.trackEvent && global.trackEvent('feedback_submitted', { feature: 'feedback' }); } catch (e) {}
      } catch (e) {
        if (isRateLimited(e)) {
          startCooldown();
          setMsg('Slow down — try again in a few minutes.', 'err');
        } else {
          setMsg('Couldn’t send that — try again?', 'err');
        }
      } finally {
        sending = false;
        if (Date.now() >= cooldownUntil) submitBtn.disabled = false;
      }
    }

    submitBtn.addEventListener('click', submit);
    textarea.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
    });
  }

  function init() {
    try {
      injectStyles();
      var dom = buildDom();
      wire(dom);
    } catch (e) { /* feedback widget must never break the host page */ }
  }

  try {
    if (document.readyState === 'complete') {
      init();
    } else {
      global.addEventListener('load', init);
    }
  } catch (e) { /* no-op */ }
})(window);
