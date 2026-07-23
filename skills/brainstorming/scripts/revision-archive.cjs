'use strict';

// Append-only history of every published Visual Document body (state/revisions.jsonl).
// session.jsonl already stamps each feedback turn with the document revision it targeted;
// retaining the document bodies themselves turns those stamps into working foreign keys, so
// exports can replay the session as a timeline (v1 canvas → feedback → v2 canvas → …).

const fs = require('node:fs');
const path = require('node:path');

const REVISIONS_FILE = 'revisions.jsonl';

function revisionsFile(stateDir) {
  return path.join(stateDir, REVISIONS_FILE);
}

function readRevisionSnapshots(stateDir) {
  const file = revisionsFile(stateDir);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim().length > 0);
  return lines.map(line => {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error('revision history is invalid');
    }
    if (record?.version !== 1
      || !Number.isInteger(record.seq)
      || typeof record.revision !== 'string'
      || record.document == null
      || typeof record.document !== 'object') {
      throw new Error('revision history is invalid');
    }
    return record;
  });
}

// Only revision-bearing Visual Document v2 bodies are archived; consecutive duplicates are
// skipped so republishing identical content never inflates the timeline. Returning to earlier
// content is a genuine new step and is recorded again.
function appendRevisionSnapshot(stateDir, document, options = {}) {
  if (document?.version !== 2 || typeof document.revision !== 'string') {
    return { appended: false, seq: null };
  }
  const existing = readRevisionSnapshots(stateDir);
  const last = existing.at(-1);
  if (last && last.revision === document.revision) return { appended: false, seq: last.seq };
  const seq = (last?.seq ?? 0) + 1;
  const record = {
    version: 1,
    seq,
    timestamp: options.timestamp ?? Date.now(),
    revision: document.revision,
    document,
  };
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(revisionsFile(stateDir), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return { appended: true, seq };
}

module.exports = { appendRevisionSnapshot, readRevisionSnapshots };
