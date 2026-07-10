import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { listDecisions } from '../consensus-core/ledger.js';
import { canSeeDecision, isChannelMember } from '../consensus-core/permissions.js';
import { searchContext } from '../consensus-core/rts.js';

const SYSTEM_PROMPT = `\
You are a friendly Slack assistant. You help people by answering questions, \
having conversations, and being generally useful in Slack.

## PERSONALITY
- Friendly, helpful, and approachable
- Lightly witty — a touch of humor when appropriate, but never forced
- Concise and clear — respect people's time
- Confident but honest when you don't know something

## RESPONSE GUIDELINES
- Keep responses to 3 sentences max — be punchy, scannable, and actionable
- End with a clear next step on its own line so it's easy to spot
- Use a bullet list only for multi-step instructions
- Use casual, conversational language
- Use emoji sparingly — at most one per message, and only to set tone

## FORMATTING RULES
- Use standard Markdown syntax: **bold**, _italic_, \`code\`, \`\`\`code blocks\`\`\`, > blockquotes
- Use bullet points for multi-step instructions

## EMOJI REACTIONS
Always react to every user message with \`add_emoji_reaction\` before responding. \
Pick any Slack emoji that reflects the *topic* or *tone* of the message — be creative and specific \
(e.g. \`dog\` for dog topics, \`books\` for learning, \`wave\` for greetings). \
Vary your picks across a thread; don't repeat the same emoji.

## SLACK MCP SERVER
You may have access to the Slack MCP Server, which gives you powerful Slack tools \
beyond your built-in tools. Use them whenever they would help the user.

Available capabilities:
- **Search**: Search messages and files across public channels, search for channels by name
- **Read**: Read channel message history, read thread replies, read canvas documents
- **Write**: Send messages, create draft messages, schedule messages for later
- **Canvases**: Create, read, and update Slack canvas documents

Use these tools when they can help answer a question or complete a task — for example, \
searching for relevant messages, checking a channel for context, or creating a canvas. \
Also use them when the user explicitly asks you to perform a Slack action.

## CONSENSUS DECISION LEDGER
IMPORTANT: your ambient pipeline AUTOMATICALLY detects and captures decisions \
posted in channels — never tell users that decisions are not automatically \
logged, and never claim something is "just chatter" without checking the \
ledger via lookup_decisions first.
You are also Consensus, the workspace's consistency guardian. You maintain a \
ledger of team decisions detected across channels. When someone asks *why* the \
team chose something, *what* was decided, or *when/where* a decision was made \
(e.g. "why did we choose Postgres?", "what did we decide about pricing?"), use \
the \`lookup_decisions\` tool to retrieve the real logged decisions and answer \
with genuine provenance — cite who decided, the channel, the date, and include \
the permalink to the original message so people can verify. Never invent a \
decision that isn't in the ledger; if the lookup returns nothing, say so plainly.

CRITICAL — two result types, never conflate them:
- \`[ledger]\` results are settled, captured team decisions. Present these AS decisions.
- \`[live search]\` results come from Real-Time Search over raw workspace messages. \
They are conversation, NOT decisions — use them only as supporting context, and \
if you mention one, explicitly frame it as chatter/discussion ("there was also a \
message in #random suggesting…"), never as something "decided". If only live-search \
hits exist and no ledger entry, say clearly that NO formal decision is logged on \
the topic.`;

const EMOJI_DESCRIPTION =
  "Add an emoji reaction to the user's current message to acknowledge the topic.\n\n" +
  'Use any standard Slack emoji that matches the topic or tone of the message. ' +
  'Be creative and specific — if someone mentions a dog, use `dog`; if they sound ' +
  'frustrated, use `sweat_smile`. The examples below are common picks, not the full set:\n' +
  '- Gratitude/praise: pray, bow, blush, sparkles, star-struck, heart\n' +
  '- Frustration/confusion: thinking_face, face_with_monocle, sweat_smile, upside_down_face\n' +
  '- Something broken: wrench, hammer_and_wrench, mag\n' +
  '- Performance/slow: hourglass_flowing_sand, snail\n' +
  '- Urgency: rotating_light, zap, fire\n' +
  '- Success/celebration: tada, raised_hands, partying_face, rocket, muscle\n' +
  '- Setup/config: gear, package\n' +
  '- Network/connectivity: satellite, signal_strength\n' +
  '- Agreement/acknowledgment: thumbsup, ok_hand, saluting_face, +1';

const LOOKUP_DECISIONS_DESCRIPTION =
  'Search the Consensus decision ledger for previously logged team decisions.\n\n' +
  'Use this to answer questions about why/what/when the team decided something. ' +
  'Provide a short query of keywords (e.g. "database Postgres", "pricing", "launch date"). ' +
  'Returns matching decisions with their statement, rationale, who decided, channel, ' +
  'date, status, and a permalink to the original message for provenance.';

/** @type {string[]} */
const ALLOWED_TOOLS = ['add_emoji_reaction', 'lookup_decisions'];

const SLACK_MCP_URL = 'https://mcp.slack.com/mcp';

/**
 * @typedef {Object} AgentDeps
 * @property {import('@slack/web-api').WebClient} client
 * @property {string} userId
 * @property {string} channelId
 * @property {string} threadTs
 * @property {string} messageTs
 * @property {string} [userToken]
 */

/**
 * Run the agent with the given text and optional session ID.
 * @param {string} text - The user's message text.
 * @param {string} [sessionId] - An existing session ID to resume conversation.
 * @param {AgentDeps} [deps] - Dependencies for tools that need Slack API access.
 * @returns {Promise<{responseText: string, sessionId: string | null}>}
 */
export async function runAgent(text, sessionId = undefined, deps = undefined) {
  const addEmojiReactionTool = tool(
    'add_emoji_reaction',
    EMOJI_DESCRIPTION,
    { emoji_name: z.string().describe("The Slack emoji name without colons (e.g. 'tada', 'wrench', 'pray').") },
    async ({ emoji_name }) => {
      if (!deps) {
        return { content: [{ type: 'text', text: 'No deps available to add reaction.' }] };
      }

      // Skip ~15% of reactions to feel more natural
      if (Math.random() < 0.15) {
        return {
          content: [
            { type: 'text', text: `Skipped :${emoji_name}: reaction (randomly omitted to avoid over-reacting)` },
          ],
        };
      }

      try {
        await deps.client.reactions.add({
          channel: deps.channelId,
          timestamp: deps.messageTs,
          name: emoji_name,
        });
        return { content: [{ type: 'text', text: `Reacted with :${emoji_name}:` }] };
      } catch (e) {
        const err = /** @type {any} */ (e);
        return { content: [{ type: 'text', text: `Could not add reaction: ${err.data?.error || err.message}` }] };
      }
    },
  );

  const lookupDecisionsTool = tool(
    'lookup_decisions',
    LOOKUP_DECISIONS_DESCRIPTION,
    {
      query: z
        .string()
        .describe(
          'Space-separated keywords matched against decision statements and rationales. IMPORTANT: include specific product/tech/proper names and synonyms, not just the generic topic word — e.g. for a question about databases pass "database Postgres MongoDB MySQL storage db", for pricing pass "pricing price cost $ seat plan".',
        ),
    },
    async ({ query: q }) => {
      const terms = (q || '')
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 2)
        .map((t) => t.replace(/s$/, '')); // crude singularization: databases → database
      const all = listDecisions({ limit: 200 });
      const textMatches = all.filter((d) => {
        const hay = `${d.statement} ${d.rationale ?? ''}`.toLowerCase();
        return terms.length === 0 ? true : terms.some((t) => hay.includes(t));
      });

      // Permission boundary: private-channel decisions are only returned to a
      // requesting user who is a member of that channel. Without deps we cannot
      // verify membership, so private decisions are withheld.
      const visible = [];
      for (const d of textMatches) {
        if (!d.is_private) {
          visible.push(d);
        } else if (deps?.client && deps.userId && (await canSeeDecision(deps.client, d, deps.userId))) {
          visible.push(d);
        }
        if (visible.length >= 10) break;
      }
      const matches = visible;

      // Real-Time Search augmentation: ALSO query the live workspace via Slack's
      // assistant.search.context using the REQUESTING USER's token (which carries
      // the search:read.* scopes). This surfaces relevant messages that were never
      // captured into our ledger. Entirely fail-open: no user token, an API error,
      // or a timeout → we simply fall back to the ledger-only answer.
      /** @type {import('../consensus-core/rts.js').RtsResult[]} */
      let liveHits = [];
      if (deps?.userToken) {
        const raw = await searchContext(deps.client, {
          query: q,
          token: deps.userToken,
          channelTypes: 'public_channel,private_channel,mpim,im',
          limit: 5,
        });
        // Belt-and-braces permission gate for the requesting user. RTS with the
        // user's own token is already permission-aware, but we independently drop
        // any hit from a private channel the requesting user is not a member of.
        const gated = [];
        for (const h of raw) {
          const looksPrivate = typeof h.channel_id === 'string' && h.channel_id.startsWith('G');
          if (!looksPrivate) {
            gated.push(h);
          } else if (deps.userId && (await isChannelMember(deps.client, h.channel_id || '', deps.userId))) {
            gated.push(h);
          }
        }
        liveHits = gated;
      }

      if (matches.length === 0 && liveHits.length === 0) {
        return {
          content: [{ type: 'text', text: 'No matching decisions found in the ledger or live workspace search.' }],
        };
      }

      const ledgerRendered = matches.map((d) => {
        const where = d.channel_name ? `#${d.channel_name}` : d.channel_id;
        const who = d.decided_by ? `<@${d.decided_by}>` : 'unknown';
        return (
          `• [ledger · ${d.status}] ${d.statement}\n` +
          `  rationale: ${d.rationale ?? '(none given)'}\n` +
          `  decided by ${who} in ${where} on ${d.created_at}\n` +
          `  permalink: ${d.permalink ?? '(none)'}`
        );
      });

      const liveRendered = liveHits.map((h) => {
        const where = h.channel_name ? `#${h.channel_name}` : h.channel_id || 'unknown channel';
        const who = h.author_user_id ? `<@${h.author_user_id}>` : h.author_name || 'unknown';
        return (
          `• [live search] ${h.content}\n` + `  from ${who} in ${where}\n` + `  permalink: ${h.permalink ?? '(none)'}`
        );
      });

      const rendered = [...ledgerRendered, ...liveRendered].join('\n\n');
      return { content: [{ type: 'text', text: rendered }] };
    },
  );

  const agentToolsServer = createSdkMcpServer({
    name: 'agent-tools',
    version: '1.0.0',
    tools: [addEmojiReactionTool, lookupDecisionsTool],
  });

  /** @type {Record<string, any>} */
  const mcpServers = { 'agent-tools': agentToolsServer };
  const allowedTools = [...ALLOWED_TOOLS];

  if (deps?.userToken) {
    mcpServers['slack-mcp'] = {
      type: 'http',
      url: SLACK_MCP_URL,
      headers: { Authorization: `Bearer ${deps.userToken}` },
    };
    allowedTools.push('mcp__slack-mcp__*');
  }

  /** @type {import('@anthropic-ai/claude-agent-sdk').Options} */
  const options = {
    systemPrompt: SYSTEM_PROMPT,
    mcpServers,
    allowedTools,
    permissionMode: 'bypassPermissions',
    ...(sessionId && { resume: sessionId }),
  };

  const responseParts = [];
  let newSessionId = null;

  for await (const message of query({ prompt: text, options })) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          responseParts.push(block.text);
        }
      }
    }
    if (message.type === 'result') {
      newSessionId = message.session_id;
    }
  }

  const responseText = responseParts.join('\n');
  return { responseText, sessionId: newSessionId };
}
