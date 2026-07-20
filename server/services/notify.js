const axios = require('axios');

// Formspree mirror — keeps the email copy of every intake submission.
// STRICTLY best-effort: a Formspree outage must never fail onboarding.
//
// NOTE: FORMSPREE_URL must be set (on Railway) to the clinic's real Formspree
// form, and that form must be confirmed in Formspree or it won't forward the
// notification email. The default below is only a fallback.
const FORMSPREE_URL = process.env.FORMSPREE_URL || 'https://formspree.io/f/mojgalqa';
const TIMEOUT_MS = 10000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

// Anti-abuse / plumbing fields consumed by the onboarding route — never part of
// a real form submission, so we don't forward them to Formspree.
const INTERNAL_FIELDS = new Set([
  'website_url', '_gotcha', 'turnstile_token', 'cf-turnstile-response', 'idempotency_key'
]);

// Encode the payload EXACTLY as an HTML <form> POST does:
// application/x-www-form-urlencoded, flat key=value pairs. A JSON body returns
// {ok:true} but Formspree does not always process it as a real submission
// (nothing lands in the dashboard, no email) — form-encoding is what the
// browser sends, so it's stored + emailed like a genuine submission.
function toFormBody(payload) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(payload || {})) {
    if (INTERNAL_FIELDS.has(k) || v == null) continue;
    params.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return params;
}

// `form` is a URLSearchParams built by toFormBody().
function postOnce(form) {
  return axios.post(FORMSPREE_URL, form.toString(), {
    // Browser form encoding + Accept:json so Formspree returns JSON (which we log)
    // instead of a 302 redirect. This is Formspree's documented AJAX pattern.
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    timeout: TIMEOUT_MS,
    // Inspect non-2xx ourselves so we can log Formspree's response body (which
    // explains failures) instead of a generic "status code 4xx" message.
    validateStatus: () => true
  });
}

async function mirrorToFormspree(payload) {
  if (String(process.env.FORMSPREE_MIRROR_ENABLED).toLowerCase() === 'false') {
    console.log('[formspree] mirror disabled (FORMSPREE_MIRROR_ENABLED=false) — skipping');
    return { skipped: true };
  }

  const form = toFormBody(payload);
  const fields = [...form.keys()];
  console.log(`[formspree] mirroring (form-urlencoded) to ${FORMSPREE_URL} — ${fields.length} field(s): ${fields.join(', ')}`);

  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await postOnce(form);
      const ok2xx = res.status >= 200 && res.status < 300;
      const bodyRejected = res.data && res.data.ok === false; // Formspree rejection: {ok:false, errors:[...]}
      if (ok2xx && !bodyRejected) {
        console.log(`[formspree] mirror OK — status ${res.status}, body ${JSON.stringify(res.data)}`);
        return { sent: true, status: res.status };
      }
      // Got an HTTP response but it's a rejection — log exactly what Formspree said.
      console.error(`[formspree] mirror REJECTED — status ${res.status}, body ${JSON.stringify(res.data)}`);
      last = { status: res.status, body: res.data };
      if (!RETRYABLE_STATUS.has(res.status)) break; // 4xx (bad form id / validation) won't fix on retry
    } catch (err) {
      // No HTTP response at all: timeout, DNS, connection refused, etc.
      console.error(`[formspree] mirror ERROR (attempt ${attempt}/2) — ${err.code || ''} ${err.message}`);
      last = { error: err.message, code: err.code || null };
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
  }

  // Final failure — log the reason AND the payload so it can be replayed/diagnosed.
  // Non-fatal: onboarding already succeeded; only the email copy is lost.
  console.error(
    '[formspree] mirror FAILED (non-fatal, clinic already created):',
    JSON.stringify(last),
    '| payload:', JSON.stringify(payload)
  );
  return { sent: false, ...last };
}

module.exports = { mirrorToFormspree };
