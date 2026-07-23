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
  // 0. Auth + tenant identity in ONE step. The per-clinic webhook secret
  // resolves to exactly one clinic; the clinic is NEVER taken from the request
  // body, so a caller can only create leads for the clinic whose secret it
  // holds. (A leaked shared secret can no longer target an arbitrary clinic_id.)
  const secret = req.headers['x-cliniqboost-secret'];
  const clinic = await db.getClinicByWebhookSecret(secret);
  if (!clinic) return res.status(401).json({ error: 'Unauthorized' });
  if (!clinic.is_active) return res.status(422).json({ error: 'clinic is not active' });

  try {
    const { source, name, phone, email, treatment_interest, clinic_id: bodyClinicId } = req.body || {};

    // Defense-in-depth: a legacy caller may still send clinic_id. It is not
    // trusted for identity, but if present it must match the secret's clinic.
    if (bodyClinicId && bodyClinicId !== clinic.id) {
      return res.status(409).json({ error: 'clinic_id does not match the authenticated clinic' });
    }

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
