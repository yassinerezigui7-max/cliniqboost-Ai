// Manual one-shot runner for the sequence scheduler (nurture + reactivation).
// Usage: npm run job:sequences
require('dotenv').config();
const { runSequenceJob } = require('./sequenceScheduler');

runSequenceJob()
  .then(result => {
    console.log('[job:sequences] result:', result);
    process.exit(0);
  })
  .catch(err => {
    console.error('[job:sequences] fatal:', err);
    process.exit(1);
  });
