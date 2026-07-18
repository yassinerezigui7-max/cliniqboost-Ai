const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── CLINIC ─────────────────────────────────────────────────────
async function getClinicByPhone(twilioNumber) {
  const { data, error } = await supabase
    .from('clinics')
    .select('*')
    .eq('phone_number', twilioNumber)
    .eq('is_active', true)
    .single();
  if (error) throw error;
  return data;
}

// ── CONTACT ────────────────────────────────────────────────────
async function getOrCreateContact(clinicId, phoneNumber) {
  // Try to find existing contact
  let { data: contact } = await supabase
    .from('contacts')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('phone_number', phoneNumber)
    .single();

  // Create if not exists
  if (!contact) {
    const { data: newContact, error } = await supabase
      .from('contacts')
      .insert({ clinic_id: clinicId, phone_number: phoneNumber })
      .select()
      .single();
    if (error) throw error;
    contact = newContact;
  }

  return contact;
}

// ── CONVERSATION ───────────────────────────────────────────────
async function getOrCreateConversation(clinicId, contactId, triggerType) {
  // Look for active conversation in last 24 hours
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  let { data: conversation } = await supabase
    .from('conversations')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('contact_id', contactId)
    .eq('status', 'active')
    .gte('created_at', yesterday)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!conversation) {
    const { data: newConv, error } = await supabase
      .from('conversations')
      .insert({
        clinic_id: clinicId,
        contact_id: contactId,
        trigger_type: triggerType,
        status: 'active'
      })
      .select()
      .single();
    if (error) throw error;
    conversation = newConv;
  }

  return conversation;
}

// ── MESSAGES ───────────────────────────────────────────────────
async function saveMessage(data) {
  const { error } = await supabase.from('messages').insert(data);
  if (error) throw error;
}

async function getConversationHistory(conversationId, limit = 10) {
  const { data, error } = await supabase
    .from('messages')
    .select('direction, body, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data;
}

// ── MISSED CALLS ───────────────────────────────────────────────
async function logMissedCall(data) {
  const { error } = await supabase.from('missed_calls').insert(data);
  if (error) throw error;
}

// ── DORMANT CONTACTS ───────────────────────────────────────────
async function getDormantContacts(clinicId, daysSinceVisit = 60) {
  const cutoffDate = new Date(
    Date.now() - daysSinceVisit * 24 * 60 * 60 * 1000
  ).toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('status', 'client')
    .lt('last_visit_date', cutoffDate)
    .limit(50);
  if (error) throw error;
  return data || [];
}

// ═══════════════════════════════════════════════════════════════
// PILLAR 2 — LEAD ENGINE HELPERS
// (new helpers; the missed-call flow above is untouched)
// ═══════════════════════════════════════════════════════════════

// ── CLINICS ────────────────────────────────────────────────────
async function getClinicById(clinicId) {
  const { data } = await supabase
    .from('clinics').select('*').eq('id', clinicId).maybeSingle();
  return data || null;
}

async function getActiveClinics() {
  const { data, error } = await supabase
    .from('clinics').select('*').eq('is_active', true);
  if (error) throw error;
  return data || [];
}

// ── CONTACTS ───────────────────────────────────────────────────
async function getContactById(contactId) {
  const { data } = await supabase
    .from('contacts').select('*').eq('id', contactId).maybeSingle();
  return data || null;
}

// Upsert a lead contact on (clinic_id, phone_number). New → status 'lead'.
// Existing → never downgrade status; only fill name/email when currently empty.
async function upsertLeadContact({ clinicId, phone, name, email }) {
  const { data: existing } = await supabase
    .from('contacts').select('*')
    .eq('clinic_id', clinicId).eq('phone_number', phone).maybeSingle();

  if (existing) {
    const patch = { updated_at: new Date().toISOString() };
    if (name && !existing.name) patch.name = name;
    if (email && !existing.email) patch.email = email;
    const { data: updated, error } = await supabase
      .from('contacts').update(patch).eq('id', existing.id).select().single();
    if (error) throw error;
    return { contact: updated, isNew: false };
  }

  const { data: created, error } = await supabase
    .from('contacts')
    .insert({
      clinic_id: clinicId,
      phone_number: phone,
      name: name || null,
      email: email || null,
      status: 'lead'
    })
    .select().single();
  if (error) throw error;
  return { contact: created, isNew: true };
}

async function setContactStatus(contactId, status) {
  const { error } = await supabase
    .from('contacts')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', contactId);
  if (error) throw error;
}

async function getVipContacts(clinicId) {
  const { data, error } = await supabase
    .from('contacts').select('*')
    .eq('clinic_id', clinicId)
    .eq('is_vip_member', true)
    .neq('status', 'opted_out');
  if (error) throw error;
  return data || [];
}

// ── CONVERSATIONS ──────────────────────────────────────────────
// Dedupe helper: has a conversation of this trigger_type been created recently?
async function findRecentConversation(clinicId, contactId, triggerType, sinceMinutes) {
  const since = new Date(Date.now() - sinceMinutes * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('conversations').select('*')
    .eq('clinic_id', clinicId)
    .eq('contact_id', contactId)
    .eq('trigger_type', triggerType)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

async function createConversation({ clinicId, contactId, triggerType }) {
  const { data, error } = await supabase
    .from('conversations')
    .insert({
      clinic_id: clinicId,
      contact_id: contactId,
      trigger_type: triggerType,
      status: 'active'
    })
    .select().single();
  if (error) throw error;
  return data;
}

// ── MESSAGES (by contact, for sequence context) ────────────────
async function getRecentMessagesByContact(contactId, limit = 10) {
  const { data, error } = await supabase
    .from('messages')
    .select('direction, body, created_at')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  // Return chronological (oldest first) for the model.
  return (data || []).reverse();
}

// ── TOUCH SCHEDULE ─────────────────────────────────────────────
async function insertTouch({ clinicId, contactId, sequenceType, reminderType = null, touchNumber = 1, scheduledAt }) {
  const { data, error } = await supabase
    .from('touch_schedule')
    .insert({
      clinic_id: clinicId,
      contact_id: contactId,
      sequence_type: sequenceType,
      reminder_type: reminderType,
      touch_number: touchNumber,
      scheduled_at: scheduledAt,
      outcome: 'pending'
    })
    .select().single();
  if (error) throw error;
  return data;
}

async function getPendingTouchesForContact(contactId) {
  const { data, error } = await supabase
    .from('touch_schedule').select('*')
    .eq('contact_id', contactId)
    .eq('outcome', 'pending');
  if (error) throw error;
  return data || [];
}

// Mark all pending touches for a contact with a terminal outcome.
async function setPendingTouchesOutcome(contactId, outcome) {
  const { data, error } = await supabase
    .from('touch_schedule')
    .update({ outcome })
    .eq('contact_id', contactId)
    .eq('outcome', 'pending')
    .select('id');
  if (error) throw error;
  return (data || []).length;
}

async function updateTouchOutcome(touchId, outcome) {
  const { error } = await supabase
    .from('touch_schedule').update({ outcome }).eq('id', touchId);
  if (error) throw error;
}

async function markTouchSent(touchId, sentAtIso) {
  const { error } = await supabase
    .from('touch_schedule').update({ sent_at: sentAtIso }).eq('id', touchId);
  if (error) throw error;
}

async function rescheduleTouch(touchId, newScheduledAtIso) {
  const { error } = await supabase
    .from('touch_schedule').update({ scheduled_at: newScheduledAtIso }).eq('id', touchId);
  if (error) throw error;
}

// Due, pending, not-yet-sent touches ready to fire. The `sent_at is null` guard
// is critical: a sent row keeps outcome 'pending' while awaiting a reply, and
// without this filter it would be re-sent on every run.
async function getDueTouches(limit = 25) {
  const { data, error } = await supabase
    .from('touch_schedule').select('*')
    .lte('scheduled_at', new Date().toISOString())
    .eq('outcome', 'pending')
    .is('sent_at', null)
    .order('scheduled_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// VIP dedupe: any vip_retention row of this reminder_type created since `sinceIso`?
async function findRecentVipTouch(contactId, reminderType, sinceIso) {
  const { data } = await supabase
    .from('touch_schedule').select('id')
    .eq('contact_id', contactId)
    .eq('sequence_type', 'vip_retention')
    .eq('reminder_type', reminderType)
    .gte('created_at', sinceIso)
    .limit(1)
    .maybeSingle();
  return data || null;
}

// Stale vip_retention rows: sent, still pending, older than cutoff → for cleanup.
async function getStaleVipTouches(sentBeforeIso) {
  const { data, error } = await supabase
    .from('touch_schedule').select('*')
    .eq('sequence_type', 'vip_retention')
    .eq('outcome', 'pending')
    .not('sent_at', 'is', null)
    .lte('sent_at', sentBeforeIso);
  if (error) throw error;
  return data || [];
}

// ═══════════════════════════════════════════════════════════════
// ONBOARDING — clinic creation (via RPC), provisioning jobs,
// integration tasks, lead sources, import jobs
// ═══════════════════════════════════════════════════════════════

// The ONLY way a clinic is created: one Postgres transaction inside the
// create_clinic_onboarding RPC (clinics + clinic_config + submission +
// tasks + provisioning job, all-or-nothing). Idempotent on email.
async function createClinicOnboarding(payload) {
  const { data, error } = await supabase
    .rpc('create_clinic_onboarding', { p_payload: payload });
  if (error) throw error;
  return data; // { clinic_id, slug, onboarding_status, existing }
}

// Exact case-insensitive email match (ilike with no wildcards).
async function getClinicByEmail(email) {
  const { data } = await supabase
    .from('clinics').select('*')
    .ilike('email', String(email).trim())
    .limit(1)
    .maybeSingle();
  return data || null;
}

async function updateClinic(clinicId, patch) {
  const { error } = await supabase
    .from('clinics').update(patch).eq('id', clinicId);
  if (error) throw error;
}

async function setClinicOnboardingStatus(clinicId, status) {
  await updateClinic(clinicId, { onboarding_status: status });
}

// ── PROVISIONING JOBS ──────────────────────────────────────────
async function getProvisioningJobByClinic(clinicId) {
  const { data } = await supabase
    .from('provisioning_jobs').select('*')
    .eq('clinic_id', clinicId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

// Due, pending jobs for the retry cron.
async function getDueProvisioningJobs(limit = 10) {
  const { data, error } = await supabase
    .from('provisioning_jobs').select('*')
    .eq('status', 'pending')
    .lte('next_attempt_at', new Date().toISOString())
    .order('next_attempt_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// Crash recovery: a job left 'running' longer than staleMinutes means the
// process died mid-provision — return it to 'pending' so the cron retries.
async function resetStaleRunningProvisioningJobs(staleMinutes = 30) {
  const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('provisioning_jobs')
    .update({ status: 'pending', updated_at: new Date().toISOString() })
    .eq('status', 'running')
    .lte('updated_at', cutoff)
    .select('id');
  if (error) throw error;
  return (data || []).length;
}

async function updateProvisioningJob(jobId, patch) {
  const { error } = await supabase
    .from('provisioning_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', jobId);
  if (error) throw error;
}

// Counts by status, for /health/provisioning.
async function getProvisioningSummary() {
  const statuses = ['pending', 'running', 'done', 'failed'];
  const counts = await Promise.all(statuses.map(s =>
    supabase.from('provisioning_jobs')
      .select('*', { count: 'exact', head: true })
      .eq('status', s)
  ));
  const summary = {};
  statuses.forEach((s, i) => { summary[s] = counts[i].count || 0; });
  return summary;
}

// ── INTEGRATION TASKS ──────────────────────────────────────────
async function getIntegrationTasks(clinicId) {
  const { data, error } = await supabase
    .from('integration_tasks').select('*')
    .eq('clinic_id', clinicId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function findIntegrationTask(clinicId, type) {
  const { data } = await supabase
    .from('integration_tasks').select('*')
    .eq('clinic_id', clinicId)
    .eq('type', type)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

async function insertIntegrationTask({ clinicId, type, status = 'pending', payload = {} }) {
  const { data, error } = await supabase
    .from('integration_tasks')
    .insert({ clinic_id: clinicId, type, status, payload })
    .select().single();
  if (error) throw error;
  return data;
}

async function updateIntegrationTask(taskId, patch) {
  const { error } = await supabase
    .from('integration_tasks')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', taskId);
  if (error) throw error;
}

// ── LEAD SOURCES ───────────────────────────────────────────────
// Resolve a clinic from an ingress source id (Meta page, Google form, …) —
// this is what keeps the n8n ingress workflows clinic-agnostic.
async function getLeadSource(channel, externalId) {
  const { data } = await supabase
    .from('lead_sources').select('*')
    .eq('channel', channel)
    .eq('external_id', externalId)
    .maybeSingle();
  return data || null;
}

async function insertLeadSource({ clinicId, channel, externalId }) {
  const { data, error } = await supabase
    .from('lead_sources')
    .insert({ clinic_id: clinicId, channel, external_id: externalId })
    .select().single();
  if (error) throw error;
  return data;
}

// ── IMPORT JOBS ────────────────────────────────────────────────
async function insertImportJob({ clinicId, source = 'csv' }) {
  const { data, error } = await supabase
    .from('import_jobs')
    .insert({ clinic_id: clinicId, source, status: 'pending' })
    .select().single();
  if (error) throw error;
  return data;
}

async function updateImportJob(jobId, patch) {
  const { error } = await supabase
    .from('import_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', jobId);
  if (error) throw error;
}

async function getImportJob(jobId) {
  const { data } = await supabase
    .from('import_jobs').select('*').eq('id', jobId).maybeSingle();
  return data || null;
}

// ═══════════════════════════════════════════════════════════════
// DASHBOARD — server-side aggregates (service key, bypasses RLS)
// ═══════════════════════════════════════════════════════════════
async function getDashboardStats() {
  const today = new Date().toISOString().split('T')[0];
  const [missed, messages, conversations, appointments] = await Promise.all([
    supabase.from('missed_calls').select('*', { count: 'exact', head: true }).gte('created_at', today),
    supabase.from('messages').select('*', { count: 'exact', head: true }).gte('created_at', today),
    supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('appointments').select('*', { count: 'exact', head: true }).gte('created_at', today)
  ]);
  return {
    missed_calls_today: missed.count || 0,
    messages_today: messages.count || 0,
    active_conversations: conversations.count || 0,
    appointments_today: appointments.count || 0
  };
}

async function getRecentMessages(limit = 20) {
  const { data, error } = await supabase
    .from('messages')
    .select('direction, body, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).reverse(); // chronological for the feed
}

// ═══════════════════════════════════════════════════════════════
// SUB-SYSTEM 5 — APPOINTMENTS + WAITLIST HELPERS
// ═══════════════════════════════════════════════════════════════

async function getAppointmentById(id) {
  const { data } = await supabase
    .from('appointments').select('*').eq('id', id).maybeSingle();
  return data || null;
}

// 24h reminders due: scheduled, start in [now+23h, now+25h], not yet reminded.
async function getDueReminders24h() {
  const now = Date.now();
  const { data, error } = await supabase
    .from('appointments').select('*')
    .eq('status', 'scheduled')
    .eq('reminder_sent_24h', false)
    .gte('appointment_date', new Date(now + 23 * 60 * 60 * 1000).toISOString())
    .lte('appointment_date', new Date(now + 25 * 60 * 60 * 1000).toISOString());
  if (error) throw error;
  return data || [];
}

// 2h reminders due: scheduled, start in [now+1.5h, now+2.5h], not yet reminded.
async function getDueReminders2h() {
  const now = Date.now();
  const { data, error } = await supabase
    .from('appointments').select('*')
    .eq('status', 'scheduled')
    .eq('reminder_sent_2h', false)
    .gte('appointment_date', new Date(now + 1.5 * 60 * 60 * 1000).toISOString())
    .lte('appointment_date', new Date(now + 2.5 * 60 * 60 * 1000).toISOString());
  if (error) throw error;
  return data || [];
}

// No-show candidates: start > 30 min ago, still scheduled/confirmed, no recovery sent.
async function getNoShowCandidates() {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('appointments').select('*')
    .in('status', ['scheduled', 'confirmed'])
    .eq('noshow_recovery_sent', false)
    .lt('appointment_date', cutoff);
  if (error) throw error;
  return data || [];
}

async function markReminderSent(appointmentId, column) {
  if (column !== 'reminder_sent_24h' && column !== 'reminder_sent_2h') {
    throw new Error(`invalid reminder column: ${column}`);
  }
  const { error } = await supabase
    .from('appointments').update({ [column]: true }).eq('id', appointmentId);
  if (error) throw error;
}

async function setAppointmentStatus(appointmentId, status) {
  const { error } = await supabase
    .from('appointments').update({ status }).eq('id', appointmentId);
  if (error) throw error;
}

async function markNoShowRecoverySent(appointmentId) {
  const { error } = await supabase
    .from('appointments').update({ noshow_recovery_sent: true }).eq('id', appointmentId);
  if (error) throw error;
}

// A confirmable appointment for this contact: reminded, still 'scheduled'.
async function getConfirmableAppointmentByContact(contactId) {
  const { data } = await supabase
    .from('appointments').select('*')
    .eq('contact_id', contactId)
    .eq('status', 'scheduled')
    .or('reminder_sent_24h.eq.true,reminder_sent_2h.eq.true')
    .order('appointment_date', { ascending: true })
    .limit(1)
    .maybeSingle();
  return data || null;
}

// ── WAITLIST ───────────────────────────────────────────────────
async function getWaitingWaitlistByClinic(clinicId) {
  const { data, error } = await supabase
    .from('waitlist').select('*')
    .eq('clinic_id', clinicId)
    .eq('status', 'waiting')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function getExpiredOfferedWaitlist(offeredBeforeIso) {
  const { data, error } = await supabase
    .from('waitlist').select('*')
    .eq('status', 'offered')
    .lt('offered_at', offeredBeforeIso);
  if (error) throw error;
  return data || [];
}

async function getOfferedWaitlistByContact(contactId) {
  const { data } = await supabase
    .from('waitlist').select('*')
    .eq('contact_id', contactId)
    .eq('status', 'offered')
    .order('offered_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

async function updateWaitlist(waitlistId, patch) {
  const { error } = await supabase
    .from('waitlist').update(patch).eq('id', waitlistId);
  if (error) throw error;
}

module.exports = {
  // existing (missed-call flow) — unchanged
  getClinicByPhone,
  getOrCreateContact,
  getOrCreateConversation,
  saveMessage,
  getConversationHistory,
  logMissedCall,
  getDormantContacts,
  supabase,
  // pillar 2 — lead engine
  getClinicById,
  getActiveClinics,
  getContactById,
  upsertLeadContact,
  setContactStatus,
  getVipContacts,
  findRecentConversation,
  createConversation,
  getRecentMessagesByContact,
  insertTouch,
  getPendingTouchesForContact,
  setPendingTouchesOutcome,
  updateTouchOutcome,
  markTouchSent,
  rescheduleTouch,
  getDueTouches,
  findRecentVipTouch,
  getStaleVipTouches,
  // sub-system 5 — appointments + waitlist
  getAppointmentById,
  getDueReminders24h,
  getDueReminders2h,
  getNoShowCandidates,
  markReminderSent,
  setAppointmentStatus,
  markNoShowRecoverySent,
  getConfirmableAppointmentByContact,
  getWaitingWaitlistByClinic,
  getExpiredOfferedWaitlist,
  getOfferedWaitlistByContact,
  updateWaitlist,
  // onboarding
  createClinicOnboarding,
  getClinicByEmail,
  updateClinic,
  setClinicOnboardingStatus,
  getProvisioningJobByClinic,
  getDueProvisioningJobs,
  resetStaleRunningProvisioningJobs,
  updateProvisioningJob,
  getProvisioningSummary,
  getIntegrationTasks,
  findIntegrationTask,
  insertIntegrationTask,
  updateIntegrationTask,
  getLeadSource,
  insertLeadSource,
  insertImportJob,
  updateImportJob,
  getImportJob,
  // dashboard
  getDashboardStats,
  getRecentMessages
};
