const express = require('express');
const router = express.Router();
const db = require('../services/supabase');
const claude = require('../services/claude');
const twilio = require('../services/twilio');
const leadEngine = require('../services/leadEngine');

// Twilio signature enforcement on the two Twilio-called webhooks (no-op
// unless TWILIO_VALIDATE_WEBHOOK=true — see services/twilio.js). /noshow and
// /reactivate are n8n-called, not Twilio-called, so they are not gated here.
router.use(['/missed-call', '/inbound-sms'], (req, res, next) => {
  if (!twilio.validateWebhook(req)) {
    console.warn(`[twilio] rejected unsigned/forged webhook: ${req.originalUrl} from ${req.ip}`);
    res.set('Content-Type', 'text/xml');
    return res.status(403).send('<Response></Response>');
  }
  next();
});

// ── MISSED CALL WEBHOOK ────────────────────────────────────────
// Twilio calls this when a call is missed (no answer)
router.post('/missed-call', async (req, res) => {
  try {
    const { To, From, CallDuration } = req.body;
    console.log(`Missed call: ${From} → ${To}`);

    // Respond to Twilio immediately (required within 5 seconds)
    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>');

    // Process async
    setImmediate(async () => {
      try {
        // 1. Get clinic by their Twilio number
        const clinic = await db.getClinicByPhone(To);
        if (!clinic) return console.log(`No clinic found for ${To}`);

        // 2. Get or create contact
        const contact = await db.getOrCreateContact(clinic.id, From);

        // 3. Log the missed call
        await db.logMissedCall({
          clinic_id: clinic.id,
          contact_id: contact.id,
          caller_number: From,
          call_duration: parseInt(CallDuration) || 0,
          text_sent: false
        });

        // 4. Generate AI text-back message
        const message = await claude.generateMissedCallText(clinic, contact);

        // 5. Send SMS within 30 seconds
        await twilio.sendSMS(From, To, message);

        // 6. Create conversation and log message
        const conversation = await db.getOrCreateConversation(
          clinic.id, contact.id, 'missed_call'
        );

        await db.saveMessage({
          conversation_id: conversation.id,
          clinic_id: clinic.id,
          contact_id: contact.id,
          direction: 'outbound',
          body: message,
          ai_generated: true
        });

        console.log(`Text-back sent to ${From} for clinic ${clinic.name}`);
      } catch (err) {
        console.error('Missed call processing error:', err);
      }
    });

  } catch (err) {
    console.error('Missed call webhook error:', err);
    res.status(500).send('<Response></Response>');
  }
});

// ── INBOUND SMS WEBHOOK ────────────────────────────────────────
// Twilio calls this when a client sends a text
router.post('/inbound-sms', async (req, res) => {
  try {
    const { To, From, Body } = req.body;
    console.log(`Inbound SMS from ${From}: ${Body}`);

    // Respond to Twilio immediately
    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>');

    setImmediate(async () => {
      try {
        // 1. Get clinic
        const clinic = await db.getClinicByPhone(To);
        if (!clinic) return;

        // 2. Get or create contact
        const contact = await db.getOrCreateContact(clinic.id, From);

        // 2b. Lead-engine reply short-circuit: if this contact has pending
        // sequence touches, detect booking / opt-out and update the schedule.
        // (No-op when there are no pending touches; never throws.)
        await leadEngine.handleInboundReply({ clinic, contact, body: Body });

        // 3. Get or create conversation
        const conversation = await db.getOrCreateConversation(
          clinic.id, contact.id, 'inbound_sms'
        );

        // 4. Save incoming message
        await db.saveMessage({
          conversation_id: conversation.id,
          clinic_id: clinic.id,
          contact_id: contact.id,
          direction: 'inbound',
          body: Body,
          ai_generated: false
        });

        // 5. Get conversation history for context
        const history = await db.getConversationHistory(conversation.id, 8);

        // 6. Generate Claude AI response
        const aiResponse = await claude.generateResponse(
          clinic, contact, history, Body
        );

        // 7. Send response
        await twilio.sendSMS(From, To, aiResponse);

        // 8. Save outbound message
        await db.saveMessage({
          conversation_id: conversation.id,
          clinic_id: clinic.id,
          contact_id: contact.id,
          direction: 'outbound',
          body: aiResponse,
          ai_generated: true
        });

        console.log(`AI response sent to ${From}: ${aiResponse}`);
      } catch (err) {
        console.error('Inbound SMS processing error:', err);
      }
    });

  } catch (err) {
    console.error('Inbound SMS webhook error:', err);
    res.status(500).send('<Response></Response>');
  }
});

// ── NO-SHOW RECOVERY ───────────────────────────────────────────
// Called by n8n when an appointment is missed
router.post('/noshow', async (req, res) => {
  try {
    const { clinic_id, contact_id, appointment_date } = req.body;

    const { data: clinic } = await db.supabase
      .from('clinics').select('*').eq('id', clinic_id).single();
    const { data: contact } = await db.supabase
      .from('contacts').select('*').eq('id', contact_id).single();

    if (!clinic || !contact) {
      return res.status(404).json({ error: 'Clinic or contact not found' });
    }

    const message = await claude.generateNoShowText(
      clinic, contact, appointment_date
    );

    await twilio.sendSMS(
      contact.phone_number,
      clinic.phone_number,
      message
    );

    res.json({ success: true, message_sent: message });
  } catch (err) {
    console.error('No-show recovery error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── DORMANT REACTIVATION ───────────────────────────────────────
// Called by n8n on a schedule (every Monday)
router.post('/reactivate', async (req, res) => {
  try {
    const { clinic_id } = req.body;

    const { data: clinic } = await db.supabase
      .from('clinics').select('*').eq('id', clinic_id).single();

    if (!clinic) return res.status(404).json({ error: 'Clinic not found' });

    const dormantContacts = await db.getDormantContacts(clinic.id, 60);
    const results = [];

    for (const contact of dormantContacts) {
      try {
        const message = await claude.generateReactivationText(clinic, contact);
        await twilio.sendSMS(contact.phone_number, clinic.phone_number, message);
        results.push({ contact: contact.phone_number, sent: true, message });

        // Small delay between messages to avoid rate limiting
        await new Promise(r => setTimeout(r, 1000));
      } catch (err) {
        results.push({ contact: contact.phone_number, sent: false, error: err.message });
      }
    }

    res.json({ success: true, total_sent: results.filter(r => r.sent).length, results });
  } catch (err) {
    console.error('Reactivation error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
