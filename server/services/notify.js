const axios = require('axios');

// Formspree mirror — keeps the email copy of every intake submission.
// Strictly best-effort: a Formspree outage must never fail onboarding.
const FORMSPREE_URL = process.env.FORMSPREE_URL || 'https://formspree.io/f/mojgalqa';

async function mirrorToFormspree(payload) {
  if (String(process.env.FORMSPREE_MIRROR_ENABLED).toLowerCase() === 'false') {
    console.log('[notify] Formspree mirror disabled — skipping');
    return { skipped: true };
  }
  try {
    await axios.post(FORMSPREE_URL, payload, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      timeout: 8000
    });
    console.log('[notify] Formspree mirror sent');
    return { sent: true };
  } catch (err) {
    console.error('[notify] Formspree mirror failed (non-fatal):', err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = { mirrorToFormspree };
