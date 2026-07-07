require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const twilioRoutes = require('./routes/twilio');
const healthRoutes = require('./routes/health');
const leadRoutes = require('./routes/leads');
const appointmentRoutes = require('./routes/appointments');
const { registerCron } = require('./jobs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Routes
app.use('/webhook/twilio', twilioRoutes);
app.use('/webhooks', leadRoutes);
app.use('/webhooks', appointmentRoutes);
app.use('/health', healthRoutes);

// Dashboard
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
