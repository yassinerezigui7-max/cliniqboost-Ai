const { parsePhoneNumberFromString } = require('libphonenumber-js');

// Map the free-text clinics.country values we use to ISO 3166-1 alpha-2
// region codes that libphonenumber-js understands. Extend as new markets
// are onboarded. Full country names and common variants are handled here so
// callers can pass whatever is stored in clinics.country.
const COUNTRY_TO_ISO = {
  'uae': 'AE',
  'united arab emirates': 'AE',
  'emirates': 'AE',
  'algeria': 'DZ',
  'dz': 'DZ',
  'usa': 'US',
  'united states': 'US',
  'us': 'US',
  'canada': 'CA',
  'uk': 'GB',
  'united kingdom': 'GB',
  'gb': 'GB',
  'france': 'FR',
  'saudi arabia': 'SA',
  'ksa': 'SA',
  'morocco': 'MA',
  'tunisia': 'TN',
  'egypt': 'EG'
};

// Resolve a clinics.country value (name, ISO code, or variant) to an ISO region.
function resolveRegion(country) {
  if (!country) return undefined;
  const key = String(country).trim().toLowerCase();
  if (COUNTRY_TO_ISO[key]) return COUNTRY_TO_ISO[key];
  // If they already stored a 2-letter ISO code we don't have mapped, try it as-is.
  if (/^[a-z]{2}$/.test(key)) return key.toUpperCase();
  return undefined;
}

/**
 * Normalize a raw phone string to E.164.
 *
 * @param {string} raw            The phone number in any format.
 * @param {string} [country]      clinics.country, used as the default region
 *                                when the number has no international prefix.
 * @returns {{ e164: string|null, valid: boolean, ambiguous: boolean, reason?: string }}
 */
function normalizePhone(raw, country) {
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    return { e164: null, valid: false, ambiguous: false, reason: 'empty' };
  }

  const trimmed = raw.trim();
  const region = resolveRegion(country);

  // If the number has no + prefix and we couldn't resolve a region, the
  // country code is genuinely ambiguous — flag it so the caller can warn.
  if (!trimmed.startsWith('+') && !region) {
    const guess = parsePhoneNumberFromString(trimmed);
    if (guess && guess.isValid()) {
      return { e164: guess.number, valid: true, ambiguous: true, reason: 'no_region_but_parsed' };
    }
    return { e164: null, valid: false, ambiguous: true, reason: 'no_region' };
  }

  const parsed = parsePhoneNumberFromString(trimmed, region);
  if (!parsed) {
    return { e164: null, valid: false, ambiguous: false, reason: 'unparseable' };
  }

  return {
    e164: parsed.number,
    valid: parsed.isValid(),
    ambiguous: false,
    reason: parsed.isValid() ? undefined : 'invalid'
  };
}

module.exports = { normalizePhone, resolveRegion };
