const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../services/supabase');

// Login-gated dashboard API. The service key (server-side only) reads patient
// data; the browser never gets it. Auth is a shared password -> short-lived,
// stateless HMAC token. No new dependencies (uses Node crypto).

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function sign(expiry) {
  const secret = process.env.DASHBOARD_PASSWORD || '';
  return crypto.createHmac('sha256', secret).update(String(expiry)).digest('hex');
}

function makeToken() {
  const expiry = Date.now() + TOKEN_TTL_MS;
  return `${expiry}.${sign(expiry)}`;
}

// Constant-time string compare that never throws on length mismatch.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [expStr, mac] = token.split('.');
  const expiry = parseInt(expStr, 10);
  if (!expiry || Date.now() > expiry) return false;
  return safeEqual(mac, sign(expiry));
}

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── LOGIN ──────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  if (!process.env.DASHBOARD_PASSWORD) {
    return res.status(500).json({ error: 'DASHBOARD_PASSWORD is not configured on the server' });
  }
  const { password } = req.body || {};
  if (!password || !safeEqual(password, process.env.DASHBOARD_PASSWORD)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  return res.json({ token: makeToken(), expires_in_ms: TOKEN_TTL_MS });
});

// ── CLINICS (auth required) ────────────────────────────────────
// Populates the dashboard's clinic switcher.
router.get('/clinics', requireAuth, async (req, res) => {
  try {
    res.json({ clinics: await db.getClinicsList() });
  } catch (err) {
    console.error('Dashboard clinics error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── STATS (auth required) ──────────────────────────────────────
// Optional ?clinic_id=<uuid> scopes to one clinic. Missing or "all" =
// aggregated cross-clinic view. NOTE: clinic_id is a VIEW filter, not a
// security boundary — anyone with the dashboard password can query any clinic
// (intended for solo-operator use; see TESTING.md).
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const clinicId = req.query.clinic_id;
    const range = req.query.range; // 'today' | '7d' | '30d' (default today)
    const [stats, recent] = await Promise.all([
      db.getDashboardStats(clinicId, range),
      db.getRecentMessages(20, clinicId)
    ]);
    res.json({ ...stats, clinic_id: clinicId || 'all', recent_messages: recent });
  } catch (err) {
    console.error('Dashboard stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
