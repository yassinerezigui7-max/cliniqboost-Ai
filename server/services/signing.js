const crypto = require('crypto');

// HMAC + timestamp signing for internal webhooks (Railway ⇄ n8n), upgrading
// the bare x-cliniqboost-secret header: the signature stops body tampering,
// the timestamp stops replay. Shares NEW_LEAD_WEBHOOK_SECRET so n8n keeps a
// single hardcoded secret.
//
// Headers:
//   x-cliniqboost-secret     the shared secret (backward compatible)
//   x-cliniqboost-timestamp  unix seconds when the request was signed
//   x-cliniqboost-signature  hex HMAC-SHA256(secret, `${timestamp}.${body}`)
//
// Until every caller sends signatures, a valid bare secret is accepted unless
// INTERNAL_HMAC_REQUIRED=true.

const MAX_SKEW_SECONDS = 300;

function secret() {
  return process.env.NEW_LEAD_WEBHOOK_SECRET || '';
}

// Constant-time compare, length-guarded so timingSafeEqual never throws on a
// mismatched length. Avoids a timing side channel on the shared secret.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bb = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function sign(body, timestamp) {
  const raw = Buffer.isBuffer(body) ? body.toString('utf8')
    : typeof body === 'string' ? body
    : JSON.stringify(body || {});
  return crypto.createHmac('sha256', secret())
    .update(`${timestamp}.${raw}`)
    .digest('hex');
}

// Headers for an outbound signed request. Sign the exact string being sent.
function buildSignatureHeaders(bodyString) {
  const ts = Math.floor(Date.now() / 1000).toString();
  return {
    'x-cliniqboost-secret': secret(),
    'x-cliniqboost-timestamp': ts,
    'x-cliniqboost-signature': sign(bodyString, ts)
  };
}

// Verify an inbound internal request. Prefers req.rawBody (captured by the
// express.json verify hook) so the HMAC covers the exact bytes received.
function verifyRequest(req) {
  if (!secret()) return { ok: false, reason: 'server has no NEW_LEAD_WEBHOOK_SECRET configured' };
  if (!safeEqual(req.headers['x-cliniqboost-secret'], secret())) {
    return { ok: false, reason: 'bad secret' };
  }

  const ts = req.headers['x-cliniqboost-timestamp'];
  const sig = req.headers['x-cliniqboost-signature'];

  if (!ts || !sig) {
    if (String(process.env.INTERNAL_HMAC_REQUIRED).toLowerCase() === 'true') {
      return { ok: false, reason: 'signature required' };
    }
    return { ok: true, hmac: false }; // legacy bare-secret caller
  }

  if (Math.abs(Date.now() / 1000 - Number(ts)) > MAX_SKEW_SECONDS) {
    return { ok: false, reason: 'stale timestamp' };
  }

  const expected = sign(req.rawBody || req.body, ts);
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad signature' };
  }
  return { ok: true, hmac: true };
}

module.exports = { sign, buildSignatureHeaders, verifyRequest };
