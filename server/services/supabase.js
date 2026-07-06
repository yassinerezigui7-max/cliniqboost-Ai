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
  getStaleVipTouches
};
