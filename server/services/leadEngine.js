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

// Simple affirmative detection for "reply YES to confirm / claim" replies.
// Deterministic + free (no extra Claude call) since reminders explicitly ask for YES.
function isAffirmative(body) {
  if (!body) return false;
  return /^\s*(y|yes+|yep|yeah|yup|ya|sure|ok(ay)?|confirm(ed)?|book( me)?( in)?|claim( it)?|i'?ll be there|see you|sounds good|great|perfect|deal|👍|✅)\b/i
    .test(String(body).trim());
}

/**
 * Inbound-SMS reply short-circuit. Called as ONE hook from the existing
 * inbound-SMS handler. Two additive concerns, each isolated:
 *
 * (a) Sequence touches (Sub-system 2) — if the contact has pending touch_schedule
 *     rows, classify BOOKED / OPT_OUT / NEITHER and update the schedule.
 * (b) Appointment / waitlist confirmations (Sub-system 5) — an affirmative reply
 *     claims an outstanding waitlist offer ('booked') and/or confirms a reminded
 *     appointment ('confirmed').
 *
 * Never throws — a failure here must not break the normal inbound AI reply.
 */
async function handleInboundReply({ clinic, contact, body }) {
  const result = {};

  // (a) Sequence touch handling — behavior unchanged from Sub-system 2.
  try {
    const pending = await db.getPendingTouchesForContact(contact.id);
    if (pending.length) {
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
      result.intent = intent;
    } else {
      result.touchSkipped = true;
    }
  } catch (err) {
    console.error('[lead-engine] touch handling error:', err);
    result.touchError = err.message;
  }

  // (b) Appointment confirmation + waitlist claim (Sub-system 5).
  try {
    if (isAffirmative(body)) {
      const offered = await db.getOfferedWaitlistByContact(contact.id);
      if (offered) {
        await db.updateWaitlist(offered.id, { status: 'booked' });
        result.waitlist_claimed = offered.id;
        console.log(`[appointments] contact ${contact.id} claimed waitlist offer ${offered.id}`);
      }
      const appt = await db.getConfirmableAppointmentByContact(contact.id);
      if (appt) {
        await db.setAppointmentStatus(appt.id, 'confirmed');
        result.appointment_confirmed = appt.id;
        console.log(`[appointments] contact ${contact.id} confirmed appointment ${appt.id}`);
      }
    }
  } catch (err) {
    console.error('[appointments] confirmation handling error:', err);
    result.confirmationError = err.message;
  }

  return result;
}

module.exports = { deliverMessage, handleInboundReply, isAffirmative };
