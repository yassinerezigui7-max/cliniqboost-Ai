// Manual one-shot runner for the VIP retention sweep.
// Usage: npm run job:vip-sweep
require('dotenv').config();
const { runVipSweep } = require('./vipSweep');

runVipSweep()
  .then(result => {
    console.log('[job:vip-sweep] result:', result);
    process.exit(0);
  })
  .catch(err => {
    console.error('[job:vip-sweep] fatal:', err);
    process.exit(1);
  });
