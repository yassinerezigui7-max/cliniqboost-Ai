const express = require('express');
const cors = require('cors');
const axios = require('axios');
const router = express.Router();
const { validateOnboarding } = require('../services/validation');
const onboardingSvc = require('../services/onboarding');
const db = require('../services/supabase');
const { verifyRequest } = require('../services/signing');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Public-endpoint hardening ──────────────────────────────────
// /onboarding/submit is the only public write endpoint in the system, so it
// gets the full stack: CORS allowlist, body-size cap, per-IP rate limit,
// honeypot, and Cloudflare Turnstile verification.

// CORS allowlist (overrides the permissive global cors() for these routes).
const ALLOWED_ORIGINS = (process.env.ONBOARDING_CORS_ORIGINS ||
  'https://cliniqboost.com,https://www.cliniqboost.com,http://localhost:3000,http://localhost:8888'
).split(',').map(o => o.trim()).filter(Boolean);

router.use(cors({
  origin(origin, cb) {
    // Non-browser callers (curl, server-to-server) send no Origin — allow.
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false); // no CORS headers → browser blocks the response
  }
}));

// Body parsing with a hard size cap. This router is mounted before the
// global express.json() precisely so this limit is the one that applies —
// oversize bodies get a 413 from the parser before any handler runs.
// rawBody is kept so signed internal calls (go-live) can be HMAC-verified
// over the exact bytes received.
router.use(express.json({
  limit: '64kb',
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

// Per-IP rate limit: sliding window, in-memory. Fine for a single instance;
// swap for a shared store before scaling horizontally (same caveat as cron).
const RATE_LIMIT_MAX = parseInt(process.env.ONBOARDING_RATE_LIMIT_MAX, 10) || 10;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const rateBuckets = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const hits = (rateBuckets.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (hits.length >= RATE_LIMIT_MAX) return true;
  hits.push(now);
  rateBuckets.set(ip, hits);
  // Opportunistic cleanup so the map can't grow unbounded.
  if (rateBuckets.size > 10000) {
    for (const [k, v] of rateBuckets) {
      if (v.every(t => now - t >= RATE_LIMIT_WINDOW_MS)) rateBuckets.delete(k);
    }
  }
  return false;
}

// Cloudflare Turnstile. Not configured (no secret) → skip with a log, so the
// endpoint works before the frontend ships the widget.
async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.log('[onboarding] TURNSTILE_SECRET_KEY not set — skipping Turnstile check');
    return { ok: true, skipped: true };
  }
  if (!token) return { ok: false, reason: 'missing token' };
  try {
    const { data } = await axios.post(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      new URLSearchParams({ secret, response: token, remoteip: ip || '' }),
      { timeout: 8000 }
    );
    return data.success ? { ok: true } : { ok: false, reason: (data['error-codes'] || []).join(',') };
  } catch (err) {
    console.error('[onboarding] Turnstile verify error:', err.message);
    return { ok: false, reason: 'verification unavailable' };
  }
}

// ── SUBMIT ─────────────────────────────────────────────────────
// POST /onboarding/submit
// Creates the clinic + all default records in one RPC transaction.
// Idempotent on email: resubmitting returns the existing clinic_id.
router.post('/submit', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;

    if (rateLimited(ip)) {
      return res.status(429).json({ error: 'too many requests — try again later' });
    }

    const body = req.body || {};

    // Honeypot: hidden fields humans never fill. Pretend success so bots
    // don't learn they were caught; write nothing.
    if ((body.website_url && String(body.website_url).trim()) ||
        (body._gotcha && String(body._gotcha).trim())) {
      console.warn(`[onboarding] honeypot tripped from ${ip} — dropping submission`);
      return res.status(200).json({ ok: true });
    }

    const turnstile = await verifyTurnstile(
      body.turnstile_token || body['cf-turnstile-response'], ip
    );
    if (!turnstile.ok) {
      return res.status(403).json({ error: `verification failed: ${turnstile.reason}` });
    }

    const { ok, errors, clean } = validateOnboarding(body);
    if (!ok) return res.status(422).json({ errors });

    const result = await onboardingSvc.submitOnboarding(clean);
    return res.status(200).json(result);
  } catch (err) {
    console.error('Onboarding submit error:', err);
    return res.status(500).json({ error: 'onboarding failed — nothing was created, safe to retry' });
  }
});

// ── STATUS ─────────────────────────────────────────────────────
// GET /onboarding/status/:clinicId — frontend progress polling. Public: the
// clinic_id is an opaque UUID handed out by /submit, and the response only
// exposes onboarding progress, never contacts or messages.
router.get('/status/:clinicId', async (req, res) => {
  try {
    const { clinicId } = req.params;
    if (!UUID_RE.test(clinicId)) return res.status(400).json({ error: 'invalid clinic id' });

    const clinic = await db.getClinicById(clinicId);
    if (!clinic) return res.status(404).json({ error: 'not found' });

    const [tasks, job] = await Promise.all([
      db.getIntegrationTasks(clinicId),
      db.getProvisioningJobByClinic(clinicId)
    ]);

    return res.status(200).json({
      clinic_id: clinic.id,
      slug: clinic.slug,
      onboarding_status: clinic.onboarding_status,
      is_live: !!clinic.is_active,
      phone_number_attached: !!clinic.phone_number,
      tasks: tasks.map(t => ({ type: t.type, status: t.status })),
      provisioning: job ? { status: job.status, attempts: job.attempts } : null,
      next_steps: onboardingSvc.NEXT_STEPS
    });
  } catch (err) {
    console.error('Onboarding status error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GO-LIVE ────────────────────────────────────────────────────
// POST /onboarding/:clinicId/go-live — the explicit, guarded flip of
// is_active=true. Internal auth (shared secret + optional HMAC). Requires
// onboarding_status='ready' so a half-provisioned clinic can never start
// routing calls or texting patients.
router.post('/:clinicId/go-live', async (req, res) => {
  const auth = verifyRequest(req);
  if (!auth.ok) return res.status(401).json({ error: `Unauthorized: ${auth.reason}` });

  try {
    const { clinicId } = req.params;
    if (!UUID_RE.test(clinicId)) return res.status(400).json({ error: 'invalid clinic id' });

    const clinic = await db.getClinicById(clinicId);
    if (!clinic) return res.status(404).json({ error: 'not found' });
    if (clinic.is_active && clinic.onboarding_status === 'live') {
      return res.status(200).json({ clinic_id: clinic.id, already_live: true });
    }
    if (clinic.onboarding_status !== 'ready') {
      return res.status(409).json({
        error: `clinic is '${clinic.onboarding_status}', not 'ready' — cannot go live`,
        onboarding_status: clinic.onboarding_status
      });
    }

    await db.updateClinic(clinicId, { is_active: true, onboarding_status: 'live' });
    console.log(`[onboarding] clinic ${clinicId} (${clinic.slug}) is LIVE`);
    return res.status(200).json({ clinic_id: clinicId, slug: clinic.slug, live: true });
  } catch (err) {
    console.error('Go-live error:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
