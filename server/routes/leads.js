const express = require('express');
const router = express.Router();
const db = require('../services/supabase');
const claude = require('../services/claude');
const leadEngine = require('../services/leadEngine');
const prompts = require('../../prompts/lead-engine-prompts');
const { normalizePhone } = require('../services/phone');

const NURTURE_TOUCH1_DELAY_HOURS = parseInt(process.env.NURTURE_TOUCH1_DELAY_HOURS, 10) || 22;
const DEDUPE_WINDOW_MINUTES = 10;

// ── NEW-LEAD CAPTURE WEBHOOK ───────────────────────────────────
// POST /webhooks/new-lead
// Auth: shared-secret header x-cliniqboost-secret === NEW_LEAD_WEBHOOK_SECRET
router.post('/new-lead', async (req, res) => {
  // 0. Auth
  const secret = req.headers['x-cliniqboost-secret'];
  if (!process.env.NEW_LEAD_WEBHOOK_SECRET || secret !== process.env.NEW_LEAD_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { clinic_id, source, name, phone, email, treatment_interest } = req.body || {};

    // 1a. Validate clinic exists + active
    if (!clinic_id) return res.status(422).json({ error: 'clinic_id is required' });
    const clinic = await db.getClinicById(clinic_id);
    if (!clinic) return res.status(422).json({ error: 'clinic_id not found' });
    if (!clinic.is_active) return res.status(422).json({ error: 'clinic is not active' });

    // 1b. Validate + normalize phone to E.164 (infer region from clinic.country)
    if (!phone) return res.status(422).json({ error: 'phone is required' });
    const norm = normalizePhone(phone, clinic.country);
    if (!norm.valid || !norm.e164) {
      return res.status(422).json({ error: `phone could not be normalized to E.164 (reason: ${norm.reason || 'invalid'})` });
    }
    if (norm.ambiguous) {
      console.warn(`[new-lead] ambiguous phone normalization for clinic ${clinic_id}: "${phone}" -> ${norm.e164}`);
    }

    // 2. Upsert contact (never downgrade an existing client/vip)
    const { contact, isNew } = await db.upsertLeadContact({
      clinicId: clinic.id,
      phone: norm.e164,
      name,
      email
    });

    // 3. Idempotency: a 'new_lead' conversation created in the last 10 min => dedupe
    const recent = await db.findRecentConversation(clinic.id, contact.id, 'new_lead', DEDUPE_WINDOW_MINUTES);
    if (recent) {
      return res.status(200).json({ deduped: true, contact_id: contact.id, conversation_id: recent.id });
    }

    // 4. Create conversation (trigger_type 'new_lead')
    const conversation = await db.createConversation({
      clinicId: clinic.id,
      contactId: contact.id,
      triggerType: 'new_lead'
    });

    // 5-6. Generate first message with Claude + send (mock-aware) + log
    const systemPrompt = prompts.newLeadQualification(clinic, contact, { treatment_interest });
    const firstMessage = await claude.generateSequenceMessage({
      clinic,
      contact,
      systemPrompt,
      history: [],
      label: 'new_lead_qualification'
    });
    await leadEngine.deliverMessage({
      clinic,
      contact,
      conversationId: conversation.id,
      body: firstMessage,
      aiGenerated: true
    });

    // 7. Schedule nurture touch 1
    const scheduledAt = new Date(Date.now() + NURTURE_TOUCH1_DELAY_HOURS * 60 * 60 * 1000).toISOString();
    await db.insertTouch({
      clinicId: clinic.id,
      contactId: contact.id,
      sequenceType: 'new_lead_nurture',
      touchNumber: 1,
      scheduledAt
    });

    // 8. Respond
    return res.status(200).json({
      contact_id: contact.id,
      conversation_id: conversation.id,
      is_new_contact: isNew,
      source: source || null
    });
  } catch (err) {
    console.error('New-lead webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
