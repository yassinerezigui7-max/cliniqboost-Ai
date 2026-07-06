const db = require('./supabase');
const claude = require('./claude');
const twilio = require('./twilio');
const prompts = require('../../prompts/lead-engine-prompts');

/**
 * Send an outbound message (mock-aware via twilio.sendSMS) and log it to
 * `messages`. Shared by the new-lead webhook and the sequence scheduler so
 * there is exactly ONE outbound-send + log path.
 */
async function deliverMessage({ clinic, contact, conversationId, body, aiGenerated = true }) {
  const result = await twilio.sendSMS(contact.phone_number, clinic.phone_number, body);
  await db.saveMessage({
    conversation_id: conversationId || null,
    clinic_id: clinic.id,
    contact_id: contact.id,
    direction: 'outbound',
    body,
    twilio_sid: result && result.sid ? result.sid : null,
    ai_generated: aiGenerated
  });
  return result;
}

/**
 * Inbound-SMS reply short-circuit. Called as ONE hook from the existing
 * inbound-SMS handler. If the contact has pending touch_schedule rows, classify
 * the inbound message and act:
 *   - BOOKED   → mark all pending touches 'booked'
 *   - OPT_OUT  → mark all pending touches 'opted_out' AND set contact status
 *                'opted_out' (schedulers exclude that status forever after)
 *   - NEITHER  → leave the schedule intact
 * Never throws — a failure here must not break the normal inbound AI reply.
 */
async function handleInboundReply({ clinic, contact, body }) {
  try {
    const pending = await db.getPendingTouchesForContact(contact.id);
    if (!pending.length) return { skipped: true };

    const history = await db.getRecentMessagesByContact(contact.id, 10);
    const intent = await claude.classifyInboundIntent({
      classifierPrompt: prompts.inboundClassifier(),
      history,
      message: body
    });

    if (intent === 'BOOKED') {
      const n = await db.setPendingTouchesOutcome(contact.id, 'booked');
      console.log(`[lead-engine] contact ${contact.id} BOOKED — closed ${n} pending touch(es)`);
    } else if (intent === 'OPT_OUT') {
      const n = await db.setPendingTouchesOutcome(contact.id, 'opted_out');
      await db.setContactStatus(contact.id, 'opted_out');
      console.log(`[lead-engine] contact ${contact.id} OPT_OUT — closed ${n} pending touch(es), status set opted_out`);
    }

    return { intent };
  } catch (err) {
    console.error('[lead-engine] handleInboundReply error:', err);
    return { error: err.message };
  }
}

module.exports = { deliverMessage, handleInboundReply };
