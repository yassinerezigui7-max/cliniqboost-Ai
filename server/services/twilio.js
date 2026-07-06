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

function validateWebhook(req) {
  const twilioSignature = req.headers['x-twilio-signature'];
  const url = `${process.env.N8N_URL}/webhook/twilio`;
  return twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    twilioSignature,
    url,
    req.body
  );
}

module.exports = { sendSMS, validateWebhook, maskPhone };
