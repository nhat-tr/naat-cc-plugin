#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

const require = createRequire(import.meta.url);
const { AgentConversationDelivery } = require('./agent-conversation-delivery.cjs');
const { SessionStore } = require('./session-store.cjs');
const { activeMetadata, defaultActiveFile } = require('./visual-session.cjs');

const CLAUDE_CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel';
const CLAUDE_CHANNEL_CAPABILITIES = {
  experimental: { 'claude/channel': {} },
  tools: {},
};

const ACK_FEEDBACK_TOOL = {
  name: 'ack_feedback',
  title: 'Acknowledge visual feedback',
  description: 'Confirm that one delivered Visual Companion Feedback Batch was processed and publish its Reply.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      deliveryId: { type: 'string', minLength: 1 },
      message: { type: 'string', minLength: 1, maxLength: 8_000 },
    },
    required: ['deliveryId', 'message'],
  },
  annotations: {
    title: 'Acknowledge visual feedback',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

function configurationError() {
  return new Error('Claude Channel configuration is invalid');
}

function parseArguments(argv) {
  if (argv.length === 0) return { stateDir: null, sessionId: null, conversationId: null };
  const options = {};
  const allowed = new Set(['--session-dir', '--session-id', '--conversation-id']);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || typeof value !== 'string' || !value.trim() || options[flag]) {
      throw configurationError();
    }
    options[flag] = value;
  }
  if (!options['--session-dir'] || !options['--session-id'] || !options['--conversation-id']) {
    throw configurationError();
  }
  const candidate = path.resolve(options['--session-dir']);
  const nestedState = path.join(candidate, 'state');
  const stateDir = fs.existsSync(nestedState) ? nestedState : candidate;
  let stat;
  try {
    stat = fs.lstatSync(stateDir);
  } catch {
    throw configurationError();
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw configurationError();
  return {
    stateDir,
    sessionId: options['--session-id'],
    conversationId: options['--conversation-id'],
  };
}

function activeBinding(activeFile) {
  try {
    const stat = fs.lstatSync(activeFile);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const metadata = activeMetadata({ activeFile });
    if (typeof metadata.state_dir !== 'string' || !metadata.state_dir
      || typeof metadata.session_id !== 'string' || !metadata.session_id) {
      return null;
    }
    return {
      stateDir: metadata.state_dir,
      sessionId: metadata.session_id,
      conversationId: process.env.CLAUDE_SESSION_ID || metadata.session_id,
    };
  } catch {
    return null;
  }
}

function sameBinding(left, right) {
  return left?.stateDir === right?.stateDir
    && left?.sessionId === right?.sessionId
    && left?.conversationId === right?.conversationId;
}

function buildClaudeChannelNotification({ deliveryId, feedbackBatch }) {
  if (typeof deliveryId !== 'string' || !deliveryId
    || !feedbackBatch || typeof feedbackBatch !== 'object'
    || typeof feedbackBatch.id !== 'string'
    || !Number.isInteger(feedbackBatch.seq)) {
    throw new TypeError('Claude Channel delivery is invalid');
  }
  const content = [
    `Visual Companion Feedback Batch ${deliveryId}`,
    `Client turn: ${feedbackBatch.clientTurnId || feedbackBatch.id}`,
    `Event: ${feedbackBatch.id} (sequence ${feedbackBatch.seq})`,
    '',
    feedbackBatch.message || '',
    feedbackBatch.annotations?.length
      ? `\nAnnotations:\n${JSON.stringify(feedbackBatch.annotations, null, 2)}`
      : '',
    feedbackBatch.choices?.length
      ? `\nChoices:\n${JSON.stringify(feedbackBatch.choices, null, 2)}`
      : '',
    '',
    `After processing this delivery once, call ack_feedback with deliveryId ${deliveryId}.`,
  ].filter(value => value !== '').join('\n');
  return {
    method: CLAUDE_CHANNEL_NOTIFICATION_METHOD,
    params: {
      content,
      meta: {
        delivery_id: deliveryId,
        feedback_event_id: feedbackBatch.id,
        feedback_seq: String(feedbackBatch.seq),
      },
    },
  };
}

function parseAckArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.deliveryId !== 'string' || !value.deliveryId.trim()
    || typeof value.message !== 'string' || !value.message.trim()
    || value.message.length > 8_000
    || Object.keys(value).some(key => !['deliveryId', 'message'].includes(key))) {
    throw new McpError(ErrorCode.InvalidParams, 'ack_feedback arguments are invalid');
  }
  return { deliveryId: value.deliveryId, message: value.message };
}

function createClaudeChannelServer({ stateDir, sessionId, conversationId, bindingResolver = null }) {
  const server = new Server(
    { name: 'nhat-dev-toolkit-visual-companion-channel', version: '2.0.0' },
    {
      capabilities: CLAUDE_CHANNEL_CAPABILITIES,
      instructions: 'Process each Visual Companion Feedback Batch once, then call ack_feedback with its delivery ID.',
    },
  );
  const adapter = {
    capability: () => ({ supported: true, reason: null }),
    deliver: async request => {
      await server.notification(buildClaudeChannelNotification(request));
      return { state: 'delivered', reason: null };
    },
  };
  let delivery = null;
  let worker = null;
  let starting = null;
  let active = null;
  let watcher = null;
  let fallback = null;
  let reconcileTail = Promise.resolve();

  const bind = async binding => {
    if (sameBinding(active, binding)) return;
    await worker?.close();
    worker = null;
    delivery = null;
    active = binding;
    if (!binding) return;
    const sessionStore = new SessionStore(binding.stateDir);
    delivery = new AgentConversationDelivery({
      adapters: { claude: adapter },
      sessionStore,
      stateDir: binding.stateDir,
    });
    await delivery.replayUnacknowledged({ runtime: 'claude' });
    worker = await delivery.startWorker({
      runtime: 'claude',
      sessionId: binding.sessionId,
      conversationId: binding.conversationId,
      conversationState: () => 'open',
    });
  };

  const scheduleReconcile = () => {
    if (!bindingResolver) return;
    reconcileTail = reconcileTail
      .then(async () => bind(await bindingResolver()))
      .catch(() => bind(null));
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [ACK_FEEDBACK_TOOL] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (request.params.name !== ACK_FEEDBACK_TOOL.name || request.params.task) {
      throw new McpError(ErrorCode.InvalidParams, 'requested Claude Channel tool is unavailable');
    }
    const args = parseAckArguments(request.params.arguments);
    try {
      if (!delivery) throw new Error('delivery unavailable');
      const reply = await delivery.ackFeedback(args);
      return {
        content: [{ type: 'text', text: `Feedback Batch ${reply.replyTo} acknowledged.` }],
      };
    } catch {
      throw new McpError(ErrorCode.InvalidParams, 'delivery acknowledgement is invalid');
    }
  });

  const startDelivery = async () => {
    if (stateDir) {
      await bind({ stateDir, sessionId, conversationId });
      return;
    }
    if (!bindingResolver) return;
    await bind(await bindingResolver());
    const watchDirectory = bindingResolver.watchDirectory;
    if (watchDirectory) {
      fs.mkdirSync(watchDirectory, { recursive: true, mode: 0o700 });
      try {
        watcher = fs.watch(watchDirectory, scheduleReconcile);
        watcher.once('error', scheduleReconcile);
      } catch {
        watcher = null;
      }
    }
    fallback = setInterval(scheduleReconcile, 1_000);
    fallback.unref?.();
  };
  server.oninitialized = () => {
    if (!starting) starting = startDelivery();
    void starting.catch(() => {});
  };

  return {
    get delivery() { return delivery; },
    server,
    close: async () => {
      if (fallback) clearInterval(fallback);
      try { watcher?.close(); } catch { /* already closed */ }
      await reconcileTail;
      await worker?.close();
      await server.close();
    },
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  let bindingResolver = null;
  if (!options.stateDir) {
    const activeFile = defaultActiveFile({
      projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    });
    bindingResolver = async () => activeBinding(activeFile);
    bindingResolver.watchDirectory = path.dirname(activeFile);
  }
  const channel = createClaudeChannelServer({ ...options, bindingResolver });
  const transport = new StdioServerTransport();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await channel.close();
  };
  process.stdin.once('end', () => { void close(); });
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  await channel.server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('Claude Channel failed\n');
    process.exitCode = 1;
  });
}

export {
  ACK_FEEDBACK_TOOL,
  CLAUDE_CHANNEL_CAPABILITIES,
  CLAUDE_CHANNEL_NOTIFICATION_METHOD,
  buildClaudeChannelNotification,
  createClaudeChannelServer,
};
