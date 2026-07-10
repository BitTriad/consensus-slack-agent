import { query } from '@anthropic-ai/claude-agent-sdk';

/**
 * Provider-agnostic single-turn LLM completion.
 *
 * Primary path uses the Claude Agent SDK `query()` in single-shot mode with no
 * tools, authenticating via the local Claude Code login (no API key env needed).
 * If `GEMINI_API_KEY` is set, Google Gemini's REST API is used instead.
 *
 * @param {string} prompt - The user prompt.
 * @param {{ system?: string }} [opts]
 * @returns {Promise<string>} The model's text response.
 */
export async function llmComplete(prompt, { system } = {}) {
  if (process.env.CEREBRAS_API_KEY) {
    return cerebrasComplete(prompt, system);
  }
  if (process.env.GEMINI_API_KEY) {
    return geminiComplete(prompt, system);
  }
  return claudeComplete(prompt, system);
}

const CEREBRAS_MODEL = process.env.CEREBRAS_MODEL || 'gpt-oss-120b';

/**
 * Cerebras inference (OpenAI-compatible chat completions).
 * @param {string} prompt
 * @param {string} [system]
 * @returns {Promise<string>}
 */
async function cerebrasComplete(prompt, system) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.CEREBRAS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: CEREBRAS_MODEL, messages, max_completion_tokens: 2000 }),
  });
  if (!res.ok) {
    throw new Error(`Cerebras API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return (data?.choices?.[0]?.message?.content || '').trim();
}

/**
 * @param {string} prompt
 * @param {string} [system]
 * @returns {Promise<string>}
 */
async function claudeComplete(prompt, system) {
  /** @type {import('@anthropic-ai/claude-agent-sdk').Options} */
  const options = {
    allowedTools: [],
    maxTurns: 1,
    permissionMode: 'bypassPermissions',
    ...(system && { systemPrompt: system }),
  };

  const parts = [];
  for await (const message of query({ prompt, options })) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') parts.push(block.text);
      }
    }
  }
  return parts.join('').trim();
}

const GEMINI_MODEL = 'gemini-2.0-flash';

/**
 * @param {string} prompt
 * @param {string} [system]
 * @returns {Promise<string>}
 */
async function geminiComplete(prompt, system) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  /** @type {Record<string, any>} */
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((/** @type {any} */ p) => p.text || '').join('');
  return text.trim();
}
