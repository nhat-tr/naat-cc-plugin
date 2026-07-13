const childProcess = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 1_500;

function timeoutError(label) {
  const error = new Error(`timed out waiting for ${label}`);
  error.code = 'FAKE_CLAUDE_TIMEOUT';
  return error;
}

class FakeClaudeChannelPeer {
  constructor(options) {
    if (!options?.command) throw new TypeError('command is required');
    this.options = options;
    this.supported = options.supported !== false;
    this.allowlisted = options.allowlisted !== false;
    this.orderingGuaranteed = options.orderingGuaranteed !== false;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.nextId = 0;
    this.pending = new Map();
    this.notifications = [];
    this.notificationWaiters = [];
    this.stderr = '';
    this.stdoutBuffer = '';
    this.closed = false;
    this.initialized = false;
    this.exit = null;
  }

  capability() {
    if (!this.initialized) return { supported: false, reason: 'channel_not_initialized' };
    const declared = this.serverCapabilities?.experimental?.['claude/channel'];
    if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
      return { supported: false, reason: 'channel_unsupported' };
    }
    if (!this.supported) return { supported: false, reason: 'channel_unsupported' };
    if (!this.allowlisted) return { supported: false, reason: 'channel_not_allowlisted' };
    if (!this.orderingGuaranteed) return { supported: false, reason: 'ordering_uncertain' };
    return { supported: true, reason: null };
  }

  async connect() {
    if (this.child) throw new Error('fake Claude peer is already connected');

    this.child = childProcess.spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exit = new Promise(resolve => {
      this.child.once('close', (code, signal) => {
        this.closed = true;
        const error = new Error(`Claude Channel peer closed (${code ?? signal ?? 'unknown'})`);
        error.code = 'CLAUDE_CHANNEL_CLOSED';
        for (const { reject, timer } of this.pending.values()) {
          clearTimeout(timer);
          reject(error);
        }
        this.pending.clear();
        for (const waiter of this.notificationWaiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
        resolve({ code, signal });
      });
    });
    this.child.stderr.on('data', chunk => { this.stderr += chunk.toString('utf8'); });
    this.child.stdout.on('data', chunk => this.#read(chunk));
    await new Promise((resolve, reject) => {
      this.child.once('spawn', resolve);
      this.child.once('error', reject);
    });

    const initialized = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'fake-claude-channel-peer', version: '1.0.0' },
    });
    await this.notify('notifications/initialized', {});
    this.serverInfo = initialized.serverInfo;
    this.serverCapabilities = initialized.capabilities;
    this.initialized = true;
    return initialized;
  }

  #read(chunk) {
    this.stdoutBuffer += chunk.toString('utf8');
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/u, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.#fail(new Error('Claude Channel emitted malformed JSON'));
        continue;
      }
      this.#handle(message);
    }
  }

  #handle(message) {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || 'Claude Channel request failed');
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== 'string' || message.id !== undefined) return;
    const matchingIndex = this.notificationWaiters.findIndex(waiter => (
      waiter.method === message.method && waiter.predicate(message.params)
    ));
    if (matchingIndex >= 0) {
      const [waiter] = this.notificationWaiters.splice(matchingIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      this.notifications.push(message);
    }
  }

  #fail(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  #write(message) {
    if (!this.child?.stdin || this.closed) throw new Error('fake Claude peer is not connected');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = this.timeoutMs) {
    this.nextId += 1;
    const id = this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(timeoutError(method));
      }, timeoutMs);
      this.pending.set(id, { reject, resolve, timer });
      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async notify(method, params = {}) {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  waitForNotification(method, predicate = () => true, timeoutMs = this.timeoutMs) {
    const index = this.notifications.findIndex(message => (
      message.method === method && predicate(message.params)
    ));
    if (index >= 0) return Promise.resolve(this.notifications.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { method, predicate, reject, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const waiterIndex = this.notificationWaiters.indexOf(waiter);
        if (waiterIndex >= 0) this.notificationWaiters.splice(waiterIndex, 1);
        reject(timeoutError(method));
      }, timeoutMs);
      this.notificationWaiters.push(waiter);
    });
  }

  listTools() {
    return this.request('tools/list');
  }

  callTool(name, args) {
    return this.request('tools/call', { name, arguments: args });
  }

  async crash() {
    if (!this.child || this.closed) return;
    this.child.kill('SIGKILL');
    await this.exit;
  }

  async close() {
    if (!this.child || this.closed) return;
    this.child.stdin.end();
    const closed = await Promise.race([
      this.exit.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 300)),
    ]);
    if (!closed && !this.closed) {
      this.child.kill('SIGTERM');
      await Promise.race([
        this.exit,
        new Promise(resolve => setTimeout(resolve, 500)),
      ]);
    }
    if (!this.closed) this.child.kill('SIGKILL');
  }
}

module.exports = { FakeClaudeChannelPeer };
