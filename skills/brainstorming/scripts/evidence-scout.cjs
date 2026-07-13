#!/usr/bin/env node
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_BRIEF_BYTES = 4_000;
const MAX_PACKET_BYTES = 6_000;
const MAX_REVIEW_SLICES_PER_PACKET = 4;
const MAX_CHANGED_FILES_PER_PACKET = 40;
const MAX_CHANGED_LINES_PER_PACKET = 1_200;
const MAX_CONCURRENT_SCOUTS = 3;
const MAX_SCOUT_WAVES = 2;
const MAX_SCOUT_CALLS = MAX_CONCURRENT_SCOUTS * MAX_SCOUT_WAVES;
const GIT_OBJECT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const WORK_ID_PATTERN = /^work-[0-9]{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EVIDENCE_KINDS = new Set(['symbol', 'caller', 'dependency', 'framework', 'test', 'configuration']);
const SCOUT_BATCH_SCHEMA = require('../schemas/scout-batch.schema.json');

const EVIDENCE_PACKET_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'summary', 'evidence', 'unknowns'],
  properties: {
    version: { const: 1 },
    summary: { type: 'string', minLength: 1, maxLength: 500 },
    evidence: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'path', 'startLine', 'endLine', 'observation'],
        properties: {
          kind: { enum: [...EVIDENCE_KINDS] },
          path: { type: 'string', minLength: 1, maxLength: 300 },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
          observation: { type: 'string', minLength: 1, maxLength: 400 },
        },
      },
    },
    unknowns: {
      type: 'array',
      maxItems: 12,
      items: { type: 'string', minLength: 1, maxLength: 300 },
    },
  },
};

const BATCH_EVIDENCE_PACKET_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'summary', 'evidence', 'unknowns'],
  properties: {
    version: { const: 2 },
    summary: { type: 'string', minLength: 1, maxLength: 500 },
    evidence: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['evidence_key', 'kind', 'path', 'startLine', 'endLine', 'observation'],
        properties: {
          evidence_key: { type: 'string', minLength: 1, maxLength: 200 },
          kind: { enum: [...EVIDENCE_KINDS] },
          path: { type: 'string', minLength: 1, maxLength: 300 },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
          observation: { type: 'string', minLength: 1, maxLength: 400 },
        },
      },
    },
    unknowns: {
      type: 'array',
      maxItems: 12,
      items: { type: 'string', minLength: 1, maxLength: 300 },
    },
  },
};

function fail(message) {
  throw new Error(message);
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
}

function rejectUnknown(value, allowed, label) {
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown) fail(`unsupported field ${label}.${unknown}`);
}

function text(value, maximum, label, required = false) {
  if (value == null) {
    if (required) fail(`${label} is required`);
    return '';
  }
  if (typeof value !== 'string') fail(`${label} must be text`);
  const normalized = value.trim();
  if (required && !normalized) fail(`${label} is required`);
  if (normalized.length > maximum) fail(`${label} must be at most ${maximum} characters`);
  return normalized;
}

function textList(value, label, maximumItems, maximumLength, required = false) {
  if (value == null) value = [];
  if (!Array.isArray(value) || value.length > maximumItems || (required && value.length === 0)) {
    fail(`${label} must contain ${required ? `1-${maximumItems}` : `0-${maximumItems}`} items`);
  }
  return value.map((item, index) => text(item, maximumLength, `${label}[${index}]`, true));
}

function enforceBytes(value, maximum, label) {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > maximum) fail(`${label} exceeds ${maximum} bytes`);
  return bytes;
}

function normalizeBrief(value) {
  assertObject(value, 'scout brief');
  enforceBytes(value, MAX_BRIEF_BYTES, 'scout brief');
  rejectUnknown(value, ['version', 'purpose', 'targets', 'questions', 'constraints'], 'scout brief');
  if (value.version !== 1) fail('scout brief.version must be 1');
  const brief = {
    version: 1,
    purpose: text(value.purpose, 600, 'scout brief.purpose', true),
    targets: textList(value.targets, 'scout brief.targets', 12, 240, true),
    questions: textList(value.questions, 'scout brief.questions', 8, 300, true),
    constraints: textList(value.constraints, 'scout brief.constraints', 8, 300),
  };
  enforceBytes(brief, MAX_BRIEF_BYTES, 'normalized scout brief');
  return brief;
}

function evidenceFile(root, inputPath, label) {
  const rootPath = path.resolve(root);
  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) fail('repository root must be a directory');
  const realRoot = fs.realpathSync(rootPath);
  const candidate = text(inputPath, 300, `${label}.path`, true);
  const resolved = path.resolve(rootPath, candidate);
  if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${path.sep}`)) {
    fail(`${label}.path must stay inside the repository root`);
  }
  let cursor = rootPath;
  for (const segment of path.relative(rootPath, resolved).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      fail(`${label}.path must not traverse a symlink`);
    }
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) fail(`${label}.path does not name an observed file`);
  const realFile = fs.realpathSync(resolved);
  if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${path.sep}`)) {
    fail(`${label}.path resolves outside the repository root`);
  }
  return {
    resolved: realFile,
    relative: path.relative(rootPath, resolved).split(path.sep).join('/'),
  };
}

function fileLineCount(file) {
  const contents = fs.readFileSync(file, 'utf8');
  if (!contents) return 0;
  const lines = contents.split(/\r\n|\n|\r/).length;
  return /(?:\r\n|\n|\r)$/.test(contents) ? lines - 1 : lines;
}

function normalizeEvidencePacket(value, options = {}) {
  const root = path.resolve(options.root || process.cwd());
  assertObject(value, 'evidence packet');
  enforceBytes(value, MAX_PACKET_BYTES, 'evidence packet');
  rejectUnknown(value, ['version', 'summary', 'evidence', 'unknowns'], 'evidence packet');
  if (value.version !== 1) fail('evidence packet.version must be 1');
  if (!Array.isArray(value.evidence) || value.evidence.length > 20) fail('evidence packet.evidence must contain 0-20 items');

  const evidence = value.evidence.map((item, index) => {
    const label = `evidence packet.evidence[${index}]`;
    assertObject(item, label);
    rejectUnknown(item, ['kind', 'path', 'startLine', 'endLine', 'observation'], label);
    if (!EVIDENCE_KINDS.has(item.kind)) fail(`${label}.kind is unsupported`);
    const source = evidenceFile(root, item.path, label);
    const startLine = Number(item.startLine);
    const endLine = Number(item.endLine);
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
      fail(`${label} has an invalid line range`);
    }
    if (endLine - startLine + 1 > 12) fail(`${label} line range must contain at most 12 lines`);
    const lineCount = fileLineCount(source.resolved);
    if (endLine > lineCount) fail(`${label} is outside the observed file line range`);
    return {
      kind: item.kind,
      path: source.relative,
      startLine,
      endLine,
      observation: text(item.observation, 400, `${label}.observation`, true),
    };
  });
  const packet = {
    version: 1,
    summary: text(value.summary, 500, 'evidence packet.summary', true),
    evidence,
    unknowns: textList(value.unknowns, 'evidence packet.unknowns', 12, 300),
  };
  enforceBytes(packet, MAX_PACKET_BYTES, 'normalized evidence packet');
  return packet;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(compareText);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort(compareText).map(key => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
  return value;
}

function repositoryRelativePath(value, label) {
  const candidate = text(value, 240, label, true).replaceAll('\\', '/');
  const normalized = path.posix.normalize(candidate);
  if (path.posix.isAbsolute(candidate) || normalized === '.' || normalized !== candidate
    || candidate === '..' || candidate.startsWith('../') || candidate.includes('/../')) {
    fail(`${label} must be repository-relative`);
  }
  return candidate;
}

function patternedText(value, label, pattern, maximum = 500) {
  const normalized = text(value, maximum, label, true);
  if (!pattern.test(normalized)) fail(`${label} has an invalid identifier`);
  return normalized;
}

function gitBytes(root, args, label) {
  const result = childProcess.spawnSync('git', args, {
    cwd: root,
    encoding: null,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) fail(`${label} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = sanitizeDiagnostic(result.stderr?.toString('utf8'));
    fail(`${label} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

function changedLineRanges(patch) {
  return [...patch.matchAll(/^@@\s+-[^ ]+\s+\+(\d+)(?:,(\d+))?\s+@@/gm)].map(match => ({
    start: Number(match[1]),
    count: match[2] == null ? 1 : Number(match[2]),
  })).filter(range => range.count > 0);
}

function isChangedLine(lineNumber, ranges) {
  return ranges.some(range => lineNumber >= range.start && lineNumber < range.start + range.count);
}

function deriveSourceShortlist(filePath, source, patch, binary) {
  const publicSymbols = [];
  const boundaryCrossings = [];
  const tests = [];
  const unknowns = [];
  const ranges = changedLineRanges(patch);
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!isChangedLine(index + 1, ranges)) continue;
    const line = lines[index];
    const symbol = line.match(/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/)
      || line.match(/^\s*public\s+(?:sealed\s+|static\s+|abstract\s+|partial\s+)*(?:class|interface|record|struct|enum)\s+([A-Za-z_][\w]*)/)
      || line.match(/^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z][\w]*)/);
    if (symbol && !symbol[1].startsWith('_')) publicSymbols.push(symbol[1]);
    const dependency = line.match(/\bfrom\s+['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)|^\s*using\s+([^;]+);|^\s*(?:from|import)\s+([A-Za-z0-9_.]+)/);
    const dependencyName = dependency?.slice(1).find(Boolean);
    if (dependencyName) boundaryCrossings.push(`${filePath}: ${dependencyName}`);
  }
  if (/(^|\/)(?:tests?|__tests__)(\/|$)|\.(?:test|spec)\.[^.]+$/i.test(filePath)) tests.push(filePath);
  if (binary) unknowns.push(`${filePath} is binary; changed-line and symbol evidence requires coordinator inspection.`);
  if (!source) unknowns.push(`${filePath} has no text at the head tree; deleted-file symbols require coordinator inspection.`);
  return {
    public_symbols: uniqueSorted(publicSymbols),
    boundary_crossings: uniqueSorted(boundaryCrossings),
    tests,
    unknowns,
  };
}

function attributeFreeDiff(scratchDirectory, args, label) {
  const emptyConfig = path.join(scratchDirectory, 'git-empty-config');
  if (!fs.existsSync(emptyConfig)) fs.writeFileSync(emptyConfig, '', { mode: 0o600 });
  const result = childProcess.spawnSync('git', args, {
    cwd: scratchDirectory,
    encoding: null,
    env: {
      ...process.env,
      GIT_ATTR_NOSYSTEM: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_DIR: '',
      GIT_WORK_TREE: '',
    },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) fail(`${label} failed: ${result.error.message}`);
  if (![0, 1].includes(result.status)) {
    const detail = sanitizeDiagnostic(result.stderr?.toString('utf8'));
    fail(`${label} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

function deriveGitChanges(root, baseTree, headTree, scratchDirectory) {
  const names = gitBytes(root, [
    'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames',
    baseTree, headTree, '--',
  ], 'scout Git changed paths').toString('utf8').split('\0').filter(Boolean)
    .map((filePath, index) => repositoryRelativePath(filePath, `scout Git changed paths[${index}]`))
    .sort(compareText);
  const records = new Map();
  const materialized = fs.mkdtempSync(path.join(scratchDirectory, '.scout-git-diff-'));
  try {
    for (const [index, filePath] of names.entries()) {
    const treeEntry = tree => gitBytes(root, [
      'ls-tree', '-z', '--full-tree', tree, '--', `:(literal)${filePath}`,
    ], `scout Git tree entry for ${filePath}`);
    const baseEntry = treeEntry(baseTree);
    const headEntry = treeEntry(headTree);
    const blobBytes = entry => {
      if (entry.length === 0) return Buffer.alloc(0);
      const tab = entry.indexOf(0x09);
      if (tab < 0) fail(`scout Git tree entry for ${filePath} is malformed`);
      const header = entry.subarray(0, tab).toString('utf8').split(' ');
      if (header.length !== 3 || header[1] !== 'blob' || !/^[a-f0-9]{40,64}$/.test(header[2])) {
        fail(`scout Git tree entry for ${filePath} is malformed`);
      }
      return gitBytes(root, ['cat-file', 'blob', header[2]], `scout Git blob for ${filePath}`);
    };
    const baseBlob = blobBytes(baseEntry);
    const headBlob = blobBytes(headEntry);
    const binary = baseBlob.includes(0) || headBlob.includes(0);
    const baseFile = path.join(materialized, `${String(index).padStart(6, '0')}-base`);
    const headFile = path.join(materialized, `${String(index).padStart(6, '0')}-head`);
    fs.writeFileSync(baseFile, baseBlob, { mode: 0o600 });
    fs.writeFileSync(headFile, headBlob, { mode: 0o600 });
    const commonDiffArgs = [
      '-c', 'diff.algorithm=myers', '-c', 'diff.indentHeuristic=false', '-c', 'color.ui=false',
      'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color',
      '--diff-algorithm=myers', '--no-indent-heuristic', '--text',
    ];
    const numstat = attributeFreeDiff(materialized, [
      ...commonDiffArgs, '--numstat', '--', baseFile, headFile,
    ], `scout attribute-free numstat for ${filePath}`).toString('utf8').trim();
    const numstatFields = numstat.split('\t');
    if (numstatFields.length < 3 || !/^\d+$/.test(numstatFields[0]) || !/^\d+$/.test(numstatFields[1])) {
      fail(`scout attribute-free numstat[${index}] is malformed`);
    }
    const patchBytes = attributeFreeDiff(materialized, [
      ...commonDiffArgs, '--full-index', '--src-prefix=a/', '--dst-prefix=b/', '--', baseFile, headFile,
    ], `scout attribute-free diff for ${filePath}`);
    const changeIdentity = Buffer.concat([
      Buffer.from(`base:${baseEntry.length}\0`, 'utf8'),
      baseEntry,
      Buffer.from(`head:${headEntry.length}\0`, 'utf8'),
      headEntry,
    ]);
    const textPatch = patchBytes.toString('utf8');
    const source = binary ? '' : headBlob.toString('utf8');
    const shortlist = deriveSourceShortlist(filePath, source, binary ? '' : textPatch, binary);
    records.set(filePath, {
      path: filePath,
      changed_lines: Number(numstatFields[0]) + Number(numstatFields[1]),
      binary,
      hunk_id: crypto.createHash('sha256').update(changeIdentity).digest('hex'),
      ...shortlist,
    });
    }
  } finally {
    fs.rmSync(materialized, { recursive: true, force: true });
  }
  return records;
}

function normalizeLegacyReviewSliceManifest(value) {
  assertObject(value, 'legacy scout batch manifest');
  rejectUnknown(value, ['version', 'work_id', 'review_slices'], 'legacy scout batch manifest');
  if (value.version !== 1) fail('legacy scout batch manifest.version must be 1');
  const workId = patternedText(value.work_id, 'legacy scout batch manifest.work_id', WORK_ID_PATTERN, 200);
  if (!Array.isArray(value.review_slices) || value.review_slices.length === 0 || value.review_slices.length > 10_000) {
    fail('legacy scout batch manifest.review_slices must contain 1-10000 items');
  }
  const seenSliceIds = new Set();
  const reviewSlices = value.review_slices.map((slice, sliceIndex) => {
    const label = `legacy scout batch manifest.review_slices[${sliceIndex}]`;
    assertObject(slice, label);
    rejectUnknown(slice, ['review_slice_id', 'acceptance_criteria', 'changed_files'], label);
    const reviewSliceId = text(slice.review_slice_id, 120, `${label}.review_slice_id`, true);
    if (seenSliceIds.has(reviewSliceId)) fail(`duplicate Review Slice ${reviewSliceId}`);
    seenSliceIds.add(reviewSliceId);
    if (!Array.isArray(slice.changed_files) || slice.changed_files.length === 0 || slice.changed_files.length > 10_000) {
      fail(`${label}.changed_files must contain 1-10000 items`);
    }
    const seenPaths = new Set();
    const changedFiles = slice.changed_files.map((file, fileIndex) => {
      const fileLabel = `${label}.changed_files[${fileIndex}]`;
      assertObject(file, fileLabel);
      rejectUnknown(file, [
        'path', 'changed_lines', 'public_symbols', 'boundary_crossings', 'tests', 'unknowns', 'raw_diff',
      ], fileLabel);
      const filePath = repositoryRelativePath(file.path, `${fileLabel}.path`);
      if (seenPaths.has(filePath)) fail(`${label} contains duplicate changed file ${filePath}`);
      seenPaths.add(filePath);
      if (file.raw_diff != null && typeof file.raw_diff !== 'string') fail(`${fileLabel}.raw_diff must be text`);
      return {
        path: filePath,
        changed_lines: nonNegativeInteger(file.changed_lines, `${fileLabel}.changed_lines`),
        binary: false,
        public_symbols: uniqueSorted(textList(file.public_symbols, `${fileLabel}.public_symbols`, 64, 300)),
        boundary_crossings: uniqueSorted(textList(file.boundary_crossings, `${fileLabel}.boundary_crossings`, 64, 300)),
        tests: uniqueSorted(textList(file.tests, `${fileLabel}.tests`, 64, 300)),
        unknowns: uniqueSorted(textList(file.unknowns, `${fileLabel}.unknowns`, 64, 300)),
      };
    }).sort((left, right) => compareText(left.path, right.path));
    return {
      review_slice_id: reviewSliceId,
      acceptance_criteria: uniqueSorted(textList(
        slice.acceptance_criteria,
        `${label}.acceptance_criteria`,
        100,
        120,
        true,
      )),
      changed_files: changedFiles,
    };
  }).sort((left, right) => compareText(left.review_slice_id, right.review_slice_id));
  return { version: 1, work_id: workId, review_slices: reviewSlices, source: 'legacy-v1' };
}

function normalizeCanonicalReviewSliceManifest(value, root, scratchDirectory) {
  assertObject(value, 'Review Slice manifest');
  rejectUnknown(value, [
    'schema', 'work_id', 'base_tree', 'head_tree', 'plan_digest', 'indexer_version',
    'review_slices', 'cross_slice_changes', 'unmapped_changes',
  ], 'Review Slice manifest');
  if (value.schema !== 1) fail('Review Slice manifest.schema must be 1');
  const repositoryRoot = fs.realpathSync(path.resolve(root));
  const workId = patternedText(value.work_id, 'Review Slice manifest.work_id', WORK_ID_PATTERN, 200);
  const baseTree = patternedText(value.base_tree, 'Review Slice manifest.base_tree', GIT_OBJECT_PATTERN);
  const headTree = patternedText(value.head_tree, 'Review Slice manifest.head_tree', GIT_OBJECT_PATTERN);
  const planDigest = patternedText(value.plan_digest, 'Review Slice manifest.plan_digest', SHA256_PATTERN);
  const indexerVersion = text(value.indexer_version, 100, 'Review Slice manifest.indexer_version', true);
  if (!Array.isArray(value.review_slices) || value.review_slices.length === 0 || value.review_slices.length > 10_000) {
    fail('Review Slice manifest.review_slices must contain 1-10000 items');
  }
  if (!Array.isArray(value.cross_slice_changes) || !Array.isArray(value.unmapped_changes)) {
    fail('Review Slice manifest cross_slice_changes and unmapped_changes must be arrays');
  }
  let diffScratch = scratchDirectory;
  if (!diffScratch) {
    const scratchRoot = path.resolve(process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch'));
    fs.mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(scratchRoot) !== scratchRoot) fail('CLAUDE_SCRATCH_DIR must not traverse symlinks');
    diffScratch = path.join(scratchRoot, path.basename(repositoryRoot), 'brainstorm', 'git-diff');
    fs.mkdirSync(diffScratch, { recursive: true, mode: 0o700 });
  }
  const gitChanges = deriveGitChanges(repositoryRoot, baseTree, headTree, diffScratch);
  const declaredTaskIds = value.review_slices.map((slice, index) => {
    assertObject(slice, `Review Slice manifest.review_slices[${index}]`);
    return text(slice.task_id, 120, `Review Slice manifest.review_slices[${index}].task_id`, true);
  });
  if (new Set(declaredTaskIds).size !== declaredTaskIds.length) fail('Review Slice manifest contains duplicate task_id values');
  const knownTaskIds = new Set(declaredTaskIds);
  const attributionByChange = new Map();

  const seenSliceIds = new Set();
  const reviewSlices = value.review_slices.map((slice, sliceIndex) => {
    const label = `Review Slice manifest.review_slices[${sliceIndex}]`;
    assertObject(slice, label);
    rejectUnknown(slice, [
      'task_id', 'stream_id', 'acceptance_criteria', 'expected_files',
      'verification_command', 'actual_changes',
    ], label);
    const reviewSliceId = text(slice.task_id, 120, `${label}.task_id`, true);
    if (seenSliceIds.has(reviewSliceId)) fail(`duplicate Review Slice ${reviewSliceId}`);
    seenSliceIds.add(reviewSliceId);
    const expectedFiles = uniqueSorted(textList(slice.expected_files, `${label}.expected_files`, 10_000, 240, true)
      .map((file, fileIndex) => repositoryRelativePath(file, `${label}.expected_files[${fileIndex}]`)));
    if (!Array.isArray(slice.actual_changes) || slice.actual_changes.length > 10_000) {
      fail(`${label}.actual_changes must contain 0-10000 items`);
    }

    const seenPaths = new Set();
    const changedFiles = slice.actual_changes.map((change, changeIndex) => {
      const changeLabel = `${label}.actual_changes[${changeIndex}]`;
      assertObject(change, changeLabel);
      rejectUnknown(change, ['path', 'hunk_id', 'claimed_by'], changeLabel);
      const filePath = repositoryRelativePath(change.path, `${changeLabel}.path`);
      if (seenPaths.has(filePath)) fail(`${label} contains duplicate changed file ${filePath}`);
      seenPaths.add(filePath);
      if (!expectedFiles.includes(filePath)) fail(`${changeLabel}.path is outside expected_files`);
      const claims = uniqueSorted(textList(change.claimed_by, `${changeLabel}.claimed_by`, 100, 120, true));
      if (!claims.includes(reviewSliceId)) fail(`${changeLabel} does not claim ${reviewSliceId}`);
      if (claims.some(claim => !knownTaskIds.has(claim))) fail(`${changeLabel} claims an unknown Review Slice`);
      const gitChange = gitChanges.get(filePath);
      if (!gitChange) fail(`${changeLabel}.path is not changed between base_tree and head_tree`);
      if (patternedText(change.hunk_id, `${changeLabel}.hunk_id`, SHA256_PATTERN) !== gitChange.hunk_id) {
        fail(`${changeLabel}.hunk_id does not match Git evidence`);
      }
      const changeKey = `${filePath}\0${gitChange.hunk_id}`;
      const attribution = attributionByChange.get(changeKey) || { claims, participants: new Set() };
      if (canonicalJson(attribution.claims) !== canonicalJson(claims)) fail(`${changeLabel} has inconsistent claims`);
      attribution.participants.add(reviewSliceId);
      attributionByChange.set(changeKey, attribution);
      return gitChange;
    }).sort((left, right) => compareText(left.path, right.path));

    return {
      review_slice_id: reviewSliceId,
      acceptance_criteria: uniqueSorted(textList(
        slice.acceptance_criteria,
        `${label}.acceptance_criteria`,
        100,
        120,
        true,
      )),
      changed_files: changedFiles,
    };
  }).filter(slice => slice.changed_files.length > 0)
    .sort((left, right) => compareText(left.review_slice_id, right.review_slice_id));

  for (const attribution of attributionByChange.values()) {
    if (canonicalJson([...attribution.participants].sort(compareText)) !== canonicalJson(attribution.claims)) {
      fail('Review Slice manifest actual change membership is inconsistent with claimed_by');
    }
  }
  const expectedCrossSlice = [...attributionByChange.entries()]
    .filter(([_key, attribution]) => attribution.claims.length > 1)
    .map(([key, attribution]) => {
      const separator = key.indexOf('\0');
      return { path: key.slice(0, separator), hunk_id: key.slice(separator + 1), claimed_by: attribution.claims };
    }).sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)));
  const actualCrossSlice = value.cross_slice_changes.map((change, index) => {
    const label = `Review Slice manifest.cross_slice_changes[${index}]`;
    assertObject(change, label);
    rejectUnknown(change, ['path', 'hunk_id', 'claimed_by'], label);
    return {
      path: repositoryRelativePath(change.path, `${label}.path`),
      hunk_id: patternedText(change.hunk_id, `${label}.hunk_id`, SHA256_PATTERN),
      claimed_by: uniqueSorted(textList(change.claimed_by, `${label}.claimed_by`, 100, 120, true)),
    };
  }).sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)));
  if (canonicalJson(actualCrossSlice) !== canonicalJson(expectedCrossSlice)) {
    fail('Review Slice manifest cross_slice_changes is inconsistent with actual_changes');
  }

  const mappedPaths = new Set(reviewSlices.flatMap(slice => slice.changed_files.map(file => file.path)));
  const seenUnmappedPaths = new Set();
  const accountedPaths = new Set([
    ...reviewSlices.flatMap(slice => slice.changed_files.map(file => file.path)),
    ...value.unmapped_changes.map((change, index) => {
      assertObject(change, `Review Slice manifest.unmapped_changes[${index}]`);
      rejectUnknown(change, ['path', 'hunk_id'], `Review Slice manifest.unmapped_changes[${index}]`);
      const filePath = repositoryRelativePath(change.path, `Review Slice manifest.unmapped_changes[${index}].path`);
      if (seenUnmappedPaths.has(filePath)) fail(`Review Slice manifest contains duplicate unmapped change ${filePath}`);
      if (mappedPaths.has(filePath)) fail(`Review Slice manifest change ${filePath} cannot be mapped and unmapped`);
      seenUnmappedPaths.add(filePath);
      const gitChange = gitChanges.get(filePath);
      if (!gitChange || patternedText(change.hunk_id, `Review Slice manifest.unmapped_changes[${index}].hunk_id`, SHA256_PATTERN) !== gitChange.hunk_id) {
        fail(`Review Slice manifest unmapped change ${filePath} does not match Git evidence`);
      }
      return filePath;
    }),
  ]);
  if (accountedPaths.size !== gitChanges.size || [...gitChanges.keys()].some(file => !accountedPaths.has(file))) {
    fail('Review Slice manifest does not account for every Git change');
  }

  return {
    schema: 1,
    work_id: workId,
    base_tree: baseTree,
    head_tree: headTree,
    plan_digest: planDigest,
    indexer_version: indexerVersion,
    review_slices: reviewSlices,
    source: 'review-index',
  };
}

function normalizeReviewSliceManifest(value, root, scratchDirectory) {
  if (value?.schema === 1) return normalizeCanonicalReviewSliceManifest(value, root, scratchDirectory);
  if (value?.version === 1) return normalizeLegacyReviewSliceManifest(value);
  fail('scout batch manifest must be a canonical Review Slice manifest or legacy version 1 manifest');
}

function regularSlicePayload(slice) {
  return {
    review_slice_id: slice.review_slice_id,
    acceptance_criteria: slice.acceptance_criteria,
    changed_files: slice.changed_files.map(file => ({
      path: file.path,
      changed_lines: file.changed_lines,
    })),
  };
}

function sliceCounts(slice) {
  return {
    files: slice.changed_files.length,
    lines: slice.changed_files.reduce((total, file) => total + file.changed_lines, 0),
  };
}

function combinedSliceCounts(slices) {
  const files = new Map();
  for (const slice of slices) {
    for (const file of slice.changed_files) files.set(file.path, file);
  }
  return {
    files: files.size,
    lines: [...files.values()].reduce((total, file) => total + file.changed_lines, 0),
    has_binary: [...files.values()].some(file => file.binary),
  };
}

function shortlistForSlice(slice) {
  const counts = sliceCounts(slice);
  const shortlist = {
    public_symbols: uniqueSorted(slice.changed_files.flatMap(file => file.public_symbols)).slice(0, 12),
    boundary_crossings: uniqueSorted(slice.changed_files.flatMap(file => file.boundary_crossings)).slice(0, 12),
    tests: uniqueSorted(slice.changed_files.flatMap(file => file.tests)).slice(0, 12),
    unknowns: uniqueSorted([
      ...slice.changed_files.flatMap(file => file.unknowns),
      `Review Slice ${slice.review_slice_id} was shortlisted from ${counts.files} file delta(s) and ${counts.lines} line delta(s); omitted source requires coordinator verification.`,
    ]).slice(0, 12),
  };
  return shortlist;
}

function packetPayload(workId, reviewSlices, oversizedReviewSlices = []) {
  return {
    version: 1,
    work_id: workId,
    review_slices: reviewSlices.map(regularSlicePayload),
    oversized_review_slices: oversizedReviewSlices,
  };
}

function buildOversizedSlice(workId, slice) {
  const counts = sliceCounts(slice);
  const oversized = {
    review_slice_id: slice.review_slice_id,
    original_changed_file_count: counts.files,
    original_changed_line_count: counts.lines,
    shortlist: shortlistForSlice(slice),
  };
  const removalOrder = ['unknowns', 'tests', 'boundary_crossings', 'public_symbols'];
  let payload = packetPayload(workId, [], [oversized]);
  while (Buffer.byteLength(canonicalJson(payload), 'utf8') > MAX_PACKET_BYTES) {
    const key = removalOrder.find(candidate => oversized.shortlist[candidate].length > 0);
    if (!key) fail(`Review Slice ${slice.review_slice_id} shortlist cannot fit the evidence packet budget`);
    oversized.shortlist[key].pop();
    payload = packetPayload(workId, [], [oversized]);
  }
  return oversized;
}

function buildPacketBrief(payload) {
  const reviewSliceIds = [
    ...payload.review_slices.map(slice => slice.review_slice_id),
    ...payload.oversized_review_slices.map(slice => slice.review_slice_id),
  ];
  const paths = payload.review_slices.flatMap(slice => slice.changed_files.map(file => file.path));
  const shortlistTargets = payload.oversized_review_slices.flatMap(slice => [
    ...slice.shortlist.public_symbols,
    ...slice.shortlist.boundary_crossings,
    ...slice.shortlist.tests,
  ]);
  const targets = uniqueSorted([...paths, ...shortlistTargets])
    .slice(0, 12)
    .map(value => value.slice(0, 240));
  return normalizeBrief({
    version: 1,
    purpose: `Gather load-bearing repository evidence for Review Slices ${reviewSliceIds.join(', ')}.`,
    targets: targets.length > 0 ? targets : reviewSliceIds,
    questions: [
      'Which requested symbols, callers, dependencies, tests, or configuration are directly observed?',
      'Which requested evidence remains unknown?',
    ],
    constraints: [
      'Use stable evidence_key values; merge is by exact key only.',
      'Do not edit, delegate, select architecture, or recommend an implementation.',
    ],
  });
}

function finalizePacket(workId, reviewSlices, oversizedReviewSlices = []) {
  const payload = packetPayload(workId, reviewSlices, oversizedReviewSlices);
  const packetBytes = enforceBytes(payload, MAX_PACKET_BYTES, 'Review Slice packet');
  const brief = buildPacketBrief(payload);
  const counts = combinedSliceCounts(reviewSlices);
  const reviewSliceIds = [
    ...reviewSlices.map(slice => slice.review_slice_id),
    ...oversizedReviewSlices.map(slice => slice.review_slice_id),
  ];
  return {
    packet_digest: digest(payload),
    review_slice_ids: reviewSliceIds,
    changed_file_count: counts.files,
    changed_line_count: counts.lines,
    brief_bytes: enforceBytes(brief, MAX_BRIEF_BYTES, 'scout brief'),
    packet_bytes: packetBytes,
    oversized_review_slices: oversizedReviewSlices,
    brief,
    payload,
  };
}

function buildScoutPackets(manifest) {
  const packets = [];
  let current = [];

  const flush = () => {
    if (current.length === 0) return;
    packets.push(finalizePacket(manifest.work_id, current));
    current = [];
  };

  for (const slice of manifest.review_slices) {
    const counts = sliceCounts(slice);
    const singlePayload = packetPayload(manifest.work_id, [slice]);
    const oversized = slice.changed_files.some(file => file.binary)
      || counts.files > MAX_CHANGED_FILES_PER_PACKET
      || counts.lines > MAX_CHANGED_LINES_PER_PACKET
      || Buffer.byteLength(canonicalJson(singlePayload), 'utf8') > MAX_PACKET_BYTES;
    if (oversized) {
      flush();
      packets.push(finalizePacket(manifest.work_id, [], [buildOversizedSlice(manifest.work_id, slice)]));
      continue;
    }

    const candidate = [...current, slice];
    const candidateCounts = combinedSliceCounts(candidate);
    const candidatePayload = packetPayload(manifest.work_id, candidate);
    const exceeds = candidate.length > MAX_REVIEW_SLICES_PER_PACKET
      || candidateCounts.files > MAX_CHANGED_FILES_PER_PACKET
      || candidateCounts.lines > MAX_CHANGED_LINES_PER_PACKET
      || Buffer.byteLength(canonicalJson(candidatePayload), 'utf8') > MAX_PACKET_BYTES;
    if (exceeds) flush();
    current.push(slice);
  }
  flush();
  return packets;
}

function normalizeBatchEvidencePacket(value, options = {}) {
  const root = path.resolve(options.root || process.cwd());
  assertObject(value, 'batch evidence packet');
  enforceBytes(value, MAX_PACKET_BYTES, 'batch evidence packet');
  rejectUnknown(value, ['version', 'summary', 'evidence', 'unknowns'], 'batch evidence packet');
  if (value.version !== 2) fail('batch evidence packet.version must be 2');
  if (!Array.isArray(value.evidence) || value.evidence.length > 20) {
    fail('batch evidence packet.evidence must contain 0-20 items');
  }

  const evidence = value.evidence.map((item, index) => {
    const label = `batch evidence packet.evidence[${index}]`;
    assertObject(item, label);
    rejectUnknown(item, ['evidence_key', 'kind', 'path', 'startLine', 'endLine', 'observation'], label);
    if (!EVIDENCE_KINDS.has(item.kind)) fail(`${label}.kind is unsupported`);
    const source = evidenceFile(root, item.path, label);
    const startLine = Number(item.startLine);
    const endLine = Number(item.endLine);
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
      fail(`${label} has an invalid line range`);
    }
    if (endLine - startLine + 1 > 12) fail(`${label} line range must contain at most 12 lines`);
    if (endLine > fileLineCount(source.resolved)) fail(`${label} is outside the observed file line range`);
    return {
      evidence_key: text(item.evidence_key, 200, `${label}.evidence_key`, true),
      kind: item.kind,
      path: source.relative,
      startLine,
      endLine,
      observation: text(item.observation, 400, `${label}.observation`, true),
    };
  });
  const packet = {
    version: 2,
    summary: text(value.summary, 500, 'batch evidence packet.summary', true),
    evidence,
    unknowns: textList(value.unknowns, 'batch evidence packet.unknowns', 12, 300),
  };
  enforceBytes(packet, MAX_PACKET_BYTES, 'normalized batch evidence packet');
  return packet;
}

function buildScoutPrompt(brief, reviewSlicePacket = null) {
  const lines = [
    'Act only as a repository evidence scout, not as a designer or implementation worker.',
    'Inspect the working repository read-only. Do not edit files, use the web, delegate, or propose architecture.',
    'Search before reading. Read only exact symbol ranges needed for the brief.',
    'Report only facts directly observed in repository files. Cite repository-relative paths and exact line ranges of at most 12 lines.',
    'If evidence is absent or ambiguous, add an unknown instead of inferring a capability.',
    'Return only the requested structured evidence packet.',
    `Scout brief: ${JSON.stringify(brief)}`,
  ];
  if (reviewSlicePacket) {
    enforceBytes(reviewSlicePacket, MAX_PACKET_BYTES, 'Review Slice packet');
    lines.splice(6, 0, 'Every evidence item must use an explicit evidence_key. Do not merge observations by prose similarity.');
    lines.push(`Review Slice packet: ${canonicalJson(reviewSlicePacket)}`);
  }
  return lines.join('\n');
}

function buildRuntimeCommand({ runtime, root, prompt, model, effort, schemaPath, outputPath, schema }) {
  if (runtime === 'codex') {
    return {
      file: process.env.BRAINSTORM_SCOUT_CODEX_BIN || 'codex',
      args: [
        'exec', '--json', '--ephemeral', '--sandbox', 'read-only', '-C', root,
        '--skip-git-repo-check', '--model', model,
        '-c', `model_reasoning_effort="${effort}"`,
        '--output-schema', schemaPath,
        '--output-last-message', outputPath,
        prompt,
      ],
      cwd: root,
    };
  }
  if (runtime === 'claude') {
    return {
      file: process.env.BRAINSTORM_SCOUT_CLAUDE_BIN || 'claude',
      args: [
        '-p', prompt,
        '--output-format', 'json',
        '--no-session-persistence',
        '--permission-mode', 'dontAsk',
        '--disable-slash-commands',
        '--tools', 'Read,Glob,Grep',
        '--json-schema', JSON.stringify(schema),
        '--model', model,
        '--effort', effort,
      ],
      cwd: root,
    };
  }
  fail(`unsupported scout runtime ${runtime}`);
}

function parseOptions(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith('--') || value == null || value.startsWith('--')) fail(`invalid option ${flag || ''}`.trim());
    const key = flag.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    options[key] = value;
  }
  return options;
}

function parsePositiveInteger(value, label, fallback) {
  if (value == null) return fallback;
  if (!/^\d+$/.test(String(value)) || Number(value) < 1) fail(`${label} must be a positive integer`);
  return Number(value);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonString(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function parseWorkerPacket(runtime, stdout, rawOutput) {
  if (runtime === 'codex') return readJson(rawOutput);
  const envelope = readJsonString(stdout);
  const candidate = envelope?.structured_output || envelope?.result || envelope;
  if (typeof candidate === 'string') return readJsonString(candidate) || fail('Claude scout returned unstructured text');
  return candidate || fail('Claude scout returned no structured output');
}

function parseUsage(runtime, stdout) {
  if (runtime === 'codex') {
    const events = stdout.split(/\r?\n/).filter(Boolean).map(readJsonString).filter(Boolean);
    const usage = [...events].reverse().find(event => event.type === 'turn.completed')?.usage || {};
    return {
      input_tokens: usage.input_tokens || 0,
      cached_input_tokens: usage.cached_input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      reasoning_output_tokens: usage.reasoning_output_tokens || 0,
    };
  }
  const envelope = readJsonString(stdout) || {};
  const usage = envelope.usage || envelope.result?.usage || {};
  return {
    input_tokens: usage.input_tokens || usage.inputTokens || 0,
    cached_input_tokens: usage.cache_read_input_tokens || usage.cached_input_tokens || 0,
    output_tokens: usage.output_tokens || usage.outputTokens || 0,
    reasoning_output_tokens: usage.reasoning_tokens || 0,
  };
}

function sanitizeDiagnostic(value) {
  return String(value || '')
    .replace(/([?&\s]token=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function summarizeRuntimeFailure(runtime, stdout, stderr) {
  if (runtime === 'codex') {
    const events = stdout.split(/\r?\n/).filter(Boolean).map(readJsonString).filter(Boolean);
    const failed = [...events].reverse().find(event => event.type === 'turn.failed' || event.type === 'error');
    const observed = failed?.error?.message || failed?.message;
    if (observed) return sanitizeDiagnostic(observed);
  } else {
    const envelope = readJsonString(stdout);
    const observed = envelope?.error?.message
      || envelope?.error
      || envelope?.message
      || (envelope?.is_error ? envelope.result : '');
    if (observed) return sanitizeDiagnostic(observed);
  }
  return sanitizeDiagnostic(stderr) || 'no diagnostic returned';
}

function spawnRuntime(command, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command.file, command.args, {
      cwd: command.cwd,
      env: { ...process.env, PAIR_STOP_GATE: 'off', CLAUDE_STOP_GATE: 'off' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const maximumOutputBytes = 2 * 1024 * 1024;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    function capture(current, chunk) {
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next, 'utf8') > maximumOutputBytes) {
        child.kill('SIGKILL');
        return current;
      }
      return next;
    }

    child.stdout.on('data', chunk => { stdout = capture(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = capture(stderr, chunk); });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const failure = new Error(`scout process failed: ${error.message}`);
      failure.scoutStatus = 'failed';
      reject(failure);
    });
    child.on('close', (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        const failure = new Error(`scout process timed out after ${timeoutMs}ms`);
        failure.scoutStatus = 'timed_out';
        reject(failure);
        return;
      }
      if (status !== 0) {
        const diagnostic = summarizeRuntimeFailure(command.runtime, stdout, stderr);
        const failure = new Error(`scout process exited ${status}${signal ? ` (${signal})` : ''}: ${diagnostic}`);
        failure.scoutStatus = 'failed';
        reject(failure);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function defaultOutput(root) {
  const scratch = path.resolve(process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch'));
  return path.join(scratch, path.basename(root), 'brainstorm', 'evidence', `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
}

function resolveBatchOutput(value, root) {
  const scratch = path.resolve(process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch'));
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(scratch).isSymbolicLink() || fs.realpathSync(scratch) !== scratch) {
    fail('CLAUDE_SCRATCH_DIR and its parents must not traverse symlinks');
  }
  const output = path.resolve(value || defaultOutput(root));
  if (output === scratch || !output.startsWith(`${scratch}${path.sep}`)) {
    fail('run-batch output must stay inside CLAUDE_SCRATCH_DIR');
  }
  let cursor = scratch;
  for (const segment of path.relative(scratch, output).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      fail('run-batch output must not traverse a symlink inside CLAUDE_SCRATCH_DIR');
    }
  }
  return output;
}

function publicPacket(packet) {
  return {
    packet_digest: packet.packet_digest,
    review_slice_ids: packet.review_slice_ids,
    changed_file_count: packet.changed_file_count,
    changed_line_count: packet.changed_line_count,
    brief_bytes: packet.brief_bytes,
    packet_bytes: packet.packet_bytes,
    oversized_review_slices: packet.oversized_review_slices,
  };
}

function normalizeScoutBatchResult(value) {
  assertObject(value, 'scout batch result');
  rejectUnknown(value, [
    'version', 'type', 'work_id', 'runtime', 'model', 'effort', 'packets', 'calls',
    'deferred_review_slice_ids', 'evidence_by_key', 'unknowns',
  ], 'scout batch result');
  if (value.version !== 1 || value.type !== 'evidence.scout-batch') fail('scout batch result identity is invalid');
  patternedText(value.work_id, 'scout batch result.work_id', WORK_ID_PATTERN, 200);
  if (!['codex', 'claude'].includes(value.runtime)) fail('scout batch result.runtime is invalid');
  text(value.model, 100, 'scout batch result.model', true);
  if (value.effort !== 'low') fail('scout batch result.effort must be low');
  if (!Array.isArray(value.packets) || value.packets.length > MAX_SCOUT_CALLS) fail('scout batch result.packets exceeds six');
  if (!Array.isArray(value.calls) || value.calls.length !== value.packets.length) {
    fail('scout batch result.calls must account for every selected packet');
  }
  value.packets.forEach((packet, index) => {
    assertObject(packet, `scout batch result.packets[${index}]`);
    rejectUnknown(packet, [
      'packet_digest', 'review_slice_ids', 'changed_file_count', 'changed_line_count',
      'brief_bytes', 'packet_bytes', 'oversized_review_slices',
    ], `scout batch result.packets[${index}]`);
    patternedText(packet.packet_digest, `scout batch result.packets[${index}].packet_digest`, SHA256_PATTERN);
    if (!Array.isArray(packet.review_slice_ids) || packet.review_slice_ids.length < 1
      || packet.review_slice_ids.length > MAX_REVIEW_SLICES_PER_PACKET) fail('packet Review Slice cap exceeded');
    if (!Number.isInteger(packet.changed_file_count) || packet.changed_file_count < 0
      || packet.changed_file_count > MAX_CHANGED_FILES_PER_PACKET) fail('packet changed-file cap exceeded');
    if (!Number.isInteger(packet.changed_line_count) || packet.changed_line_count < 0
      || packet.changed_line_count > MAX_CHANGED_LINES_PER_PACKET) fail('packet changed-line cap exceeded');
    if (!Number.isInteger(packet.brief_bytes) || packet.brief_bytes < 1 || packet.brief_bytes > MAX_BRIEF_BYTES) {
      fail('packet brief byte cap exceeded');
    }
    if (!Number.isInteger(packet.packet_bytes) || packet.packet_bytes < 1 || packet.packet_bytes > MAX_PACKET_BYTES) {
      fail('packet byte cap exceeded');
    }
    if (!Array.isArray(packet.oversized_review_slices) || packet.oversized_review_slices.length > 1) {
      fail('packet oversized Review Slice shape is invalid');
    }
  });
  value.calls.forEach((call, index) => {
    assertObject(call, `scout batch result.calls[${index}]`);
    rejectUnknown(call, ['call_id', 'packet_digest', 'wave', 'status', 'error', 'usage'], `scout batch result.calls[${index}]`);
    if (!['succeeded', 'failed', 'timed_out'].includes(call.status)) fail('scout call status is invalid');
    if (call.status === 'succeeded' && call.error !== undefined) fail('successful scout call cannot have an error');
    if (call.status !== 'succeeded') text(call.error, 500, `scout batch result.calls[${index}].error`, true);
    if (!Number.isInteger(call.wave) || call.wave < 1 || call.wave > MAX_SCOUT_WAVES) fail('scout call wave is invalid');
    assertObject(call.usage, `scout batch result.calls[${index}].usage`);
    rejectUnknown(call.usage, [
      'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens',
    ], `scout batch result.calls[${index}].usage`);
    for (const [key, count] of Object.entries(call.usage)) nonNegativeInteger(count, `scout call usage.${key}`);
  });
  textList(value.deferred_review_slice_ids, 'scout batch result.deferred_review_slice_ids', 10_000, 120);
  assertObject(value.evidence_by_key, 'scout batch result.evidence_by_key');
  if (!Array.isArray(value.unknowns)) fail('scout batch result.unknowns must be an array');
  return JSON.parse(JSON.stringify(value));
}

async function runBatchWorker({ packet, packetIndex, wave, root, runtime, model, effort, timeoutMs, outputDirectory, schemaPath }) {
  const rawOutput = path.join(outputDirectory, `.evidence-batch-worker-${process.pid}-${packetIndex}.json`);
  try {
    const command = buildRuntimeCommand({
      runtime,
      root,
      prompt: buildScoutPrompt(packet.brief, packet.payload),
      model,
      effort,
      schemaPath,
      outputPath: rawOutput,
      schema: BATCH_EVIDENCE_PACKET_SCHEMA,
    });
    command.runtime = runtime;
    const result = await spawnRuntime(command, timeoutMs);
    const evidence = normalizeBatchEvidencePacket(
      parseWorkerPacket(runtime, result.stdout, rawOutput),
      { root },
    );
    return {
      packet,
      evidence,
      call: {
        call_id: `scout-${String(packetIndex + 1).padStart(3, '0')}`,
        packet_digest: packet.packet_digest,
        wave,
        status: 'succeeded',
        usage: parseUsage(runtime, result.stdout),
      },
    };
  } catch (error) {
    return {
      packet,
      evidence: null,
      call: {
        call_id: `scout-${String(packetIndex + 1).padStart(3, '0')}`,
        packet_digest: packet.packet_digest,
        wave,
        status: error.scoutStatus === 'timed_out' ? 'timed_out' : 'failed',
        error: sanitizeDiagnostic(error.message) || 'scout call failed',
        usage: {
          input_tokens: 0,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    };
  } finally {
    fs.rmSync(rawOutput, { force: true });
  }
}

async function runBatch(options) {
  if (!options.manifest) fail('run-batch requires --manifest FILE');
  const root = fs.realpathSync(path.resolve(options.root || process.cwd()));
  const output = resolveBatchOutput(options.output, root);
  const outputDirectory = path.dirname(output);
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const manifestPath = path.resolve(options.manifest);
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) fail('run-batch manifest does not exist');
  if (fs.statSync(manifestPath).size > 16 * 1024 * 1024) fail('run-batch manifest exceeds 16 MB');
  const manifest = normalizeReviewSliceManifest(readJson(manifestPath), root, outputDirectory);
  const runtime = options.runtime || process.env.BRAINSTORM_SCOUT_RUNTIME || 'codex';
  if (!['codex', 'claude'].includes(runtime)) fail('runtime must be codex or claude');
  const defaultModel = runtime === 'codex'
    ? process.env.BRAINSTORM_SCOUT_CODEX_MODEL || process.env.PAIR_CODEX_LOW_MODEL || 'gpt-5.4-mini'
    : process.env.BRAINSTORM_SCOUT_CLAUDE_MODEL || process.env.PAIR_CLAUDE_LOW_MODEL || 'haiku';
  const model = text(options.model || defaultModel, 100, 'scout model', true);
  if (!model || model === 'default') fail('evidence scout requires an explicit lower-tier model');
  const effort = options.effort || 'low';
  if (effort !== 'low') fail('evidence scout effort must be low');
  const timeoutMs = parsePositiveInteger(
    options.timeoutMs,
    'timeout-ms',
    Number(process.env.BRAINSTORM_SCOUT_TIMEOUT_MS || 180_000),
  );
  const allPackets = buildScoutPackets(manifest);
  const packets = allPackets.slice(0, MAX_SCOUT_CALLS);
  const deferredReviewSliceIds = uniqueSorted(
    allPackets.slice(MAX_SCOUT_CALLS).flatMap(packet => packet.review_slice_ids),
  );
  const schemaPath = path.join(outputDirectory, `.evidence-batch-schema-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`);
  fs.writeFileSync(schemaPath, `${JSON.stringify(BATCH_EVIDENCE_PACKET_SCHEMA)}\n`, { mode: 0o600 });

  const results = [];
  try {
    for (let waveIndex = 0; waveIndex < MAX_SCOUT_WAVES; waveIndex += 1) {
      const offset = waveIndex * MAX_CONCURRENT_SCOUTS;
      const wavePackets = packets.slice(offset, offset + MAX_CONCURRENT_SCOUTS);
      if (wavePackets.length === 0) break;
      const settled = await Promise.allSettled(wavePackets.map((packet, index) => runBatchWorker({
        packet,
        packetIndex: offset + index,
        wave: waveIndex + 1,
        root,
        runtime,
        model,
        effort,
        timeoutMs,
        outputDirectory,
        schemaPath,
      })));
      results.push(...settled.map((item, index) => item.status === 'fulfilled' ? item.value : ({
        packet: wavePackets[index],
        evidence: null,
        call: {
          call_id: `scout-${String(offset + index + 1).padStart(3, '0')}`,
          packet_digest: wavePackets[index].packet_digest,
          wave: waveIndex + 1,
          status: 'failed',
          error: sanitizeDiagnostic(item.reason?.message) || 'scout call failed',
          usage: {
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
          },
        },
      })));
    }
  } finally {
    fs.rmSync(schemaPath, { force: true });
  }

  const evidenceByKey = Object.create(null);
  const unknowns = [];
  for (const result of results) {
    if (!result.evidence) continue;
    for (const item of result.evidence.evidence) {
      const record = {
        ...item,
        packet_digest: result.packet.packet_digest,
        review_slice_ids: result.packet.review_slice_ids,
      };
      (evidenceByKey[item.evidence_key] ||= []).push(record);
    }
    for (const unknown of result.evidence.unknowns) {
      unknowns.push({
        text: unknown,
        packet_digest: result.packet.packet_digest,
        review_slice_ids: result.packet.review_slice_ids,
      });
    }
  }

  const orderedEvidence = Object.fromEntries(uniqueSorted(Object.keys(evidenceByKey)).map(key => [
    key,
    evidenceByKey[key].sort((left, right) => compareText(canonicalJson(left), canonicalJson(right))),
  ]));
  unknowns.sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)));
  const batch = normalizeScoutBatchResult({
    version: 1,
    type: 'evidence.scout-batch',
    work_id: manifest.work_id,
    runtime,
    model,
    effort,
    packets: packets.map(publicPacket),
    calls: results.map(result => result.call),
    deferred_review_slice_ids: deferredReviewSliceIds,
    evidence_by_key: orderedEvidence,
    unknowns,
  });
  atomicJson(output, batch);
  console.log(JSON.stringify({
    type: batch.type,
    output_file: output,
    packet_count: batch.packets.length,
    call_count: batch.calls.length,
    deferred_review_slice_count: batch.deferred_review_slice_ids.length,
    evidence_key_count: Object.keys(batch.evidence_by_key).length,
  }));
  return batch;
}

function run(options) {
  if (!options.brief) fail('run requires --brief FILE');
  const root = path.resolve(options.root || process.cwd());
  const brief = normalizeBrief(readJson(path.resolve(options.brief)));
  const runtime = options.runtime || process.env.BRAINSTORM_SCOUT_RUNTIME || 'codex';
  if (!['codex', 'claude'].includes(runtime)) fail('runtime must be codex or claude');
  const defaultModel = runtime === 'codex'
    ? process.env.BRAINSTORM_SCOUT_CODEX_MODEL || process.env.PAIR_CODEX_LOW_MODEL || 'gpt-5.4-mini'
    : process.env.BRAINSTORM_SCOUT_CLAUDE_MODEL || process.env.PAIR_CLAUDE_LOW_MODEL || 'haiku';
  const model = options.model || defaultModel;
  if (!model || model === 'default') fail('evidence scout requires an explicit lower-tier model');
  const effort = options.effort || 'low';
  if (effort !== 'low') fail('evidence scout effort must be low');
  const timeoutMs = parsePositiveInteger(options.timeoutMs, 'timeout-ms', Number(process.env.BRAINSTORM_SCOUT_TIMEOUT_MS || 180_000));
  const output = path.resolve(options.output || defaultOutput(root));
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const nonce = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const schemaPath = path.join(path.dirname(output), `.evidence-schema-${nonce}.json`);
  const rawOutput = path.join(path.dirname(output), `.evidence-worker-${nonce}.json`);
  fs.writeFileSync(schemaPath, `${JSON.stringify(EVIDENCE_PACKET_SCHEMA)}\n`, { mode: 0o600 });

  try {
    const command = buildRuntimeCommand({
      runtime,
      root,
      prompt: buildScoutPrompt(brief),
      model,
      effort,
      schemaPath,
      outputPath: rawOutput,
      schema: EVIDENCE_PACKET_SCHEMA,
    });
    const result = childProcess.spawnSync(command.file, command.args, {
      cwd: command.cwd,
      encoding: 'utf8',
      env: { ...process.env, PAIR_STOP_GATE: 'off', CLAUDE_STOP_GATE: 'off' },
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (result.error) fail(`scout process failed: ${result.error.message}`);
    if (result.status !== 0) {
      const diagnostic = summarizeRuntimeFailure(runtime, result.stdout || '', result.stderr || '');
      fail(`scout process exited ${result.status}${result.signal ? ` (${result.signal})` : ''}: ${diagnostic}`);
    }
    const packet = normalizeEvidencePacket(parseWorkerPacket(runtime, result.stdout || '', rawOutput), { root });
    atomicJson(output, packet);
    const metadata = {
      type: 'evidence.scouted',
      runtime,
      model,
      effort,
      output_file: output,
      output_bytes: Buffer.byteLength(JSON.stringify(packet), 'utf8'),
      evidence_count: packet.evidence.length,
      unknown_count: packet.unknowns.length,
      usage: parseUsage(runtime, result.stdout || ''),
    };
    console.log(JSON.stringify(metadata));
    return metadata;
  } finally {
    fs.rmSync(schemaPath, { force: true });
    fs.rmSync(rawOutput, { force: true });
  }
}

async function main() {
  const [command, ...values] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log([
      'Usage: evidence-scout.cjs run --brief FILE [--root DIR] [--output FILE]',
      '       [--runtime codex|claude] [--model MODEL] [--effort low] [--timeout-ms MS]',
      '       evidence-scout.cjs run-batch --manifest FILE [--root DIR] [--output FILE]',
      '       [--runtime codex|claude] [--model MODEL] [--effort low] [--timeout-ms MS]',
    ].join('\n'));
    return;
  }
  const options = parseOptions(values);
  if (command === 'run') {
    run(options);
    return;
  }
  if (command === 'run-batch') {
    const batch = await runBatch(options);
    if (batch.calls.some(call => call.status !== 'succeeded')) process.exitCode = 1;
    return;
  }
  fail(`unsupported evidence scout command ${command}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`evidence-scout: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  BATCH_EVIDENCE_PACKET_SCHEMA,
  EVIDENCE_PACKET_SCHEMA,
  MAX_BRIEF_BYTES,
  MAX_CHANGED_FILES_PER_PACKET,
  MAX_CHANGED_LINES_PER_PACKET,
  MAX_CONCURRENT_SCOUTS,
  MAX_PACKET_BYTES,
  MAX_REVIEW_SLICES_PER_PACKET,
  MAX_SCOUT_CALLS,
  MAX_SCOUT_WAVES,
  SCOUT_BATCH_SCHEMA,
  buildScoutPackets,
  buildRuntimeCommand,
  buildScoutPrompt,
  normalizeBrief,
  normalizeBatchEvidencePacket,
  normalizeEvidencePacket,
  normalizeReviewSliceManifest,
  normalizeScoutBatchResult,
  parseUsage,
  runBatch,
  summarizeRuntimeFailure,
};
