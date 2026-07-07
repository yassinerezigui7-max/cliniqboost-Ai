const db = require('./supabase');
const claude = require('./claude');
const leadEngine = require('./leadEngine');
const prompts = require('../../prompts/lead-engine-prompts');

const WAITLIST_OFFER_WINDOW_MINUTES = parseInt(process.env.WAITLIST_OFFER_WINDOW_MINUTES, 10) || 60;

// Service match: null on either side = wildcard (match-any).
function serviceMatches(waitService, apptService) {
  if (!waitService || !apptService) return true;
  return String(waitService).trim().toLowerCase() === String(apptService).trim().toLowerCase();
}

// Does the appointment date fall within [start, end]? Null bound = open on that side.
function dateInRange(appointmentDate, startDate, endDate) {
  if (!appointmentDate) return true;
  const when = new Date(appointmentDate);
  if (startDate && when < new Date(`${startDate}T00:00:00Z`)) return false;
  if (endDate && when > new Date(`${endDate}T23:59:59Z`)) return false;
  return true;
}

/**
 * Offer a freed slot to the best-matching waitlist entry (first-come-first-served),
 * skipping opted-out contacts. Sends the offer (mock-aware) and marks the row 'offered'.
 * Returns { offered: bool, ... }.
 */
async function offerSlotToWaitlist(appointment) {
  const clinic = await db.getClinicById(appointment.clinic_id);
  if (!clinic) return { offered: false, reason: 'clinic_not_found' };
  if (!clinic.is_active) return { offered: false, reason: 'clinic_inactive' };

  const waiting = await db.getWaitingWaitlistByClinic(clinic.id);

  for (const row of waiting) {
    if (!serviceMatches(row.service, appointment.service)) continue;
    if (!dateInRange(appointment.appointment_date, row.preferred_date_start, row.preferred_date_end)) continue;

    const contact = await db.getContactById(row.contact_id);
    if (!contact || contact.status === 'opted_out') continue; // never text opted-out

    const systemPrompt = prompts.waitlistSlotOffer(clinic, contact, {
      service: appointment.service,
      appointment_date: appointment.appointment_date,
      window_minutes: WAITLIST_OFFER_WINDOW_MINUTES
    });
    const history = await db.getRecentMessagesByContact(contact.id, 10);
    const body = await claude.generateSequenceMessage({
      clinic, contact, systemPrompt, history, label: 'waitlist_slot_offer'
    });

    await leadEngine.deliverMessage({
      clinic, contact,
      conversationId: appointment.conversation_id || null,
      body
    });

    await db.updateWaitlist(row.id, {
      status: 'offered',
      offered_appointment_id: appointment.id,
      offered_at: new Date().toISOString()
    });

    console.log(`[waitlist] offered slot (appt ${appointment.id}) to waitlist ${row.id} / contact ${contact.id}`);
    return { offered: true, waitlist_id: row.id, contact_id: contact.id };
  }

  return { offered: false, reason: 'no_eligible_match' };
}

module.exports = { offerSlotToWaitlist, serviceMatches, dateInRange };
