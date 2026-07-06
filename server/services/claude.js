const Anthropic = require('@anthropic-ai/sdk');
const { buildSystemPrompt } = require('../../prompts/clinic-system-prompt');
require('dotenv').config();

const MODEL = 'claude-sonnet-4-6';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  // SDK-level resilience: retry connection errors / timeouts / 429 / 5xx,
  // and cap how long any single request can hang before we give up.
  maxRetries: 2,
  timeout: 30 * 1000 // 30s
});

// ── RETRY HELPER ───────────────────────────────────────────────
// Wraps an Anthropic API call with a short retry + backoff on top of the
// SDK's own retries. Skips retrying non-retryable client errors (4xx that
// aren't rate limits) so we fail fast on bad requests / auth problems.
async function callWithRetry(label, fn, { retries = 2, baseDelayMs = 500 } = {}) {
  let lastErr;
  let attemptsMade = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    attemptsMade = attempt + 1;
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      // Don't retry non-retryable client errors (e.g. 400 bad request, 401 auth).
      // 429 (rate limit) is retryable.
      const status = err && err.status;
      if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
        break;
      }

      if (attempt < retries) {
        const delay = baseDelayMs * Math.pow(2, attempt); // 500ms, 1000ms
        console.warn(
          `Claude call "${label}" failed (attempt ${attempt + 1}/${retries + 1}) — retrying in ${delay}ms:`,
          err && err.message ? err.message : err
        );
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  // All attempts exhausted (or a non-retryable error) — log the full error for diagnostics.
  console.error(`Claude call "${label}" failed after ${attemptsMade} attempt(s):`, lastErr);
  return null; // signals the caller to use its safe fallback
}

// ── SAFE FALLBACK ──────────────────────────────────────────────
// Used whenever the AI call ultimately fails, so the contact never gets
// total silence. Falls back to the clinic's greeting + booking link.
function fallbackMessage(clinic) {
  const greeting = (clinic && clinic.greeting) || 'Hi! Thanks for reaching out.';
  if (clinic && clinic.booking_link) {
    return `${greeting} You can book with us here: ${clinic.booking_link}`;
  }
  return greeting;
}

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

  const response = await callWithRetry('generateResponse', () =>
    anthropic.messages.create({
      model: MODEL,
      max_tokens: 300, // keep responses short
      system: buildSystemPrompt(clinic, contact),
      messages: messages
    })
  );

  if (!response) return fallbackMessage(clinic);
  return response.content[0].text;
}

// Generate missed call text-back message
async function generateMissedCallText(clinic, contact) {
  const isReturning = contact.total_visits > 0;

  const prompt = isReturning
    ? `Write a warm, brief SMS (max 2 sentences) to a returning patient named ${contact.name || 'there'} who just called ${clinic.name} but we missed their call. Make them feel valued and ask how we can help.`
    : `Write a warm, brief SMS (max 2 sentences) to someone who just called ${clinic.name} but we missed their call. It is probably their first time. Make them feel welcomed and ask how we can help.`;

  const response = await callWithRetry('generateMissedCallText', () =>
    anthropic.messages.create({
      model: MODEL,
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }]
    })
  );

  if (!response) return fallbackMessage(clinic);
  return response.content[0].text;
}

// Generate no-show recovery message
async function generateNoShowText(clinic, contact, appointmentDate) {
  const prompt = `Write a warm, brief SMS (max 2 sentences) to ${contact.name || 'a patient'} who missed their appointment at ${clinic.name} on ${appointmentDate}. Be understanding, not accusatory. Offer to rebook easily.`;

  const response = await callWithRetry('generateNoShowText', () =>
    anthropic.messages.create({
      model: MODEL,
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }]
    })
  );

  if (!response) return fallbackMessage(clinic);
  return response.content[0].text;
}

// Generate dormant reactivation message
async function generateReactivationText(clinic, contact) {
  const prompt = `Write a warm, personalized SMS (max 2 sentences) to ${contact.name || 'a valued client'} who hasn't visited ${clinic.name} in a while. Mention we miss them and offer something compelling to come back. Services: ${clinic.services}.`;

  const response = await callWithRetry('generateReactivationText', () =>
    anthropic.messages.create({
      model: MODEL,
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }]
    })
  );

  if (!response) return fallbackMessage(clinic);
  return response.content[0].text;
}

// ── PILLAR 2 — LEAD ENGINE ─────────────────────────────────────
// These reuse the SAME anthropic client + callWithRetry wrapper as the
// missed-call flow — no second Claude path is introduced.

// Convert stored message rows into Anthropic chat turns.
function historyToTurns(history) {
  const turns = [];
  for (const msg of history || []) {
    turns.push({
      role: msg.direction === 'outbound' ? 'assistant' : 'user',
      content: msg.body
    });
  }
  return turns;
}

/**
 * Generate a proactive outbound message (first lead touch, nurture, reactivation,
 * VIP reminder). The caller supplies the SYSTEM prompt (from lead-engine-prompts);
 * we append the conversation history and a final internal instruction to write
 * the next message. Returns the message text, or a safe fallback on total failure.
 *
 * @param {object}   args
 * @param {object}   args.clinic
 * @param {object}   args.contact
 * @param {string}   args.systemPrompt
 * @param {Array}    [args.history]   message rows ({direction, body}) for context
 * @param {string}   [args.label]     log label
 */
async function generateSequenceMessage({ clinic, contact, systemPrompt, history = [], label = 'sequence' }) {
  const messages = historyToTurns(history);
  // Final internal turn tells Claude to produce the next outbound text now.
  messages.push({
    role: 'user',
    content: '(Write the next text message to send now. Output only the message text.)'
  });

  const response = await callWithRetry(label, () =>
    anthropic.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: systemPrompt,
      messages
    })
  );

  if (!response) return fallbackMessage(clinic);
  return response.content[0].text.trim();
}

/**
 * Classify an inbound message into BOOKED | OPT_OUT | NEITHER using the same
 * Claude client. Returns 'NEITHER' as the safe default if the call fails or the
 * output is unrecognized (so we never wrongly opt someone out on an API blip).
 *
 * @param {object} args
 * @param {string} args.classifierPrompt  system prompt from lead-engine-prompts.inboundClassifier()
 * @param {Array}  [args.history]
 * @param {string} args.message           the latest inbound message body
 */
async function classifyInboundIntent({ classifierPrompt, history = [], message }) {
  const messages = historyToTurns(history);
  messages.push({ role: 'user', content: message });

  const response = await callWithRetry('classifyInboundIntent', () =>
    anthropic.messages.create({
      model: MODEL,
      max_tokens: 8,
      system: classifierPrompt,
      messages
    })
  );

  if (!response) return 'NEITHER';
  const label = (response.content[0].text || '').trim().toUpperCase();
  if (label.includes('BOOKED')) return 'BOOKED';
  if (label.includes('OPT_OUT') || label.includes('OPTOUT')) return 'OPT_OUT';
  return 'NEITHER';
}

module.exports = {
  generateResponse,
  generateMissedCallText,
  generateNoShowText,
  generateReactivationText,
  generateSequenceMessage,
  classifyInboundIntent
};
