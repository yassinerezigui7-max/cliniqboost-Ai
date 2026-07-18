const db = require('./supabase');
const notify = require('./notify');
const provisioning = require('./provisioning');

const NEXT_STEPS = [
  'Connect booking software',
  'Upload patient data',
  'Upload knowledge base',
  'Go Live'
];

/**
 * Orchestrate one onboarding submission. Assumes the payload has already
 * passed services/validation.js.
 *
 * Clinic birth is the single create_clinic_onboarding RPC transaction —
 * all-or-nothing, idempotent on email. Everything after the RPC (Formspree
 * mirror now; Twilio/n8n provisioning in Phase 2+) is post-commit,
 * best-effort or retried, and can never leave a half-created clinic.
 */
async function submitOnboarding(clean) {
  const result = await db.createClinicOnboarding(clean);

  if (!result.existing) {
    // Mirror the raw form body to Formspree (email copy). Fire-and-forget.
    notify.mirrorToFormspree(clean.raw || clean);
    // Kick async provisioning post-commit (respond to the user immediately).
    // Any failure is retried by jobs/provisioningRetry.js.
    setImmediate(() => provisioning.provisionClinic(result.clinic_id));
  }

  return {
    clinic_id: result.clinic_id,
    slug: result.slug,
    onboarding_status: result.onboarding_status,
    existing: !!result.existing,
    next_steps: NEXT_STEPS
  };
}

module.exports = { submitOnboarding, NEXT_STEPS };
