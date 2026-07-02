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

module.exports = {
  getClinicByPhone,
  getOrCreateContact,
  getOrCreateConversation,
  saveMessage,
  getConversationHistory,
  logMissedCall,
  getDormantContacts,
  supabase
};
