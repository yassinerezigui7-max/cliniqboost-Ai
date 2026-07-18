require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const twilioRoutes = require('./routes/twilio');
const healthRoutes = require('./routes/health');
const leadRoutes = require('./routes/leads');
const appointmentRoutes = require('./routes/appointments');
const dashboardApiRoutes = require('./routes/dashboard');
const onboardingRoutes = require('./routes/onboarding');
const internalRoutes = require('./routes/internal');
const { registerCron } = require('./jobs');

const app = express();
const PORT = process.env.PORT || 3000;

// Public onboarding — mounted BEFORE the permissive global cors()/json() so
// its own strict CORS allowlist and 64kb body cap actually apply.
app.use('/onboarding', onboardingRoutes);

// Middleware — rawBody is kept so signed internal webhooks can be
// HMAC-verified over the exact bytes received (services/signing.js).
app.use(cors());
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: false }));

// Routes
app.use('/webhook/twilio', twilioRoutes);
app.use('/webhooks', leadRoutes);
app.use('/webhooks', appointmentRoutes);
app.use(internalRoutes); // /internal/provision-callback + /health/provisioning
app.use('/health', healthRoutes);

// Dashboard — login-gated stats API (service key, server-side) + static page.
app.use('/dashboard-api', dashboardApiRoutes);
app.use('/dashboard', express.static(path.join(__dirname, '../dashboard')));

// Start
app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║   cliniqboost AI System               ║
  ║   Running on port ${PORT}                ║
  ║   Dashboard: http://localhost:${PORT}/dashboard  ║
  ╚═══════════════════════════════════════╝
  `);

  // Register background schedulers (guarded by SCHEDULER_ENABLED).
  registerCron();
});

module.exports = app;
