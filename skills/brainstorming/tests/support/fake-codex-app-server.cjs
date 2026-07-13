#!/usr/bin/env node

const fs = require('node:fs');
const readline = require('node:readline');

const logFile = process.env.FAKE_CODEX_LOG_FILE;
const controlFile = process.env.FAKE_CODEX_CONTROL_FILE;

if (!logFile || !controlFile) {
  process.stderr.write('fake Codex App Server configuration is invalid\n');
  process.exit(2);
}

let initializeSeen = false;
let initializedSeen = false;
let resumedThread = null;
let resumedState = null;
let nextTurn = 0;

function appendLog(entry) {
  fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function send(message) {
  appendLog({ direction: 'server-to-client', message });
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function error(id, code, message) {
  send({ id, error: { code, message } });
}

function readControl() {
  try {
    const parsed = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
    return {
      available: parsed.available !== false,
      activeFlags: Array.isArray(parsed.activeFlags) ? parsed.activeFlags : ['waitingOnUserInput'],
      exit: parsed.exit === true,
      threadState: typeof parsed.threadState === 'string' ? parsed.threadState : 'idle',
    };
  } catch {
    return { available: false, activeFlags: [], exit: false, threadState: 'systemError' };
  }
}

function validInitialize(message) {
  const clientInfo = message.params?.clientInfo;
  return message.id !== undefined
    && clientInfo && typeof clientInfo === 'object' && !Array.isArray(clientInfo)
    && typeof clientInfo.name === 'string' && clientInfo.name.length > 0
    && typeof clientInfo.version === 'string' && clientInfo.version.length > 0;
}

function validTurnStart(message) {
  const params = message.params;
  return params && typeof params === 'object' && !Array.isArray(params)
    && typeof params.threadId === 'string' && params.threadId.length > 0
    && typeof params.clientUserMessageId === 'string' && params.clientUserMessageId.length > 0
    && Array.isArray(params.input) && params.input.length === 1
    && params.input[0]?.type === 'text' && typeof params.input[0].text === 'string';
}

function handle(message) {
  appendLog({ direction: 'client-to-server', message });

  if (message.method === 'initialize') {
    if (!validInitialize(message)) {
      error(message.id, -32602, 'Invalid initialize params');
      return;
    }
    if (initializeSeen) {
      error(message.id, -32000, 'Already initialized');
      return;
    }
    initializeSeen = true;
    send({
      id: message.id,
      result: {
        codexHome: '/fake/codex-home',
        userAgent: 'fake-codex-app-server/1.0.0',
        platformFamily: 'unix',
        platformOs: 'test',
      },
    });
    return;
  }

  if (message.method === 'initialized' && message.id === undefined) {
    if (!initializeSeen || (message.params !== undefined
      && (!message.params || typeof message.params !== 'object'
        || Array.isArray(message.params) || Object.keys(message.params).length !== 0))) return;
    initializedSeen = true;
    return;
  }

  if (!initializeSeen || !initializedSeen) {
    error(message.id, -32000, 'Not initialized');
    return;
  }

  const control = readControl();
  if (control.exit) process.exit(17);
  if (!control.available) {
    error(message.id, -32001, 'Codex App Server unavailable');
    return;
  }

  if (message.method === 'thread/resume') {
    if (typeof message.params?.threadId !== 'string' || message.params.threadId.length === 0) {
      error(message.id, -32602, 'Invalid thread/resume params');
      return;
    }
    resumedThread = message.params?.threadId ?? null;
    resumedState = control.threadState;
    const status = resumedState === 'active'
      ? { type: resumedState, activeFlags: control.activeFlags }
      : { type: resumedState };
    send({
      id: message.id,
      result: {
        thread: {
          cliVersion: '0.144.1',
          createdAt: 1_725_000_000,
          cwd: '/fake/workspace',
          ephemeral: false,
          id: resumedThread,
          modelProvider: 'openai',
          preview: '',
          sessionId: resumedThread,
          source: 'appServer',
          status,
          turns: [],
          updatedAt: 1_725_000_000,
        },
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        cwd: '/fake/workspace',
        instructionSources: [],
        model: 'gpt-5.4',
        modelProvider: 'openai',
        reasoningEffort: null,
        sandbox: { type: 'readOnly', networkAccess: false },
        serviceTier: null,
      },
    });
    return;
  }

  if (message.method === 'turn/start') {
    if (!validTurnStart(message)) {
      error(message.id, -32602, 'Invalid turn/start params');
      return;
    }
    if (message.params?.threadId !== resumedThread || resumedState !== 'idle') {
      error(message.id, -32002, 'Thread is not idle');
      return;
    }
    nextTurn += 1;
    send({
      id: message.id,
      result: {
        turn: {
          id: `fake-turn-${nextTurn}`,
          status: 'inProgress',
          items: [],
          error: null,
        },
      },
    });
    return;
  }

  error(message.id, -32601, 'Method not found');
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch {
    send({ id: null, error: { code: -32700, message: 'Parse error' } });
  }
});
