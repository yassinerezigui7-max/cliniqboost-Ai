const express = require('express');
const router = express.Router();
const db = require('../services/supabase');
const appointmentsSvc = require('../services/appointments');
const { verifyRequest } = require('../services/signing');

// ── CANCELLATION → WAITLIST FILL ───────────────────────────────
// POST /webhooks/appointment-cancelled  (same shared-secret as new-lead)
// Body: { appointment_id }
// Typically called by the clinic's booking software / an n8n bridge when a
// staff member cancels an appointment, freeing the slot for the waitlist.
router.post('/appointment-cancelled', async (req, res) => {
  // Auth via verifyRequest (shared secret + optional HMAC, constant-time). This
  // route is already tenant-safe: the clinic is derived from the stored
  // appointment below, never from the request body — so it stays on the shared
  // secret (scoped M2 fix leaves it here; full per-clinic is blocked on V).
  const auth = verifyRequest(req);
  if (!auth.ok) return res.status(401).json({ error: `Unauthorized: ${auth.reason}` });

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
