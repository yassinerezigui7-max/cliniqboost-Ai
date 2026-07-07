const cron = require('node-cron');
const { runSequenceJob } = require('./sequenceScheduler');
const { runVipSweep } = require('./vipSweep');
const { runAppointmentJob } = require('./appointmentJob');

// Register in-process cron jobs. Guarded by SCHEDULER_ENABLED so Railway can
// disable the schedulers without a redeploy.
//
// NOTE: these run in-process. If the service is ever scaled to more than one
// instance, cron will fire on each instance — move to an external scheduler
// (or a leader-election guard) before scaling horizontally.
function registerCron() {
  if (String(process.env.SCHEDULER_ENABLED).toLowerCase() === 'false') {
    console.log('[jobs] SCHEDULER_ENABLED=false — cron NOT registered');
    return;
  }

  // Sequence scheduler (nurture + reactivation sends) — every 15 minutes.
  cron.schedule('*/15 * * * *', () => {
    runSequenceJob().catch(err => console.error('[jobs] sequence job error:', err));
  });

  // VIP retention sweep — daily at 10:00 server time.
  cron.schedule('0 10 * * *', () => {
    runVipSweep().catch(err => console.error('[jobs] vip sweep error:', err));
  });

  // Appointment reminders + no-show recovery + waitlist offer timeouts — every 15 min.
  cron.schedule('*/15 * * * *', () => {
    runAppointmentJob().catch(err => console.error('[jobs] appointment job error:', err));
  });

  console.log('[jobs] cron registered — sequences: */15 * * * * | vip-sweep: 0 10 * * * | appointments: */15 * * * *');
}

module.exports = { registerCron };
