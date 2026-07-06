const db = require('../services/supabase');

const DAY_MS = 24 * 60 * 60 * 1000;
const VIP_REBOOK_THRESHOLD_DAYS = parseInt(process.env.VIP_REBOOK_THRESHOLD_DAYS, 10) || 45;

// Dedupe windows (per reminder_type, per contact).
const DEDUPE_DAYS = {
  renewal: 30,
  unused_benefit: 30,
  rebooking: 30,
  tier_upgrade: 90
};

// Sum a jsonb allowance value. Handles object maps ({service: n}), plain
// numbers, numeric strings, and null/missing → 0. Never throws.
function sumAllowance(val) {
  if (val == null) return 0;
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  if (typeof val === 'string') { const n = Number(val); return isNaN(n) ? 0 : n; }
  if (typeof val === 'object') {
    return Object.values(val).reduce((s, v) => {
      const n = Number(v);
      return s + (isNaN(n) ? 0 : n);
    }, 0);
  }
  return 0;
}

function daysUntil(dateStr, now) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.floor((d.getTime() - now.getTime()) / DAY_MS);
}

function daysSince(dateStr, now) {
  const du = daysUntil(dateStr, now);
  return du == null ? null : -du;
}

// Insert a vip_retention touch of `reminderType` unless one was created within
// its dedupe window. Returns true if inserted.
async function maybeInsert(clinic, contact, reminderType, now) {
  const sinceIso = new Date(now.getTime() - DEDUPE_DAYS[reminderType] * DAY_MS).toISOString();
  const recent = await db.findRecentVipTouch(contact.id, reminderType, sinceIso);
  if (recent) return false;

  await db.insertTouch({
    clinicId: clinic.id,
    contactId: contact.id,
    sequenceType: 'vip_retention',
    reminderType,
    touchNumber: 1,
    scheduledAt: now.toISOString()
  });
  return true;
}

async function evaluateContact(clinic, contact, now, stats) {
  // Rule 1 — renewal within next 7 days.
  const dToRenewal = daysUntil(contact.renewal_date, now);
  if (dToRenewal != null && dToRenewal >= 0 && dToRenewal <= 7) {
    if (await maybeInsert(clinic, contact, 'renewal', now)) stats.renewal++;
  }

  // Rules 2 & 4 depend on allowance sums.
  const used = sumAllowance(contact.allowance_used_this_cycle);
  const total = sumAllowance(contact.allowance_total_this_cycle);
  const hasTotal = contact.allowance_total_this_cycle != null && total > 0;

  // Rule 2 — < 50% of allowance used AND renewal within 14 days → unused_benefit.
  if (hasTotal && used < total * 0.5 && dToRenewal != null && dToRenewal >= 0 && dToRenewal <= 14) {
    if (await maybeInsert(clinic, contact, 'unused_benefit', now)) stats.unused_benefit++;
  }

  // Rule 3 — last visit older than threshold → rebooking.
  const sinceVisit = daysSince(contact.last_visit_date, now);
  if (sinceVisit != null && sinceVisit > VIP_REBOOK_THRESHOLD_DAYS) {
    if (await maybeInsert(clinic, contact, 'rebooking', now)) stats.rebooking++;
  }

  // Rule 4 — usage >= 100% of allowance AND not already gold → tier_upgrade.
  if (hasTotal && used >= total && contact.vip_tier !== 'gold') {
    if (await maybeInsert(clinic, contact, 'tier_upgrade', now)) stats.tier_upgrade++;
  }
}

/**
 * Daily VIP retention sweep: inserts vip_retention touch rows. Actual sending
 * (with per-clinic quiet hours) is done by the sequence scheduler, which picks
 * up these rows. Malformed allowance data skips the contact with a warning
 * rather than crashing the sweep.
 */
async function runVipSweep() {
  const started = Date.now();
  const now = new Date();
  const stats = { clinics: 0, contacts: 0, renewal: 0, unused_benefit: 0, rebooking: 0, tier_upgrade: 0, skipped: 0 };

  let clinics = [];
  try {
    clinics = await db.getActiveClinics();
  } catch (err) {
    console.error('[vip-sweep] failed to fetch clinics:', err);
    return { error: err.message };
  }

  for (const clinic of clinics) {
    stats.clinics++;
    let contacts = [];
    try {
      contacts = await db.getVipContacts(clinic.id);
    } catch (err) {
      console.error(`[vip-sweep] failed to fetch VIP contacts for clinic ${clinic.id}:`, err.message);
      continue;
    }

    for (const contact of contacts) {
      stats.contacts++;
      try {
        await evaluateContact(clinic, contact, now, stats);
      } catch (err) {
        stats.skipped++;
        console.warn(`[vip-sweep] skipped contact ${contact.id} (clinic ${clinic.id}) — ${err.message}`);
      }
    }
  }

  const ms = Date.now() - started;
  console.log(`[vip-sweep] run complete in ${ms}ms —`, stats);
  return stats;
}

module.exports = { runVipSweep, sumAllowance };
