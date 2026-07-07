// Manual one-shot runner for the appointment job (reminders + no-show + waitlist timeouts).
// Usage: npm run job:appointments
require('dotenv').config();
const { runAppointmentJob } = require('./appointmentJob');

runAppointmentJob()
  .then(result => {
    console.log('[job:appointments] result:', result);
    process.exit(0);
  })
  .catch(err => {
    console.error('[job:appointments] fatal:', err);
    process.exit(1);
  });
