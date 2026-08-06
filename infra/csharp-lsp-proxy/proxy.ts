#!/usr/bin/env node
// LSP stdio proxy for csharp-ls.
//
// Claude Code's LSP client does not answer three standard server->client
// requests (claude-plugins-official#1359); the third one aborts csharp-ls
// solution loading. This proxy sits between Claude Code and csharp-ls,
// answers those three requests locally, and forwards everything else
// byte-for-byte.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

interface InterceptEntry {
  handle: (params: unknown) => unknown;
  // Capability to advertise in `initialize` so the server believes the
  // client can handle this request on its own (see the WHY comment below).
  // `client/registerCapability` has no corresponding capability flag.
  advertise?: (caps: Record<string, any>) => void;
}

const INTERCEPT: Record<string, InterceptEntry> = {
  'client/registerCapability': {
    handle: () => null,
  },
  'workspace/configuration': {
    handle: (params) =>
      ((params as { items?: unknown[] } | undefined)?.items ?? []).map(() => null),
    advertise: (caps) => {
      (caps.workspace ??= {}).configuration = true;
    },
  },
  'window/workDoneProgress/create': {
    handle: () => null,
    advertise: (caps) => {
      (caps.window ??= {}).workDoneProgress = true;
    },
  },
};

const globalToolPath = path.join(homedir(), '.dotnet', 'tools', 'csharp-ls');
const serverBin = existsSync(globalToolPath) ? globalToolPath : 'csharp-ls';

const server = spawn(serverBin, process.argv.slice(2), {
  stdio: ['pipe', 'pipe', 'inherit'],
});
server.on('error', (err) => {
  process.stderr.write(`csharp-lsp-proxy: failed to start ${serverBin}: ${err.message}\n`);
  process.exit(1);
});
server.on('exit', (code) => process.exit(code ?? 1));

function writeMessage(stream: NodeJS.WritableStream, msg: unknown): void {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  stream.write(`Content-Length: ${body.length}\r\n\r\n`);
  stream.write(body);
}

const CONTENT_LENGTH_RE = /Content-Length: *(\d+)/i;

// Shared Content-Length framing parser for both directions. Body bytes are
// buffered in `bodyChunks` (no copying) as they arrive; only once enough
// bytes are present is a single Buffer.concat done to materialize the frame.
// This keeps a large frame spread across many stream chunks linear instead
// of quadratic.
function createFrameParser(
  onFrame: (body: Buffer, frame: Buffer) => void,
): (chunk: Buffer) => void {
  let headerAcc = Buffer.alloc(0);
  let headerFrame = Buffer.alloc(0);
  let bodyChunks: Buffer[] = [];
  let bodySize = 0;
  let bodyNeeded = -1;

  return function onChunk(chunk: Buffer): void {
    if (bodyNeeded === -1) {
      headerAcc = Buffer.concat([headerAcc, chunk]);
    } else {
      bodyChunks.push(chunk);
      bodySize += chunk.length;
    }

    while (true) {
      if (bodyNeeded === -1) {
        const headerEnd = headerAcc.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          return;
        }
        const header = headerAcc.subarray(0, headerEnd).toString('ascii');
        const lengthMatch = CONTENT_LENGTH_RE.exec(header);
        if (!lengthMatch) {
          // Malformed frame header: drop it rather than stalling the stream.
          headerAcc = headerAcc.subarray(headerEnd + 4);
          continue;
        }
        headerFrame = headerAcc.subarray(0, headerEnd + 4);
        bodyNeeded = Number.parseInt(lengthMatch[1], 10);
        const rest = headerAcc.subarray(headerEnd + 4);
        headerAcc = Buffer.alloc(0);
        if (rest.length > 0) {
          bodyChunks.push(rest);
          bodySize += rest.length;
        }
      }

      if (bodySize < bodyNeeded) {
        return;
      }

      const full = Buffer.concat(bodyChunks, bodySize);
      const body = full.subarray(0, bodyNeeded);
      headerAcc = full.subarray(bodyNeeded);
      const frame = Buffer.concat([headerFrame, body]);

      bodyChunks = [];
      bodySize = 0;
      bodyNeeded = -1;

      onFrame(body, frame);
    }
  };
}

// client -> server: forward, but patch `initialize` to advertise the
// capabilities this proxy answers on the client's behalf. Without
// window.workDoneProgress, csharp-ls does not start workspace loading.
// Only the first message needs inspecting: `initialize` fires once per
// session, so every later frame forwards untouched with no JSON.parse.
let clientInitializeHandled = false;
const handleClientChunk = createFrameParser((body, frame) => {
  if (clientInitializeHandled) {
    server.stdin.write(frame);
    return;
  }
  clientInitializeHandled = true;

  let message: { method?: unknown; params?: { capabilities?: Record<string, any> } } | null = null;
  try {
    message = JSON.parse(body.toString('utf8'));
  } catch {
    // Unparseable: forward as-is.
  }

  if (message?.method === 'initialize' && message.params) {
    const caps = (message.params.capabilities ??= {});
    for (const entry of Object.values(INTERCEPT)) {
      entry.advertise?.(caps);
    }
    writeMessage(server.stdin, message);
    return;
  }
  server.stdin.write(frame);
});
process.stdin.on('data', handleClientChunk);
process.stdin.on('end', () => server.stdin.end());

// server -> client: parse Content-Length frames, intercept the three
// requests. Cheaply pre-check the raw bytes before paying for a JSON.parse;
// only bodies that could plausibly be one of the three intercepted requests
// get parsed at all.
const handleServerChunk = createFrameParser((body, frame) => {
  const mayBeIntercepted =
    body.includes('client/registerCapability') ||
    body.includes('workspace/configuration') ||
    body.includes('window/workDoneProgress/create');

  if (!mayBeIntercepted) {
    process.stdout.write(frame);
    return;
  }

  let message: { id?: unknown; method?: unknown; params?: unknown } | null = null;
  try {
    message = JSON.parse(body.toString('utf8'));
  } catch {
    // Unparseable body: forward as-is.
  }

  const isInterceptedRequest =
    message !== null &&
    message.id !== undefined &&
    typeof message.method === 'string' &&
    message.method in INTERCEPT;

  if (!isInterceptedRequest) {
    // The includes() pre-check can false-positive on payload text (e.g. a
    // diagnostic message that happens to mention one of these method
    // names); forward the frame unchanged in that case.
    process.stdout.write(frame);
    return;
  }

  const method = message!.method as string;
  writeMessage(server.stdin, {
    jsonrpc: '2.0',
    id: message!.id,
    result: INTERCEPT[method].handle(message!.params),
  });
});
server.stdout.on('data', handleServerChunk);
