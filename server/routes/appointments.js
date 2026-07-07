const express = require('express');
const router = express.Router();
const db = require('../services/supabase');
const appointmentsSvc = require('../services/appointments');

// ── CANCELLATION → WAITLIST FILL ───────────────────────────────
// POST /webhooks/appointment-cancelled  (same shared-secret as new-lead)
// Body: { appointment_id }
// Typically called by the clinic's booking software / an n8n bridge when a
// staff member cancels an appointment, freeing the slot for the waitlist.
router.post('/appointment-cancelled', async (req, res) => {
  const secret = req.headers['x-cliniqboost-secret'];
  if (!process.env.NEW_LEAD_WEBHOOK_SECRET || secret !== process.env.NEW_LEAD_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { appointment_id } = req.body || {};
    if (!appointment_id) return res.status(422).json({ error: 'appointment_id is required' });

    const appointment = await db.getAppointmentById(appointment_id);
    if (!appointment) return res.status(404).json({ error: 'appointment not found' });

    // Mark cancelled, then try to fill the freed slot from the waitlist.
    await db.setAppointmentStatus(appointment.id, 'cancelled');
    const offer = await appointmentsSvc.offerSlotToWaitlist({ ...appointment, status: 'cancelled' });

    return res.status(200).json({ appointment_id: appointment.id, cancelled: true, offer });
  } catch (err) {
    console.error('Appointment-cancelled webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
