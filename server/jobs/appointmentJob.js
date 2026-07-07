const db = require('../services/supabase');
const claude = require('../services/claude');
const leadEngine = require('../services/leadEngine');
const appointmentsSvc = require('../services/appointments');
const prompts = require('../../prompts/lead-engine-prompts');
const { isWithinQuietHours } = require('../services/time');

const WAITLIST_OFFER_WINDOW_MINUTES = parseInt(process.env.WAITLIST_OFFER_WINDOW_MINUTES, 10) || 60;

// Send one reminder/recovery message for an appointment (loads clinic + contact).
async function sendAppointmentMessage(appointment, promptFn, label) {
  const clinic = await db.getClinicById(appointment.clinic_id);
  const contact = await db.getContactById(appointment.contact_id);
  if (!clinic || !contact) return { ok: false, reason: 'missing_clinic_or_contact' };
  if (!clinic.is_active) return { ok: false, reason: 'clinic_inactive' };
  if (contact.status === 'opted_out') return { ok: false, reason: 'opted_out' };

  const systemPrompt = promptFn(clinic, contact, {
    service: appointment.service,
    appointment_date: appointment.appointment_date
  });
  const history = await db.getRecentMessagesByContact(contact.id, 10);
  const body = await claude.generateSequenceMessage({ clinic, contact, systemPrompt, history, label });

  await leadEngine.deliverMessage({
    clinic, contact,
    conversationId: appointment.conversation_id || null,
    body
  });
  return { ok: true, clinic };
}

// 5A.1 — 24h reminders (quiet-hours aware: skip out-of-window sends, retry next run).
async function run24hReminders(stats) {
  const due = await db.getDueReminders24h();
  for (const appt of due) {
    try {
      const clinic = await db.getClinicById(appt.clinic_id);
      if (!clinic || !clinic.is_active) { stats.skipped++; continue; }
      // Quiet hours apply to the 24h reminder — defer by skipping this cycle.
      if (!isWithinQuietHours(clinic.timezone)) { stats.deferred_quiet_hours++; continue; }

      const r = await sendAppointmentMessage(appt, prompts.appointmentReminder24h, 'appointment_reminder_24h');
      if (r.ok) { await db.markReminderSent(appt.id, 'reminder_sent_24h'); stats.reminded_24h++; }
      else stats.skipped++;
    } catch (err) {
      stats.failed++;
      console.error(`[appointments] 24h reminder failed for appt ${appt.id}:`, err.message);
    }
  }
}

// 5A.2 — 2h reminders (quiet hours do NOT apply: the appointment is imminent).
async function run2hReminders(stats) {
  const due = await db.getDueReminders2h();
  for (const appt of due) {
    try {
      const r = await sendAppointmentMessage(appt, prompts.appointmentReminder2h, 'appointment_reminder_2h');
      if (r.ok) { await db.markReminderSent(appt.id, 'reminder_sent_2h'); stats.reminded_2h++; }
      else stats.skipped++;
    } catch (err) {
      stats.failed++;
      console.error(`[appointments] 2h reminder failed for appt ${appt.id}:`, err.message);
    }
  }
}

// 5B — no-show detection + recovery (sent immediately; slot fill stays cancellation-only).
async function runNoShowRecovery(stats) {
  const due = await db.getNoShowCandidates();
  for (const appt of due) {
    try {
      // Mark no-show first so it drops out of the candidate query on future runs.
      await db.setAppointmentStatus(appt.id, 'noshow');
      const r = await sendAppointmentMessage(appt, prompts.noshowRecovery, 'noshow_recovery');
      if (r.ok) { await db.markNoShowRecoverySent(appt.id); stats.noshow_recovered++; }
      else { await db.markNoShowRecoverySent(appt.id); stats.noshow_skipped_send++; } // don't retry sends to opted-out/inactive
    } catch (err) {
      stats.failed++;
      console.error(`[appointments] no-show recovery failed for appt ${appt.id}:`, err.message);
    }
  }
}

// 5C.4 — expired waitlist offers: mark 'expired' and cascade the slot to the next match.
async function runWaitlistOfferTimeouts(stats) {
  const cutoff = new Date(Date.now() - WAITLIST_OFFER_WINDOW_MINUTES * 60 * 1000).toISOString();
  const expired = await db.getExpiredOfferedWaitlist(cutoff);
  for (const row of expired) {
    try {
      await db.updateWaitlist(row.id, { status: 'expired' });
      stats.offers_expired++;

      // Cascade: only if the freed slot is still open (appointment still cancelled).
      if (row.offered_appointment_id) {
        const appt = await db.getAppointmentById(row.offered_appointment_id);
        if (appt && appt.status === 'cancelled') {
          const result = await appointmentsSvc.offerSlotToWaitlist(appt);
          if (result.offered) stats.offers_cascaded++;
        }
      }
    } catch (err) {
      stats.failed++;
      console.error(`[appointments] waitlist timeout cascade failed for row ${row.id}:`, err.message);
    }
  }
}

/**
 * One pass of the appointment job: 24h + 2h reminders, no-show recovery, and
 * waitlist offer-timeout cascade. Each sub-step and each row is isolated so one
 * failure never aborts the batch.
 */
async function runAppointmentJob() {
  const started = Date.now();
  const stats = {
    reminded_24h: 0, deferred_quiet_hours: 0, reminded_2h: 0,
    noshow_recovered: 0, noshow_skipped_send: 0,
    offers_expired: 0, offers_cascaded: 0,
    skipped: 0, failed: 0
  };

  for (const step of [run24hReminders, run2hReminders, runNoShowRecovery, runWaitlistOfferTimeouts]) {
    try {
      await step(stats);
    } catch (err) {
      stats.failed++;
      console.error(`[appointments] step ${step.name} failed:`, err.message);
    }
  }

  console.log(`[appointments] run complete in ${Date.now() - started}ms —`, stats);
  return stats;
}

module.exports = { runAppointmentJob };
