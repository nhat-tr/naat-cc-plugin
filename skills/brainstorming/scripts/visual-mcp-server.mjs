#!/usr/bin/env node

import process from 'node:process';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

const TOOL_NAME = 'wait_for_feedback';
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

const FEEDBACK_BATCH_SCHEMA = {
  type: 'object',
  description: 'The oldest unacknowledged durable Feedback Batch from the Session Store.',
  properties: {
    version: { type: 'integer', minimum: 1 },
    id: { type: 'string', minLength: 1 },
    seq: { type: 'integer', minimum: 1 },
    timestamp: { type: 'number' },
    type: { const: 'user.turn' },
    role: { const: 'user' },
    clientTurnId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    message: { type: 'string' },
    annotations: { type: 'array', items: { type: 'object' } },
    choices: { type: 'array', items: { type: 'object' } },
    screen: { anyOf: [{ type: 'object' }, { type: 'null' }] },
  },
  required: ['seq', 'type', 'role', 'message', 'annotations', 'choices'],
  additionalProperties: true,
};

const INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    timeoutMs: {
      type: 'integer',
      minimum: 0,
      maximum: MAX_TIMEOUT_MS,
      default: DEFAULT_TIMEOUT_MS,
      description: 'Maximum review-window wait in milliseconds before returning timeout.',
    },
  },
};

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    state: {
      type: 'string',
      enum: ['delivered', 'timeout', 'closed'],
      description: 'Observed outcome of this active Wait.',
    },
    feedbackBatch: {
      anyOf: [FEEDBACK_BATCH_SCHEMA, { type: 'null' }],
    },
    pending: {
      type: 'integer',
      minimum: 0,
      description: 'Unacknowledged Feedback Batches remaining, including the delivered batch.',
    },
    reason: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'Safe closure reason, or null when no reason applies.',
    },
  },
  required: ['state', 'feedbackBatch', 'pending', 'reason'],
};

const WAIT_TOOL = {
  name: TOOL_NAME,
  title: 'Wait for visual feedback',
  description: 'Wait for and return the oldest durable Feedback Batch without acknowledging it or polling.',
  inputSchema: INPUT_SCHEMA,
  outputSchema: OUTPUT_SCHEMA,
  annotations: {
    title: 'Wait for visual feedback',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  execution: { taskSupport: 'forbidden' },
};

function configurationError() {
  return new Error('visual MCP server configuration is invalid');
}

function parseArguments(argv) {
  if (argv.length === 0) return { sessionDir: null };
  let sessionDir = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--session-dir' || sessionDir !== null || index + 1 >= argv.length) {
      throw configurationError();
    }
    const candidate = argv[index + 1];
    if (typeof candidate !== 'string' || candidate.trim() === '') throw configurationError();
    sessionDir = candidate;
    index += 1;
  }
  return { sessionDir };
}

async function resolveActiveSessionDir() {
  try {
    const visualSession = await import('./visual-session.cjs');
    const metadata = visualSession.activeMetadata({
      projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    });
    return metadata.session_dir;
  } catch {
    return null;
  }
}

function parseTimeout(argumentsValue) {
  if (argumentsValue == null) return DEFAULT_TIMEOUT_MS;
  if (typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
    throw new McpError(ErrorCode.InvalidParams, 'wait_for_feedback arguments are invalid');
  }
  const keys = Object.keys(argumentsValue);
  if (keys.some(key => key !== 'timeoutMs')) {
    throw new McpError(ErrorCode.InvalidParams, 'wait_for_feedback arguments are invalid');
  }
  const timeoutMs = argumentsValue.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new McpError(ErrorCode.InvalidParams, 'wait_for_feedback arguments are invalid');
  }
  return timeoutMs;
}

function normalizeDeliveryResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new McpError(ErrorCode.InternalError, 'wait_for_feedback failed');
  }
  const { state, feedbackBatch, pending, reason } = value;
  if (!['delivered', 'timeout', 'closed'].includes(state)
    || !Number.isInteger(pending) || pending < 0
    || (reason !== null && typeof reason !== 'string')
    || (feedbackBatch !== null && (typeof feedbackBatch !== 'object' || Array.isArray(feedbackBatch)))
    || (state === 'delivered' && feedbackBatch === null)
    || (state !== 'delivered' && feedbackBatch !== null)) {
    throw new McpError(ErrorCode.InternalError, 'wait_for_feedback failed');
  }
  return { state, feedbackBatch, pending, reason };
}

function modelReadableResult(value) {
  if (value.state === 'delivered') {
    return `Oldest durable Feedback Batch delivered; ${value.pending} pending.\n${JSON.stringify(value.feedbackBatch, null, 2)}`;
  }
  if (value.state === 'closed') return `Visual Session delivery is closed${value.reason ? `: ${value.reason}` : '.'}`;
  return 'No Feedback Batch arrived before the configured review-window timeout.';
}

async function createVisualMcpServer({ sessionDir, waitForFeedback }) {
  const server = new Server(
    { name: 'nhat-dev-toolkit-visual-companion', version: '2.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [WAIT_TOOL] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name !== TOOL_NAME || request.params.task) {
      throw new McpError(ErrorCode.InvalidParams, 'requested visual MCP tool is unavailable');
    }
    const timeoutMs = parseTimeout(request.params.arguments);
    let result;
    try {
      result = await waitForFeedback({ sessionDir, timeoutMs, signal: extra.signal });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      if (error instanceof McpError) throw error;
      throw new McpError(ErrorCode.InternalError, 'wait_for_feedback failed');
    }
    const structuredContent = normalizeDeliveryResult(result);
    return {
      content: [{ type: 'text', text: modelReadableResult(structuredContent) }],
      structuredContent,
    };
  });

  return server;
}

async function main() {
  const { sessionDir } = parseArguments(process.argv.slice(2));
  const deliveryCore = await import('./delivery-core.cjs');
  if (typeof deliveryCore.waitForFeedback !== 'function') throw configurationError();
  const server = await createVisualMcpServer({
    sessionDir,
    waitForFeedback: async options => {
      const activeSessionDir = sessionDir || await resolveActiveSessionDir();
      if (!activeSessionDir) {
        return {
          state: 'closed',
          feedbackBatch: null,
          pending: 0,
          reason: 'no active Visual Session',
        };
      }
      return deliveryCore.waitForFeedback({ ...options, sessionDir: activeSessionDir });
    },
  });
  const transport = new StdioServerTransport();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.close();
  };
  process.stdin.once('end', () => { void close(); });
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  await server.connect(transport);
}

main().catch(() => {
  process.stderr.write('visual MCP server failed\n');
  process.exitCode = 1;
});
