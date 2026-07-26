const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { redactString } = require('./pair-state');

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 4 * 1024;
const MAX_INITIAL_INTENT_BYTES = 1536;
const MAX_RECENT_DIRECTION_BYTES = 768;
const MAX_RECENT_USER_DIRECTIONS = 3;
const MAX_ASSISTANT_FINDINGS = 4;
const MAX_EXPLICIT_CORE_ANCHOR_BYTES = 2600;
const MAX_EXPLICIT_ANCHOR_DIRECTION_BYTES = 640;
const MAX_EXPLICIT_ANCHOR_DIRECTIONS = 2;
const SYSTEM_INJECTED_BLOCK = /(?:<permissions instructions>|<environment_context>|<system-reminder>|<local-command|<command-name>|<user-prompt-submit-hook>)/iu;
const CORE_ANCHOR_HEADING = /(?:^|\n)\s*(?:#{1,6}\s*)?\*{0,2}Core Anchor(?:\s+for\b[^\n:]*)?\*{0,2}\s*:?\s*(?:\n|$)/iu;
const CORE_ANCHOR_SECTION_GROUPS = [
  ['Purpose', 'Goal'],
  ['Rejection Criteria', 'Constraints', 'Evidence Rule'],
  ['Contrasts', 'Non-goals', 'Non goals'],
];

function truncateUtf8(value, maximum) {
  let result = '';
  let bytes = 0;
  for (const character of String(value || '')) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maximum) break;
    result += character;
    bytes += size;
  }
  return result;
}

function safeMessageText(value, maximum = MAX_MESSAGE_BYTES) {
  if (typeof value !== 'string') return '';
  const normalized = value.replaceAll('\0', '').replace(/\r\n?/gu, '\n').trim();
  if (!normalized) return '';
  return truncateUtf8(redactString(normalized), maximum).trim();
}

function readTranscript(transcriptPath) {
  if (!path.isAbsolute(String(transcriptPath || ''))) {
    throw new Error('Agent Conversation transcript path must be absolute');
  }
  const stat = fs.lstatSync(transcriptPath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Agent Conversation transcript must be a regular file');
  }
  if (stat.size > MAX_TRANSCRIPT_BYTES) {
    throw new Error(`Agent Conversation transcript exceeds ${MAX_TRANSCRIPT_BYTES} bytes`);
  }
  const entries = [];
  for (const line of fs.readFileSync(transcriptPath, 'utf8').split(/\r?\n/u).filter(Boolean)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error('Agent Conversation transcript contains malformed JSONL');
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) entries.push(entry);
  }
  return entries;
}

function addMessage(messages, role, text, timestamp) {
  const safe = safeMessageText(text);
  if (!safe) return;
  const previous = messages.at(-1);
  if (previous?.role === role && previous.text === safe) return;
  messages.push({ role, text: safe, timestamp: typeof timestamp === 'string' ? timestamp : null });
}

function parseToolArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function collectCandidatePaths(value, candidates) {
  if (!value) return;
  if (typeof value === 'string') {
    for (const match of value.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu)) {
      candidates.push(match[1].trim());
    }
    for (const match of value.matchAll(/\\n\*\*\* (?:Add|Update|Delete) File: ([^\\\r\n"]+)/gu)) {
      candidates.push(match[1].trim());
    }
    return;
  }
  if (typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of ['file_path', 'filepath', 'path']) {
    if (typeof value[key] === 'string') candidates.push(value[key]);
  }
}

function parseCodex(entries, expectedSessionId) {
  const messages = [];
  const candidatePaths = [];
  const sessionIds = new Set();
  for (const entry of entries) {
    const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
    if (entry.type === 'session_meta' && typeof payload.id === 'string') sessionIds.add(payload.id);
    if (entry.type === 'event_msg' && payload.type === 'user_message') {
      addMessage(messages, 'user', payload.message, entry.timestamp);
    } else if (entry.type === 'event_msg' && payload.type === 'agent_message') {
      addMessage(messages, 'assistant', payload.message, entry.timestamp);
    } else if (entry.type === 'response_item' && payload.type === 'function_call') {
      collectCandidatePaths(parseToolArguments(payload.arguments), candidatePaths);
    } else if (entry.type === 'response_item' && payload.type === 'custom_tool_call') {
      collectCandidatePaths(payload.input, candidatePaths);
    }
  }
  assertSessionIdentity(sessionIds, expectedSessionId);
  return { messages, candidatePaths };
}

function textBlocks(content, excludeSystemInjected = false) {
  if (typeof content === 'string') {
    return excludeSystemInjected && SYSTEM_INJECTED_BLOCK.test(content) ? [] : [content];
  }
  if (!Array.isArray(content)) return [];
  return content
    .filter(block => (
      block &&
      typeof block === 'object' &&
      block.type === 'text' &&
      typeof block.text === 'string' &&
      (!excludeSystemInjected || !SYSTEM_INJECTED_BLOCK.test(block.text))
    ))
    .map(block => block.text);
}

function parseClaude(entries, expectedSessionId) {
  const messages = [];
  const candidatePaths = [];
  const sessionIds = new Set();
  const lastAssistantIndex = new Map();
  const assistantBlocks = new Map();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (typeof entry.sessionId === 'string') sessionIds.add(entry.sessionId);
    const messageId = entry.type === 'assistant' ? entry.message?.id : null;
    if (!messageId) continue;
    lastAssistantIndex.set(messageId, index);
    const existing = assistantBlocks.get(messageId) || [];
    const content = Array.isArray(entry.message?.content) ? entry.message.content : [];
    assistantBlocks.set(messageId, [...existing, ...content]);
  }
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.isMeta || !entry.message) continue;
    if (entry.type === 'user') {
      const combined = textBlocks(entry.message.content, true).map(text => safeMessageText(text)).filter(Boolean).join('\n');
      addMessage(messages, 'user', combined, entry.timestamp);
      continue;
    }
    if (entry.type !== 'assistant') continue;
    const messageId = entry.message.id;
    if (messageId && lastAssistantIndex.get(messageId) !== index) continue;
    const blocks = messageId ? assistantBlocks.get(messageId) || [] : (Array.isArray(entry.message.content) ? entry.message.content : []);
    const combined = textBlocks(blocks).map(text => safeMessageText(text)).filter(Boolean).join('\n');
    addMessage(messages, 'assistant', combined, entry.timestamp);
    for (const block of blocks) {
      if (block?.type === 'tool_use') collectCandidatePaths(block.input, candidatePaths);
    }
  }
  assertSessionIdentity(sessionIds, expectedSessionId);
  return { messages, candidatePaths };
}

function assertSessionIdentity(sessionIds, expectedSessionId) {
  if (sessionIds.size !== 1 || !sessionIds.has(expectedSessionId)) {
    throw new Error('Agent Conversation transcript does not match the active Agent Conversation');
  }
}

function fileArtifact(root, candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  const rootReal = fs.realpathSync(root);
  const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  if (!relative || relative === '..' || relative.startsWith('../')) return null;
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return null;
  const real = fs.realpathSync(absolute);
  if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) return null;
  return {
    path: relative,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(real)).digest('hex'),
  };
}

function artifactsFromCandidates(root, candidates) {
  const artifacts = new Map();
  for (const candidate of candidates) {
    const artifact = fileArtifact(root, candidate);
    if (artifact) artifacts.set(artifact.path, artifact);
  }
  return [...artifacts.values()];
}

function explicitCoreAnchorFrom(messages) {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'assistant') continue;
    const heading = message.text.match(CORE_ANCHOR_HEADING);
    if (!heading) continue;
    const candidate = message.text.slice((heading.index || 0) + (heading[0].startsWith('\n') ? 1 : 0));
    const hasAllSections = CORE_ANCHOR_SECTION_GROUPS.every(group => group.some(section => new RegExp(
      `(?:^|\\n)\\s*(?:[-*]\\s*)?(?:#{1,6}\\s*)?\\*{0,2}${section}\\*{0,2}\\s*(?::|\\n|$)`,
      'iu',
    ).test(candidate)));
    if (hasAllSections) return truncateUtf8(candidate, MAX_EXPLICIT_CORE_ANCHOR_BYTES).trim();
  }
  return '';
}

function isPathOnlyUserMessage(message) {
  const value = String(message?.text || '').trim();
  if (!value || /\s/u.test(value)) return false;
  return value.endsWith('/') ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('~/') ||
    value.includes('/');
}

function coreAnchorFrom(messages) {
  const userMessages = messages.filter(message => message.role === 'user');
  const semanticUserMessages = userMessages.filter(message => !isPathOnlyUserMessage(message));
  const anchorUserMessages = semanticUserMessages.length ? semanticUserMessages : userMessages;
  const initial = anchorUserMessages[0];
  if (!initial) return '';
  const explicit = explicitCoreAnchorFrom(messages);
  if (explicit) {
    const recent = anchorUserMessages
      .slice(-MAX_EXPLICIT_ANCHOR_DIRECTIONS)
      .map(message => truncateUtf8(message.text, MAX_EXPLICIT_ANCHOR_DIRECTION_BYTES));
    return truncateUtf8([
      `Latest explicit Core Anchor:\n${explicit}`,
      `Recent explicit user direction:\n${recent.map(text => `- ${text}`).join('\n')}`,
    ].join('\n\n'), MAX_MESSAGE_BYTES).trim();
  }
  const recent = anchorUserMessages
    .slice(1)
    .slice(-MAX_RECENT_USER_DIRECTIONS)
    .map(message => truncateUtf8(message.text, MAX_RECENT_DIRECTION_BYTES));
  const sections = [`Initial user intent:\n${truncateUtf8(initial.text, MAX_INITIAL_INTENT_BYTES)}`];
  if (recent.length) sections.push(`Recent user direction:\n${recent.map(text => `- ${text}`).join('\n')}`);
  return sections.join('\n\n');
}

function checkpointFromMessages(messages, artifacts) {
  const assistantMessages = messages.filter(message => message.role === 'assistant');
  const userMessages = messages.filter(message => message.role === 'user');
  const latestAssistant = assistantMessages.at(-1)?.text || '';
  const latestUser = userMessages.at(-1)?.text || '';
  const latestMessage = messages.at(-1);
  const assistantHasLatestState = latestMessage?.role === 'assistant' && latestAssistant;
  let nextAction = 'Review the recovered checkpoint before continuing.';
  if (assistantHasLatestState) {
    nextAction = [
      `Continue from the latest recorded assistant state: ${latestAssistant}`,
      ...(latestUser ? [`Latest explicit user direction being handled: ${latestUser}`] : []),
    ].join('\n');
  } else if (latestUser) {
    nextAction = `Continue from the latest explicit user direction: ${latestUser}`;
  }
  const findings = assistantMessages.slice(-MAX_ASSISTANT_FINDINGS).map(message => ({
    finding: message.text,
    reference: message.timestamp
      ? `Recovered assistant conclusion at ${message.timestamp}; verify against repository or runtime evidence.`
      : 'Recovered assistant conclusion; verify against repository or runtime evidence.',
    digest: crypto.createHash('sha256').update(message.text).digest('hex'),
  }));
  return {
    coreAnchor: coreAnchorFrom(messages),
    findings,
    confirmedChoices: [],
    rejectedAlternatives: [],
    currentDirection: assistantHasLatestState
      ? `Latest recorded assistant state:\n${latestAssistant}`
      : `Latest explicit user direction:\n${latestUser}`,
    unresolvedDecisions: latestMessage?.role === 'user' && latestUser
      ? [`Latest unanswered user direction: ${latestUser}`]
      : [],
    nextAction,
    artifacts,
  };
}

function recoverAgentConversationCheckpoint(input) {
  const root = path.resolve(String(input?.root || ''));
  const runtime = String(input?.runtime || '').toLowerCase();
  const agentConversationId = String(input?.agentConversationId || '').trim();
  if (!['codex', 'claude'].includes(runtime)) throw new Error('Agent Conversation runtime must be codex or claude');
  if (!agentConversationId) throw new Error('Agent Conversation requires an identity');
  const entries = readTranscript(input?.transcriptPath);
  const parsed = runtime === 'codex'
    ? parseCodex(entries, agentConversationId)
    : parseClaude(entries, agentConversationId);
  if (!parsed.messages.some(message => message.role === 'user')) {
    throw new Error('Agent Conversation transcript has no recoverable user direction');
  }
  const artifacts = artifactsFromCandidates(root, parsed.candidatePaths);
  const sourceDigest = crypto.createHash('sha256').update(JSON.stringify({
    messages: parsed.messages,
    artifacts,
  })).digest('hex');
  const latestUserDirection = parsed.messages.filter(message => message.role === 'user').at(-1)?.text || '';
  return {
    checkpoint: checkpointFromMessages(parsed.messages, artifacts),
    sourceDigest,
    messageCount: parsed.messages.length,
    lastMessageAt: parsed.messages.at(-1)?.timestamp || null,
    latestUserDirection,
  };
}

module.exports = {
  MAX_TRANSCRIPT_BYTES,
  recoverAgentConversationCheckpoint,
};
