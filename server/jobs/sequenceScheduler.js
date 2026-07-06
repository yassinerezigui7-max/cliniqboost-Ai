const db = require('../services/supabase');
const claude = require('../services/claude');
const leadEngine = require('../services/leadEngine');
const prompts = require('../../prompts/lead-engine-prompts');
const { isWithinQuietHours, nextSendTimeUtc } = require('../services/time');

const BATCH_SIZE = parseInt(process.env.SCHEDULER_BATCH_SIZE, 10) || 25;
const DAY_MS = 24 * 60 * 60 * 1000;
const VIP_STALE_DAYS = 7;

// Max touches + next-touch spacing per sequence.
const NURTURE_MAX = 5;
const REACTIVATION_MAX = 3;
const REACTIVATION_SPACING_DAYS = 5;

// Progressive backoff for new_lead_nurture: the NEXT touch after touch N fires
// in (N+1) days → touch2 +2d, touch3 +3d, touch4 +4d, touch5 +5d.
function nurtureNextDelayDays(currentTouch) {
  return currentTouch + 1;
}

// Process one due touch. Returns a short status string for logging.
async function processTouch(row) {
  const contact = await db.getContactById(row.contact_id);
  const clinic = await db.getClinicById(row.clinic_id);

  if (!contact || !clinic) {
    console.warn(`[sequences] touch ${row.id}: missing contact/clinic — skipping`);
    return 'skipped_missing';
  }

  // Opted-out contacts are excluded forever.
  if (contact.status === 'opted_out') {
    await db.updateTouchOutcome(row.id, 'opted_out');
    return 'opted_out';
  }

  // Inactive clinic → skip silently, leave row pending.
  if (!clinic.is_active) return 'skipped_inactive_clinic';

  // Quiet hours: never text outside 09:00–19:00 local. Push to next 09:00 local.
  if (!isWithinQuietHours(clinic.timezone)) {
    const next = nextSendTimeUtc(clinic.timezone);
    await db.rescheduleTouch(row.id, next);
    return `quiet_hours_rescheduled_to_${next}`;
  }

  // Generate the message with full context so touches never repeat.
  const history = await db.getRecentMessagesByContact(contact.id, 10);
  const systemPrompt = prompts.promptForTouch({
    clinic,
    contact,
    sequence_type: row.sequence_type,
    reminder_type: row.reminder_type,
    touch_number: row.touch_number
  }, { renewal_date: contact.renewal_date });

  const body = await claude.generateSequenceMessage({
    clinic,
    contact,
    systemPrompt,
    history,
    label: `${row.sequence_type}:${row.reminder_type || 't' + row.touch_number}`
  });

  // Send (mock-aware) + log to messages.
  await leadEngine.deliverMessage({
    clinic,
    contact,
    conversationId: null,
    body,
    aiGenerated: true
  });
  await db.markTouchSent(row.id, new Date().toISOString());

  // Advance the sequence.
  if (row.sequence_type === 'new_lead_nurture') {
    if (row.touch_number < NURTURE_MAX) {
      const scheduledAt = new Date(Date.now() + nurtureNextDelayDays(row.touch_number) * DAY_MS).toISOString();
      await db.insertTouch({
        clinicId: clinic.id,
        contactId: contact.id,
        sequenceType: 'new_lead_nurture',
        touchNumber: row.touch_number + 1,
        scheduledAt
      });
    } else {
      // Final nurture touch delivered, no reply → close out.
      await db.updateTouchOutcome(row.id, 'no_response');
    }
  } else if (row.sequence_type === 'reactivation') {
    if (row.touch_number < REACTIVATION_MAX) {
      const scheduledAt = new Date(Date.now() + REACTIVATION_SPACING_DAYS * DAY_MS).toISOString();
      await db.insertTouch({
        clinicId: clinic.id,
        contactId: contact.id,
        sequenceType: 'reactivation',
        touchNumber: row.touch_number + 1,
        scheduledAt
      });
    } else {
      await db.updateTouchOutcome(row.id, 'no_response');
    }
  }
  // vip_retention is single-shot: sent_at is set, outcome stays 'pending' until
  // Build 4 detection confirms 'renewed' or the stale cleanup marks 'no_response'.

  return 'sent';
}

// Cleanup: vip_retention rows sent > 7 days ago, still pending → 'no_response'.
async function cleanupStaleVipTouches() {
  const cutoff = new Date(Date.now() - VIP_STALE_DAYS * DAY_MS).toISOString();
  const stale = await db.getStaleVipTouches(cutoff);
  for (const row of stale) {
    try {
      await db.updateTouchOutcome(row.id, 'no_response');
    } catch (err) {
      console.error(`[sequences] cleanup failed for vip touch ${row.id}:`, err.message);
    }
  }
  return stale.length;
}

/**
 * Run one pass of the sequence scheduler. Each row is isolated in its own
 * try/catch so one failed send never aborts the batch.
 */
async function runSequenceJob() {
  const started = Date.now();
  let due = [];
  try {
    due = await db.getDueTouches(BATCH_SIZE);
  } catch (err) {
    console.error('[sequences] failed to fetch due touches:', err);
    return { error: err.message };
  }

  const stats = { due: due.length, sent: 0, rescheduled: 0, opted_out: 0, skipped: 0, failed: 0 };

  for (const row of due) {
    try {
      const result = await processTouch(row);
      if (result === 'sent') stats.sent++;
      else if (result.startsWith('quiet_hours')) stats.rescheduled++;
      else if (result === 'opted_out') stats.opted_out++;
      else stats.skipped++;
    } catch (err) {
      stats.failed++;
      console.error(`[sequences] touch ${row.id} (contact ${row.contact_id}) failed:`, err.message);
    }
  }

  let staleClosed = 0;
  try {
    staleClosed = await cleanupStaleVipTouches();
  } catch (err) {
    console.error('[sequences] stale VIP cleanup failed:', err.message);
  }

  const ms = Date.now() - started;
  console.log(`[sequences] run complete in ${ms}ms —`, { ...stats, staleVipClosed: staleClosed });
  return { ...stats, staleVipClosed: staleClosed };
}

module.exports = { runSequenceJob };
