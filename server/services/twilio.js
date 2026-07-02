const twilio = require('twilio');
require('dotenv').config();

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function sendSMS(to, from, body) {
  const message = await client.messages.create({
    body: body,
    to: to,
    from: from
  });
  console.log(`SMS sent to ${to}: ${message.sid}`);
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

module.exports = { sendSMS, validateWebhook };
