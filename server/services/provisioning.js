const axios = require('axios');
const db = require('./supabase');
const { buildSignatureHeaders } = require('./signing');

// Post-commit clinic provisioning. Runs OUTSIDE the clinic-creation
// transaction: every step is idempotent, failures never corrupt the clinic —
// they just keep provisioning_jobs 'pending' for the retry cron
// (jobs/provisioningRetry.js) with exponential backoff.

const MAX_ATTEMPTS = parseInt(process.env.PROVISIONING_MAX_ATTEMPTS, 10) || 8;

// ── Step 1: Twilio number ──────────────────────────────────────
// Feature-flagged (TWILIO_PROVISION_ENABLED, default false — account billing
// is still blocked). The actual number purchase lands in Phase 3; until then
// the twilio_number integration_task stays open and the number is attached
// manually (update clinics.phone_number + mark the task done).
async function ensureTwilioNumber(clinic) {
  const task = await db.findIntegrationTask(clinic.id, 'twilio_number');

  if (clinic.phone_number) {
    if (task && task.status !== 'done') {
      await db.updateIntegrationTask(task.id, { status: 'done' });
    }
    return { attached: true };
  }

  if (String(process.env.TWILIO_PROVISION_ENABLED).toLowerCase() !== 'true') {
    console.log(`[provisioning] TWILIO_PROVISION_ENABLED != true — twilio_number task stays pending for clinic ${clinic.id}`);
    return { attached: false, pending: 'flag_disabled' };
  }

  // Phase 3: IncomingPhoneNumbers.create + set voice/SMS webhook URLs.
  console.warn(`[provisioning] Twilio auto-provision not implemented yet (Phase 3) — twilio_number task stays pending for clinic ${clinic.id}`);
  return { attached: false, pending: 'not_implemented' };
}

// ── Step 2: notify n8n ─────────────────────────────────────────
// n8n's only job here is the internal "new clinic" notification (Slack/email)
// + later driving credential intake. Signed with HMAC + timestamp.
// No N8N_URL configured → skip-success (mock-mode convention).
async function notifyN8n(clinic) {
  if (!process.env.N8N_URL) {
    console.log('[provisioning] N8N_URL not set — skipping clinic-provisioned notify');
    return { skipped: true };
  }
  const payload = {
    clinic_id: clinic.id,
    slug: clinic.slug,
    name: clinic.name,
    booking_software: clinic.software,
    timezone: clinic.timezone,
    phone: clinic.phone_number,
    services: clinic.services,
    onboarding_status: clinic.onboarding_status
  };
  const bodyString = JSON.stringify(payload);
  await axios.post(`${process.env.N8N_URL}/webhook/clinic-provisioned`, bodyString, {
    headers: { 'Content-Type': 'application/json', ...buildSignatureHeaders(bodyString) },
    timeout: 10000
  });
  console.log(`[provisioning] n8n notified for clinic ${clinic.id}`);
  return { notified: true };
}

// ── Status recompute ───────────────────────────────────────────
// created → awaiting_number → awaiting_booking_integration → ready → live.
// 'ready' means: number attached AND no open credential task. Go-Live
// (explicit, guarded) is the only transition to 'live'.
async function recomputeOnboardingStatus(clinicId) {
  const clinic = await db.getClinicById(clinicId);
  if (!clinic || clinic.onboarding_status === 'live') return clinic && clinic.onboarding_status;

  let status;
  if (!clinic.phone_number) {
    status = 'awaiting_number';
  } else {
    const tasks = await db.getIntegrationTasks(clinicId);
    const bookingOpen = tasks.some(t => t.type === 'vagaro_connect' && t.status !== 'done');
    status = bookingOpen ? 'awaiting_booking_integration' : 'ready';
  }

  if (status !== clinic.onboarding_status) {
    await db.setClinicOnboardingStatus(clinicId, status);
    console.log(`[provisioning] clinic ${clinicId}: ${clinic.onboarding_status} → ${status}`);
  }
  return status;
}

// ── Job runner ─────────────────────────────────────────────────
async function processJob(job) {
  const clinic = await db.getClinicById(job.clinic_id);
  if (!clinic) {
    await db.updateProvisioningJob(job.id, { status: 'failed', last_error: 'clinic not found' });
    return;
  }

  try {
    await db.updateProvisioningJob(job.id, { status: 'running' });

    await ensureTwilioNumber(clinic);
    await notifyN8n(clinic);

    await db.updateProvisioningJob(job.id, {
      status: 'done',
      attempts: (job.attempts || 0) + 1,
      last_error: null
    });
    await db.updateClinic(clinic.id, { provisioned_at: new Date().toISOString() });
    await recomputeOnboardingStatus(clinic.id);
  } catch (err) {
    const attempts = (job.attempts || 0) + 1;
    // Axios HTTP errors can carry an empty .message — keep the status code.
    const errMsg = err.response
      ? `HTTP ${err.response.status} from ${err.config?.url || 'upstream'}`
      : (err.message || String(err));
    if (attempts >= MAX_ATTEMPTS) {
      await db.updateProvisioningJob(job.id, { status: 'failed', attempts, last_error: errMsg });
      await db.setClinicOnboardingStatus(job.clinic_id, 'provisioning_failed');
      console.error(`[provisioning] ALERT — job ${job.id} (clinic ${job.clinic_id}) FAILED permanently after ${attempts} attempts: ${errMsg}`);
    } else {
      // Exponential backoff: 10m, 20m, 40m, … capped at 12h.
      const delayMinutes = Math.min(5 * 2 ** attempts, 720);
      await db.updateProvisioningJob(job.id, {
        status: 'pending',
        attempts,
        last_error: errMsg,
        next_attempt_at: new Date(Date.now() + delayMinutes * 60 * 1000).toISOString()
      });
      console.warn(`[provisioning] job ${job.id} attempt ${attempts} failed (${errMsg}) — retry in ${delayMinutes}m`);
    }
  }
}

// Kick provisioning for a freshly created clinic (called post-commit by the
// onboarding orchestrator). Errors are swallowed — the retry cron is the net.
async function provisionClinic(clinicId) {
  try {
    const job = await db.getProvisioningJobByClinic(clinicId);
    if (job && job.status === 'pending') await processJob(job);
  } catch (err) {
    console.error(`[provisioning] immediate run failed for clinic ${clinicId} (retry cron will pick it up):`, err.message);
  }
}

module.exports = { processJob, provisionClinic, recomputeOnboardingStatus, ensureTwilioNumber, notifyN8n };
