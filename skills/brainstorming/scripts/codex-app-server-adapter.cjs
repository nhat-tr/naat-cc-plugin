const childProcess = require('node:child_process');
const readline = require('node:readline');

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
  return value;
}

function safeThreadStatus(value) {
  const type = value?.thread?.status?.type;
  return ['idle', 'active', 'notLoaded', 'systemError'].includes(type) ? type : 'systemError';
}

function feedbackText(request) {
  const batch = request.feedbackBatch;
  return [
    `Visual Companion Feedback Batch ${request.deliveryId}`,
    `Client turn: ${batch.clientTurnId || batch.id}`,
    `Event: ${batch.id} (sequence ${batch.seq})`,
    '',
    batch.message || '',
    batch.annotations?.length ? `\nAnnotations:\n${JSON.stringify(batch.annotations, null, 2)}` : '',
    batch.choices?.length ? `\nChoices:\n${JSON.stringify(batch.choices, null, 2)}` : '',
    '',
    'Process this delivery once. The stable delivery ID identifies retries of the same Feedback Batch.',
  ].filter(value => value !== '').join('\n');
}

class CodexAppServerClient {
  constructor(options = {}) {
    this.command = options.command || 'codex';
    this.args = options.args || ['app-server'];
    this.cwd = options.cwd || process.cwd();
    this.env = options.env ? { ...process.env, ...options.env } : process.env;
    this.spawn = options.spawn || childProcess.spawn;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1) {
      throw new TypeError('requestTimeoutMs must be a positive integer');
    }
    this.nextId = 0;
    this.pending = new Map();
    this.started = null;
    this.closed = false;
  }

  async start() {
    if (this.started) return this.started;
    this.started = this._start();
    return this.started;
  }

  async _start() {
    if (this.closed) throw new Error('Codex App Server client is closed');
    this.child = this.spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      this.child.once('spawn', resolve);
      this.child.once('error', reject);
    });
    this.lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on('line', line => this._handleLine(line));
    this.child.stderr.on('data', () => {});
    this.child.once('close', () => {
      const error = new Error('Codex App Server connection closed');
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
    await this._requestStarted('initialize', {
      clientInfo: { name: 'nhat-dev-toolkit-visual-companion', version: '2.0.0' },
      capabilities: { experimentalApi: false },
    });
    this._send({ method: 'initialized' });
  }

  _handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      const error = new Error('Codex App Server request failed');
      error.code = message.error.code;
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
  }

  _send(message) {
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      throw new Error('Codex App Server connection is unavailable');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _requestStarted(method, params) {
    this.nextId += 1;
    const id = this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex App Server request timed out'));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async request(method, params) {
    await this.start();
    return this._requestStarted(method, params);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.lines?.close();
    const child = this.child;
    if (!child) return;
    const exited = new Promise(resolve => child.once('close', resolve));
    try { child.stdin?.end(); } catch { /* already closed */ }
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 300)),
    ]);
    if (!graceful && child.exitCode === null) child.kill('SIGTERM');
    const terminated = await Promise.race([
      exited.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 500)),
    ]);
    if (!terminated && child.exitCode === null) child.kill('SIGKILL');
  }
}

class CodexAppServerAdapter {
  constructor(options = {}) {
    if (typeof options.request === 'function') {
      this.request = options.request;
      this.client = null;
    } else {
      this.client = new CodexAppServerClient(options);
      this.request = this.client.request.bind(this.client);
    }
  }

  capability() {
    return { supported: true, reason: null };
  }

  async deliver(request) {
    const deliveryId = requiredString(request?.deliveryId, 'deliveryId');
    const threadId = requiredString(request?.threadId || request?.conversationId, 'threadId');
    if (!request?.feedbackBatch || typeof request.feedbackBatch !== 'object') {
      throw new TypeError('feedbackBatch is required');
    }
    const resumed = await this.request('thread/resume', { threadId });
    const status = safeThreadStatus(resumed);
    if (status !== 'idle') {
      return { state: 'queued', reason: `thread ${status}` };
    }
    const started = await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: feedbackText({ ...request, deliveryId }) }],
      clientUserMessageId: deliveryId,
    });
    if (typeof started?.turn?.id !== 'string' || !started.turn.id) {
      throw new Error('Codex App Server turn start failed');
    }
    return { state: 'delivered', reason: null };
  }

  close() {
    return this.client?.close() || Promise.resolve();
  }
}

module.exports = {
  CodexAppServerAdapter,
  CodexAppServerClient,
};
