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

function postOnce(payload) {
  return axios.post(FORMSPREE_URL, payload, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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

  const fields = payload && typeof payload === 'object' ? Object.keys(payload) : [];
  console.log(`[formspree] mirroring to ${FORMSPREE_URL} — ${fields.length} field(s): ${fields.join(', ')}`);

  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await postOnce(payload);
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
