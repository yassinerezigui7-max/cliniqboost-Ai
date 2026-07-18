const { normalizePhone } = require('./phone');

// Canonical booking-software values the backend understands. The intake form
// sends display names ("Vagaro", "Square Appointments") — mapped below.
const BOOKING_SOFTWARE = ['vagaro', 'mindbody', 'zenoti', 'boulevard', 'other'];
const BOOKING_SOFTWARE_ALIASES = {
  'square appointments': 'other',
  'square': 'other',
  'none': 'other'
};

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Schema allow-list: every field the intake form (or API caller) may send.
// Unknown fields are rejected outright — a public endpoint never accepts
// arbitrary keys into the database.
const ALLOWED_FIELDS = new Set([
  // identity + contact
  'legal_name', 'dba_name', 'contact_name_role', 'contact_email',
  'contact_mobile', 'clinic_phone',
  // address
  'addr_street', 'addr_city', 'addr_region', 'addr_postal', 'addr_country',
  // ops
  'timezone', 'booking_software', 'booking_link', 'sms_provider', 'sms_voice',
  'services_list', 'hero_service', 'banned_phrases', 'avg_service_price',
  // marketing / data
  'runs_ads', 'ad_spend', 'meta_access', 'google_access',
  'db_size', 'csv_export', 'db_csv_link',
  // quiet hours + per-day hours
  'quiet_start', 'quiet_end',
  ...DAYS.flatMap(d => [`hours_${d}_open`, `hours_${d}_close`, `hours_${d}_closed`]),
  // misc form plumbing
  'extra_notes', 'msa_signed', 'consent_sms', 'form_type', '_subject',
  // anti-abuse + idempotency plumbing (consumed by the route, not stored)
  'website_url', '_gotcha', 'turnstile_token', 'cf-turnstile-response',
  'idempotency_key'
]);

// Strip UI suffixes like "America/New_York (Eastern)" → "America/New_York",
// then check it's a real IANA zone.
function normalizeTimezone(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const tz = raw.replace(/\s*\(.*\)\s*$/, '').trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

function normalizeBookingSoftware(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  const mapped = BOOKING_SOFTWARE_ALIASES[key] || key;
  return BOOKING_SOFTWARE.includes(mapped) ? mapped : null;
}

// Build {mon:{open,close,closed},...} from the form's flat hours_* fields.
// Returns { hours, errors } — errors is a field-keyed map.
function buildBusinessHours(body) {
  const hours = {};
  const errors = {};
  for (const day of DAYS) {
    const closed = String(body[`hours_${day}_closed`] || '').toLowerCase();
    const isClosed = closed === 'true' || closed === 'on' || closed === '1' || closed === 'yes';
    const open = (body[`hours_${day}_open`] || '').trim();
    const close = (body[`hours_${day}_close`] || '').trim();
    if (isClosed) {
      hours[day] = { closed: true };
      continue;
    }
    if (!open && !close) continue; // day not filled in — fine
    if (!HHMM.test(open)) errors[`hours_${day}_open`] = 'must be HH:MM (24h)';
    if (!HHMM.test(close)) errors[`hours_${day}_close`] = 'must be HH:MM (24h)';
    if (!errors[`hours_${day}_open`] && !errors[`hours_${day}_close`]) {
      hours[day] = { open, close, closed: false };
    }
  }
  return { hours, errors };
}

/**
 * Validate + normalize an onboarding submission.
 *
 * @param {object} body  Raw request body (intake-form field names).
 * @returns {{ ok: boolean, errors?: object, clean?: object }}
 *   errors — field-keyed map for the 422 response.
 *   clean  — the canonical payload for the create_clinic_onboarding RPC.
 */
function validateOnboarding(body) {
  const errors = {};

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: { _body: 'JSON object body is required' } };
  }

  // Schema allow-list — reject unknown fields.
  const unknown = Object.keys(body).filter(k => !ALLOWED_FIELDS.has(k));
  if (unknown.length > 0) {
    errors._unknown_fields = `unknown fields: ${unknown.join(', ')}`;
  }

  // Required: clinic name (dba or legal)
  const clinicName = (body.dba_name || body.legal_name || '').trim();
  if (!clinicName) errors.legal_name = 'legal_name (or dba_name) is required';

  // Required: email
  const email = (body.contact_email || '').trim().toLowerCase();
  if (!email) errors.contact_email = 'contact_email is required';
  else if (!EMAIL_RE.test(email)) errors.contact_email = 'must be a valid email address';

  // Required: country (default phone region)
  const country = (body.addr_country || '').trim();
  if (!country) errors.addr_country = 'addr_country is required';

  // Required: owner mobile → E.164
  let ownerPhone = null;
  if (!body.contact_mobile || !String(body.contact_mobile).trim()) {
    errors.contact_mobile = 'contact_mobile is required';
  } else {
    const norm = normalizePhone(String(body.contact_mobile), country);
    if (!norm.valid || !norm.e164) {
      errors.contact_mobile = `could not be normalized to E.164 (reason: ${norm.reason || 'invalid'})`;
    } else {
      ownerPhone = norm.e164;
    }
  }

  // Optional: clinic landline → E.164
  let clinicPhone = null;
  if (body.clinic_phone && String(body.clinic_phone).trim()) {
    const norm = normalizePhone(String(body.clinic_phone), country);
    if (!norm.valid || !norm.e164) {
      errors.clinic_phone = `could not be normalized to E.164 (reason: ${norm.reason || 'invalid'})`;
    } else {
      clinicPhone = norm.e164;
    }
  }

  // Required: timezone (IANA)
  const timezone = normalizeTimezone(body.timezone);
  if (!timezone) errors.timezone = 'must be a valid IANA timezone';

  // Required: services
  const services = (body.services_list || '').trim();
  if (!services) errors.services_list = 'services_list is required';

  // Required: booking software ∈ known set
  const bookingSoftware = normalizeBookingSoftware(body.booking_software);
  if (!bookingSoftware) {
    errors.booking_software = `must be one of: ${BOOKING_SOFTWARE.join(', ')} (or a known alias)`;
  }

  // Business hours + quiet hours
  const { hours: businessHours, errors: hoursErrors } = buildBusinessHours(body);
  Object.assign(errors, hoursErrors);

  const quietHours = {};
  for (const [field, key] of [['quiet_start', 'start'], ['quiet_end', 'end']]) {
    const v = (body[field] || '').trim();
    if (!v) continue;
    if (!HHMM.test(v)) errors[field] = 'must be HH:MM (24h)';
    else quietHours[key] = v;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  // Canonical payload for the RPC. `raw` keeps the untouched submission for
  // onboarding_submissions (audit/replay).
  const clean = {
    clinic_name: clinicName,
    legal_name: (body.legal_name || '').trim() || clinicName,
    email,
    owner_phone: ownerPhone,
    clinic_phone: clinicPhone,
    city: (body.addr_city || '').trim() || null,
    country,
    timezone,
    services,
    hero_service: (body.hero_service || '').trim() || null,
    avg_service_price: Number(body.avg_service_price) || 0,
    booking_link: (body.booking_link || '').trim() || null,
    booking_software: bookingSoftware,
    booking_software_raw: String(body.booking_software).trim(),
    business_hours: businessHours,
    quiet_hours: quietHours,
    lead_settings: {
      runs_ads: body.runs_ads || null,
      ad_spend: body.ad_spend || null,
      meta_access: body.meta_access || null,
      google_access: body.google_access || null,
      sms_provider: (body.sms_provider || '').trim() || null,
      db_size: body.db_size || null,
      csv_export: body.csv_export || null
    },
    idempotency_key: (body.idempotency_key || '').trim() || email,
    raw: body
  };

  return { ok: true, clean };
}

module.exports = { validateOnboarding, normalizeTimezone, normalizeBookingSoftware, BOOKING_SOFTWARE };
