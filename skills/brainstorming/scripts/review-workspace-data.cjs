'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EVIDENCE_ID_PATTERN = /^EVD-[0-9]{3}-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SOURCE_ID_PATTERN = /^source-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_SOURCE_LINES = 400;

class ReviewWorkspaceLookupError extends Error {
  constructor(code) {
    super('Review Workspace evidence is unavailable');
    this.name = 'ReviewWorkspaceLookupError';
    this.code = code;
  }
}

function unavailable(code) {
  throw new ReviewWorkspaceLookupError(code);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reviewContent(document) {
  if (!isObject(document) || !isObject(document.content)) unavailable('REVIEW_DOCUMENT_INVALID');
  return document.content;
}

function clone(value) {
  return structuredClone(value);
}

function projectPatchSetReview(indexed) {
  if (!isObject(indexed) || !isObject(indexed.files)) {
    throw new TypeError('indexed Patch Set review must include files');
  }
  const { files, ...review } = indexed;
  const fileReviews = Object.entries(files)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([filePath, state]) => {
      if (!isObject(state)) throw new TypeError('indexed Patch Set review file state must be an object');
      return { path: filePath, ...clone(state) };
    });
  return { ...clone(review), file_reviews: fileReviews };
}

function repositoryRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')
    || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
    || value.split('/').some(segment => segment === '..' || segment.length === 0)) {
    unavailable('REVIEW_SOURCE_INVALID');
  }
  return value;
}

function confinedSourceFile(repositoryRoot, relativePath) {
  if (typeof repositoryRoot !== 'string' || repositoryRoot.length === 0) {
    unavailable('REVIEW_SOURCE_INVALID');
  }
  let realRoot;
  try {
    realRoot = fs.realpathSync(repositoryRoot);
  } catch {
    unavailable('REVIEW_SOURCE_UNAVAILABLE');
  }
  const segments = repositoryRelativePath(relativePath).split('/');
  const candidate = path.join(realRoot, ...segments);
  const relative = path.relative(realRoot, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    unavailable('REVIEW_SOURCE_INVALID');
  }

  let cursor = realRoot;
  try {
    for (const segment of segments) {
      cursor = path.join(cursor, segment);
      if (fs.lstatSync(cursor).isSymbolicLink()) unavailable('REVIEW_SOURCE_UNAVAILABLE');
    }
    const realFile = fs.realpathSync(candidate);
    const realRelative = path.relative(realRoot, realFile);
    if (!realRelative || realRelative.startsWith(`..${path.sep}`)
      || realRelative === '..' || path.isAbsolute(realRelative)) {
      unavailable('REVIEW_SOURCE_UNAVAILABLE');
    }
    return realFile;
  } catch (error) {
    if (error instanceof ReviewWorkspaceLookupError) throw error;
    unavailable('REVIEW_SOURCE_UNAVAILABLE');
  }
}

function readBoundedSource(file) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) unavailable('REVIEW_SOURCE_UNAVAILABLE');
    return fs.readFileSync(descriptor, 'utf8');
  } catch (error) {
    if (error instanceof ReviewWorkspaceLookupError) throw error;
    unavailable('REVIEW_SOURCE_UNAVAILABLE');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function resolveReviewSource(document, id, options = {}) {
  if (typeof id !== 'string' || !SOURCE_ID_PATTERN.test(id)) unavailable('REVIEW_SOURCE_INVALID');
  const sources = reviewContent(document).source_evidence;
  if (!Array.isArray(sources)) unavailable('REVIEW_DOCUMENT_INVALID');
  const source = sources.find(candidate => isObject(candidate) && candidate.id === id);
  if (!source) unavailable('REVIEW_SOURCE_NOT_FOUND');

  const startLine = source.start_line;
  const endLine = source.end_line;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1
    || endLine < startLine || endLine - startLine + 1 > MAX_SOURCE_LINES) {
    unavailable('REVIEW_SOURCE_INVALID');
  }
  const contents = readBoundedSource(confinedSourceFile(options.repositoryRoot, source.path));
  const allLines = contents.split(/\r?\n/u);
  if (startLine > allLines.length) unavailable('REVIEW_SOURCE_UNAVAILABLE');
  const lines = allLines.slice(startLine - 1, Math.min(endLine, allLines.length))
    .map((text, offset) => ({ number: startLine + offset, text }));
  const safeSource = {
    id: source.id,
    component_id: source.component_id,
    path: repositoryRelativePath(source.path),
    hunk_id: source.hunk_id,
    symbols: Array.isArray(source.symbols) ? clone(source.symbols) : [],
    start_line: startLine,
    end_line: endLine,
  };
  return {
    source: safeSource,
    context: {
      start_line: startLine,
      end_line: lines.at(-1)?.number ?? startLine,
      lines,
    },
  };
}

function resolveReviewEvidence(document, id) {
  if (typeof id !== 'string' || !EVIDENCE_ID_PATTERN.test(id)) unavailable('REVIEW_EVIDENCE_INVALID');
  const content = reviewContent(document);
  if (!Array.isArray(content.evidence_records) || !Array.isArray(content.verification_evidence)) {
    unavailable('REVIEW_DOCUMENT_INVALID');
  }
  const evidence = content.evidence_records.find(candidate => isObject(candidate) && candidate.id === id);
  if (!evidence) unavailable('REVIEW_EVIDENCE_NOT_FOUND');
  const verification = content.verification_evidence.find(candidate => (
    isObject(candidate) && candidate.evidence_ref === id
  ));
  if (!verification) unavailable('REVIEW_EVIDENCE_NOT_FOUND');
  return { evidence: clone(evidence), verification: clone(verification) };
}

module.exports = {
  MAX_SOURCE_BYTES,
  MAX_SOURCE_LINES,
  ReviewWorkspaceLookupError,
  projectPatchSetReview,
  resolveReviewEvidence,
  resolveReviewSource,
};
