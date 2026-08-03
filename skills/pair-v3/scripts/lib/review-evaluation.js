const childProcess = require('node:child_process');
const crypto = require('node:crypto');

const { redactString } = require('./pair-store');

const BANK_SCHEMA = 1;
const EVALUATION_BANK_LIMIT_BYTES = 32 * 1024;
const EVALUATION_RESULT_LIMIT_BYTES = 16 * 1024;
const CASE_CATEGORIES = new Set(['retained-blocker', 'false-positive', 'missed-defect', 'manual-escape']);

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validateCommand(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20 || value.some(item => typeof item !== 'string' || !item || item.length > 240)) {
    throw new Error(`${label} must be an argv array with 1-20 strings of at most 240 characters`);
  }
  return [...value];
}

function validateBank(bank) {
  if (!bank || typeof bank !== 'object' || Array.isArray(bank) || bank.schema !== BANK_SCHEMA) {
    throw new Error(`Review Evaluation Bank schema must be ${BANK_SCHEMA}`);
  }
  if (!Array.isArray(bank.cases) || bank.cases.length < 20 || bank.cases.length > 50) {
    throw new Error('Review Evaluation Bank requires 20-50 cases');
  }
  const seen = new Set();
  const cases = bank.cases.map((item, index) => {
    const id = String(item?.id || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(id) || seen.has(id)) throw new Error(`Review Evaluation case ${index + 1} ID is invalid or duplicated`);
    seen.add(id);
    if (!CASE_CATEGORIES.has(item.category)) throw new Error(`Review Evaluation case ${id} category is invalid`);
    if (!['block', 'approve'].includes(item.expected)) throw new Error(`Review Evaluation case ${id} expected result is invalid`);
    return {
      id,
      category: item.category,
      expected: item.expected,
      baseline_command: validateCommand(item.baseline_command, `Review Evaluation case ${id} baseline command`),
      candidate_command: validateCommand(item.candidate_command, `Review Evaluation case ${id} candidate command`),
    };
  });
  const normalized = { schema: BANK_SCHEMA, cases };
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > EVALUATION_BANK_LIMIT_BYTES) {
    throw new Error(`Review Evaluation Bank exceeds ${EVALUATION_BANK_LIMIT_BYTES} UTF-8 bytes; reference fixtures instead of embedding them`);
  }
  return normalized;
}

function validateTrial(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} returned no JSON object`);
  if (!['block', 'approve'].includes(value.verdict)) throw new Error(`${label} verdict is invalid`);
  const numbers = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'duration_ms', 'attempts', 'human_rework'];
  const trial = { verdict: value.verdict, accepted: value.accepted === true };
  for (const field of numbers) {
    const number = Number(value[field] || 0);
    if (!Number.isFinite(number) || number < 0) throw new Error(`${label} ${field} is invalid`);
    trial[field] = number;
  }
  return trial;
}

function commandExecutor(command, context = {}) {
  const [file, ...args] = command;
  const result = childProcess.spawnSync(file, args, {
    cwd: context.cwd,
    env: context.env || process.env,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} evaluation failed with status ${result.status}: ${redactString(result.stderr || '').trim().slice(0, 500)}`);
  try { return JSON.parse(result.stdout); } catch { throw new Error(`${file} evaluation returned invalid JSON`); }
}

function median(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function metrics(cases, strategy) {
  const trials = cases.map(item => ({ ...item, trial: item[strategy] }));
  const blocked = trials.filter(item => item.trial.verdict === 'block');
  const trueBlocks = blocked.filter(item => item.expected === 'block');
  const expectedBlocks = trials.filter(item => item.expected === 'block');
  const escapes = expectedBlocks.filter(item => item.trial.verdict !== 'block');
  const accepted = trials.filter(item => item.trial.accepted);
  return {
    precision: blocked.length === 0 ? 1 : trueBlocks.length / blocked.length,
    known_defects_detected: trueBlocks.length,
    expected_defects: expectedBlocks.length,
    escapes: escapes.length,
    median_input_tokens_per_accepted_case: median(accepted.map(item => item.trial.input_tokens)),
    total_input_tokens: trials.reduce((sum, item) => sum + item.trial.input_tokens, 0),
    total_cached_input_tokens: trials.reduce((sum, item) => sum + item.trial.cached_input_tokens, 0),
    total_output_tokens: trials.reduce((sum, item) => sum + item.trial.output_tokens, 0),
    total_duration_ms: trials.reduce((sum, item) => sum + item.trial.duration_ms, 0),
    total_attempts: trials.reduce((sum, item) => sum + item.trial.attempts, 0),
    total_human_rework: trials.reduce((sum, item) => sum + item.trial.human_rework, 0),
  };
}

function evaluateBank(bank, options = {}) {
  const normalized = validateBank(bank);
  const execute = options.execute || commandExecutor;
  const cases = normalized.cases.map(item => ({
    id: item.id,
    category: item.category,
    expected: item.expected,
    baseline: validateTrial(execute(item.baseline_command, { ...options, strategy: 'baseline', case: item }), `${item.id} baseline`),
    candidate: validateTrial(execute(item.candidate_command, { ...options, strategy: 'candidate', case: item }), `${item.id} candidate`),
  }));
  const baseline = metrics(cases, 'baseline');
  const candidate = metrics(cases, 'candidate');
  const retained = cases.filter(item => ['retained-blocker', 'manual-escape'].includes(item.category));
  const caughtEveryRetained = retained.every(item => item.candidate.verdict === 'block');
  const baselineMedian = baseline.median_input_tokens_per_accepted_case;
  const candidateMedian = candidate.median_input_tokens_per_accepted_case;
  const tokenThreshold = baselineMedian !== null && candidateMedian !== null && candidateMedian <= baselineMedian * 0.5;
  const migrationPassed = caughtEveryRetained && candidate.precision >= 0.6 && tokenThreshold;
  const noRegression = candidate.precision >= baseline.precision
    && candidate.escapes <= baseline.escapes
    && candidate.total_input_tokens <= baseline.total_input_tokens;
  const strictImprovement = candidate.precision > baseline.precision
    || candidate.escapes < baseline.escapes
    || candidate.total_input_tokens < baseline.total_input_tokens;
  const candidateFailed = cases.filter(item => item.candidate.verdict !== item.expected || item.candidate.accepted !== true);
  const regressions = candidateFailed.filter(item => item.baseline.verdict === item.expected && item.baseline.accepted === true);
  const result = {
    schema: 1,
    bank_digest: digest(normalized),
    trial_digest: digest(cases),
    case_count: cases.length,
    baseline,
    candidate,
    retained_cases_caught: caughtEveryRetained,
    guidance_improved: noRegression && strictImprovement,
    migration_passed: migrationPassed,
    failed_case_ids: candidateFailed.map(item => item.id),
    regression_case_ids: regressions.map(item => item.id),
  };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > EVALUATION_RESULT_LIMIT_BYTES) {
    throw new Error(`Review Evaluation result exceeds ${EVALUATION_RESULT_LIMIT_BYTES} UTF-8 bytes`);
  }
  return result;
}

module.exports = {
  CASE_CATEGORIES,
  EVALUATION_BANK_LIMIT_BYTES,
  EVALUATION_RESULT_LIMIT_BYTES,
  commandExecutor,
  evaluateBank,
  metrics,
  validateBank,
  validateTrial,
};
