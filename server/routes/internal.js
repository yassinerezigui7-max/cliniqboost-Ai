const express = require('express');
const router = express.Router();
const db = require('../services/supabase');
const { verifyRequest } = require('../services/signing');
const provisioning = require('../services/provisioning');

// ── PROVISION CALLBACK ─────────────────────────────────────────
// POST /internal/provision-callback
// n8n (or an operator script) reports a provisioning result. Auth: shared
// secret + optional HMAC/timestamp (see services/signing.js). Idempotent —
// re-reporting a done job is a no-op.
// Body: { clinic_id, status: 'done' | 'failed', error? }
router.post('/internal/provision-callback', async (req, res) => {
  const auth = verifyRequest(req);
  if (!auth.ok) return res.status(401).json({ error: `Unauthorized: ${auth.reason}` });

  try {
    const { clinic_id, status, error } = req.body || {};
    if (!clinic_id) return res.status(422).json({ error: 'clinic_id is required' });
    if (!['done', 'failed'].includes(status)) {
      return res.status(422).json({ error: "status must be 'done' or 'failed'" });
    }

    const job = await db.getProvisioningJobByClinic(clinic_id);
    if (!job) return res.status(404).json({ error: 'no provisioning job for that clinic' });

    if (status === 'done') {
      await db.updateProvisioningJob(job.id, { status: 'done', last_error: null });
      const onboardingStatus = await provisioning.recomputeOnboardingStatus(clinic_id);
      return res.status(200).json({ job_id: job.id, status: 'done', onboarding_status: onboardingStatus });
    }

    await db.updateProvisioningJob(job.id, { status: 'failed', last_error: error || 'reported failed via callback' });
    console.error(`[internal] provisioning reported FAILED for clinic ${clinic_id}: ${error || '(no reason)'}`);
    return res.status(200).json({ job_id: job.id, status: 'failed' });
  } catch (err) {
    console.error('Provision-callback error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── PROVISIONING HEALTH ────────────────────────────────────────
// GET /health/provisioning — job counts by status; degraded if anything
// failed or a pending job is stuck past its next attempt by > 30 min.
router.get('/health/provisioning', async (req, res) => {
  try {
    const jobs = await db.getProvisioningSummary();
    const stuckCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { count: stuck } = await db.supabase
      .from('provisioning_jobs')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending')
      .lte('next_attempt_at', stuckCutoff);

    const degraded = (jobs.failed || 0) > 0 || (stuck || 0) > 0;
    return res.status(200).json({
      status: degraded ? 'degraded' : 'ok',
      jobs,
      stuck_pending: stuck || 0
    });
  } catch (err) {
    return res.status(500).json({ status: 'error', error: err.message });
  }
});

// ── ACTIVE CLINICS (id list) ───────────────────────────────────
// GET /internal/active-clinics
// Minimal { clinics: [{ id }] } for n8n orchestration (e.g. the dormant
// reactivation workflow fans out one /reactivate call per clinic). Reads
// server-side via the service key, so n8n never needs an RLS-bypass key of its
// own — the tenant tables stay RLS-locked to everything outside the backend.
// Auth: shared secret + optional HMAC/timestamp (services/signing.js).
router.get('/internal/active-clinics', async (req, res) => {
  const auth = verifyRequest(req);
  if (!auth.ok) return res.status(401).json({ error: `Unauthorized: ${auth.reason}` });

  try {
    const clinics = await db.getActiveClinics();
    return res.status(200).json({ clinics: clinics.map((c) => ({ id: c.id })) });
  } catch (err) {
    console.error('Active-clinics error:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
