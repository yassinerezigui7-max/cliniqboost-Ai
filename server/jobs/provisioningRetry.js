const db = require('../services/supabase');
const provisioning = require('../services/provisioning');

// Retry cron for provisioning_jobs: picks up due 'pending' jobs (backoff via
// attempts/next_attempt_at, set by services/provisioning.js) and re-runs
// them. Also rescues jobs stuck 'running' after a crash mid-provision.
async function runProvisioningRetry() {
  const rescued = await db.resetStaleRunningProvisioningJobs(30);
  if (rescued > 0) console.warn(`[provisioningRetry] reset ${rescued} stale running job(s) to pending`);

  const jobs = await db.getDueProvisioningJobs(10);
  if (jobs.length === 0) return;

  console.log(`[provisioningRetry] ${jobs.length} due job(s)`);
  for (const job of jobs) {
    await provisioning.processJob(job);
  }
}

module.exports = { runProvisioningRetry };
