const twilio = require('twilio');
require('dotenv').config();

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Mask a phone number for LOGGING ONLY — keep everything except the last 4
// digits, which become XXXX (e.g. +213791352725 -> +21379135XXXX).
// NEVER use this for the actual Twilio API call; the real number must be sent.
function maskPhone(number) {
  if (!number || typeof number !== 'string' || number.length <= 4) return number;
  return `${number.slice(0, -4)}XXXX`;
}

async function sendSMS(to, from, body) {
  // Mock mode: when TWILIO_SEND_ENABLED is explicitly "false", skip the real
  // Twilio API call entirely (useful while the account is payment-blocked).
  // Default/absent = true, so existing behavior (e.g. missed-call flow) is
  // unchanged. Returns a Twilio-shaped object so callers can still read .sid.
  if (String(process.env.TWILIO_SEND_ENABLED).toLowerCase() === 'false') {
    console.log(`[MOCK SMS] to ${maskPhone(to)} from ${maskPhone(from)}: ${body}`);
    return { sid: 'MOCK', to, from, body, mock: true };
  }

  const message = await client.messages.create({
    body: body,
    to: to,     // real, unmasked number — required by Twilio
    from: from  // real, unmasked number — required by Twilio
  });
  console.log(`SMS sent to ${maskPhone(to)}: ${message.sid}`);
  return message;
}

// Validate that a request to /webhook/twilio/* really came from Twilio.
// The URL must be exactly what Twilio requested — SERVER_URL (the public
// Railway URL) + the route path. (The old version validated against N8N_URL,
// a host Twilio never calls, so signatures could never match.)
//
// Enforcement is opt-in via TWILIO_VALIDATE_WEBHOOK=true: local curl tests
// and mock mode carry no valid signature, so default/absent = allow-all,
// keeping existing behavior until the flag is flipped in production.
function validateWebhook(req) {
  if (String(process.env.TWILIO_VALIDATE_WEBHOOK).toLowerCase() !== 'true') {
    return true;
  }
  const serverUrl = (process.env.SERVER_URL || '').replace(/\/$/, '');
  const url = `${serverUrl}${req.originalUrl}`;
  return twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    req.headers['x-twilio-signature'],
    url,
    req.body
  );
}

// Buy a phone number and point its voice/SMS webhooks at this server.
// Mock mode (TWILIO_SEND_ENABLED=false, same convention as sendSMS): no
// Twilio API call — returns a fake +1500555xxxx number so the provisioning
// flow can be exercised end-to-end while the account is payment-blocked.
async function provisionNumber({ isoCountry = 'US' } = {}) {
  if (String(process.env.TWILIO_SEND_ENABLED).toLowerCase() === 'false') {
    const fake = `+1500555${String(Math.floor(1000 + Math.random() * 9000))}`;
    console.log(`[MOCK PROVISION] would buy a ${isoCountry} number — returning ${fake}`);
    return { phoneNumber: fake, sid: 'MOCK', mock: true };
  }

  const serverUrl = (process.env.SERVER_URL || '').replace(/\/$/, '');
  if (!serverUrl) throw new Error('SERVER_URL must be set to provision numbers');

  const [available] = await client
    .availablePhoneNumbers(isoCountry)
    .local.list({ smsEnabled: true, voiceEnabled: true, limit: 1 });
  if (!available) {
    throw new Error(`no available Twilio numbers in ${isoCountry}`);
  }

  const purchased = await client.incomingPhoneNumbers.create({
    phoneNumber: available.phoneNumber,
    voiceUrl: `${serverUrl}/webhook/twilio/missed-call`,
    voiceMethod: 'POST',
    smsUrl: `${serverUrl}/webhook/twilio/inbound-sms`,
    smsMethod: 'POST'
  });
  console.log(`[twilio] provisioned ${maskPhone(purchased.phoneNumber)} (${purchased.sid}) → webhooks at ${serverUrl}`);
  return { phoneNumber: purchased.phoneNumber, sid: purchased.sid, mock: false };
}

module.exports = { sendSMS, validateWebhook, provisionNumber, maskPhone };
