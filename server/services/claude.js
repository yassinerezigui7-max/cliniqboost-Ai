const Anthropic = require('@anthropic-ai/sdk');
const { buildSystemPrompt } = require('../../prompts/clinic-system-prompt');
require('dotenv').config();

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

async function generateResponse(clinic, contact, conversationHistory, incomingMessage) {
  // Build conversation for Claude
  const messages = [];

  // Add history
  for (const msg of conversationHistory) {
    messages.push({
      role: msg.direction === 'outbound' ? 'assistant' : 'user',
      content: msg.body
    });
  }

  // Add the new message
  messages.push({
    role: 'user',
    content: incomingMessage
  });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300, // keep responses short
    system: buildSystemPrompt(clinic, contact),
    messages: messages
  });

  return response.content[0].text;
}

// Generate missed call text-back message
async function generateMissedCallText(clinic, contact) {
  const isReturning = contact.total_visits > 0;

  const prompt = isReturning
    ? `Write a warm, brief SMS (max 2 sentences) to a returning patient named ${contact.name || 'there'} who just called ${clinic.name} but we missed their call. Make them feel valued and ask how we can help.`
    : `Write a warm, brief SMS (max 2 sentences) to someone who just called ${clinic.name} but we missed their call. It is probably their first time. Make them feel welcomed and ask how we can help.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 150,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text;
}

// Generate no-show recovery message
async function generateNoShowText(clinic, contact, appointmentDate) {
  const prompt = `Write a warm, brief SMS (max 2 sentences) to ${contact.name || 'a patient'} who missed their appointment at ${clinic.name} on ${appointmentDate}. Be understanding, not accusatory. Offer to rebook easily.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 150,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text;
}

// Generate dormant reactivation message
async function generateReactivationText(clinic, contact) {
  const prompt = `Write a warm, personalized SMS (max 2 sentences) to ${contact.name || 'a valued client'} who hasn't visited ${clinic.name} in a while. Mention we miss them and offer something compelling to come back. Services: ${clinic.services}.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 150,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text;
}

module.exports = {
  generateResponse,
  generateMissedCallText,
  generateNoShowText,
  generateReactivationText
};
