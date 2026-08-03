const path = require('node:path');

const { git } = require('./pair-store');

const DESIGN_CHECK_KEYS = new Set([
  'seam',
  'ownership',
  'runtime',
  'contract',
  'alternative',
  'proof',
]);
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|cs|fs|vb|java|kt|kts|go|rs|rb|py|php|swift|scala|sql|proto)$/iu;
const TEST_PATH = /(?:^|\/)(?:test|tests|spec|specs|__tests__|fixtures?)(?:\/|$)|\.(?:test|spec)\.[^.]+$/iu;
const DEPLOYMENT_PATH = /(?:^|\/)(?:k8s|kubernetes|helm|deploy|deployment|infra)(?:\/|$)|(?:^|\/)(?:Dockerfile|docker-compose[^/]*|values[^/]*\.ya?ml)$/iu;
const RISK_PATTERNS = [
  ['state or lifetime', /\b(?:AddSingleton|AddScoped|AddTransient|Singleton|IMemoryCache|IDistributedCache|Redis|localStorage|sessionStorage|createContext|useContext|useReducer|redux|zustand|mobx)\b|\bstatic\s+(?:(?:mutable|var|let)\s+)?[A-Za-z_$][\w$]*(?:\s+[A-Za-z_$][\w$]*)?\s*[=;]|\bglobalThis\.|\bglobal\./iu],
  ['public or data contract', /^(?:\+\s*)?(?:export\s+(?:default\s+)?(?:async\s+)?(?:class|function|const|interface|type|enum)|public\s+(?:sealed\s+|static\s+|abstract\s+|partial\s+)*(?:class|interface|record|struct|enum)|app\.Map(?:Get|Post|Put|Patch|Delete)|\[(?:HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete)|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)/iu],
  ['request pipeline', /\b(?:UseRouting|UseCors|UseAuthentication|UseAuthorization|UseRateLimiter|UseOutputCache|UseResponseCaching|UseForwardedHeaders|UseMiddleware|IMiddleware|middleware)\b/iu],
  ['asynchronous work or eventing', /\b(?:BackgroundService|IHostedService|AddHostedService|worker_threads|Task\.Run|setInterval|cron|scheduler|job\s*queue|message\s*(?:consumer|producer)|publish(?:er)?|subscribe(?:r)?|event\s*(?:bus|stream|handler)|ServiceBus|Kafka|RabbitMQ)\b/iu],
  ['concurrency or ordering', /\b(?:lock\s*\(|Monitor\.|Mutex|Semaphore|Interlocked|Concurrent[A-Z]|Promise\.all|Task\.WhenAll|worker_threads|channel|atomic|sequence\s*(?:number|id)|idempoten)\b/iu],
  ['remote boundary', /\b(?:HttpClient|IHttpClientFactory|axios|gRPC|GrpcClient|ServiceBus|Kafka|RabbitMQ|webhook|circuit\s*breaker|Polly|retry|backoff|dead[- ]letter)\b|\bfetch\s*\(/iu],
  ['transaction or consistency', /\b(?:BeginTransaction|TransactionScope|transaction\s*\(|commit\s*\(|rollback\s*\(|eventual\s+consistency|optimistic\s+concurrency|rowversion)\b/iu],
  ['security boundary', /\b(?:Authorize|Authentication|Authorization|permission|credential|secret|token|encrypt|decrypt|signature|CSRF|CORS|SameSite)\b/iu],
  ['deployment or replica behavior', /\b(?:replicas?|StatefulSet|Deployment|DaemonSet|Ingress|LoadBalancer|readinessProbe|livenessProbe|startupProbe|HorizontalPodAutoscaler|session\s+affinity|sticky\s+session|multi[- ]?pod)\b/iu],
];

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRisk(value, label = 'architecture risk') {
  if (value == null || value === '') return null;
  const risk = String(value).replace(/\s+/gu, ' ').trim();
  if (!risk || risk.length > 240) throw new Error(`${label} must use 1-240 characters`);
  return risk;
}

function boundedText(value, field) {
  const text = String(value || '').replace(/\s+/gu, ' ').trim();
  if (!text || text.length > 180) throw new Error(`Design Check ${field} must use 1-180 characters`);
  return text;
}

function validateDesignCheck(value) {
  if (!plainObject(value)) throw new Error('Architecture-Sensitive Path requires one Design Check object');
  const unknown = Object.keys(value).filter(key => !DESIGN_CHECK_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`Design Check has unsupported fields: ${unknown.join(', ')}`);
  const normalized = Object.fromEntries([...DESIGN_CHECK_KEYS].map(key => [key, boundedText(value[key], key)]));
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 1536) {
    throw new Error('Design Check exceeds 1536 UTF-8 bytes');
  }
  return normalized;
}

function renderDesignCheckMarkdown(risk, designCheck) {
  const normalizedRisk = normalizeRisk(risk);
  const normalized = validateDesignCheck(designCheck);
  return [
    '# Design Check',
    '',
    `Risk: ${normalizedRisk}`,
    '',
    `- Seam: ${normalized.seam}`,
    `- Ownership: ${normalized.ownership}`,
    `- Runtime: ${normalized.runtime}`,
    `- Contract: ${normalized.contract}`,
    `- Rejected alternative: ${normalized.alternative}`,
    `- Proof: ${normalized.proof}`,
    '',
  ].join('\n');
}

function parseNameStatus(raw) {
  return String(raw).split(/\r?\n/u).filter(Boolean).map(line => {
    const [status, ...parts] = line.split('\t');
    return { status, path: parts.at(-1) };
  });
}

function addedLineEvidence(diff) {
  const evidence = [];
  let selectedPath = null;
  let line = 0;
  for (const row of String(diff).split(/\r?\n/u)) {
    const file = row.match(/^\+\+\+ b\/(.+)$/u);
    if (file) { selectedPath = file[1]; continue; }
    const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (row.startsWith('+') && !row.startsWith('+++')) {
      evidence.push({ path: selectedPath, line, text: row.slice(1) });
      line++;
    } else if (!row.startsWith('-')) {
      line++;
    }
  }
  return evidence;
}

function inspectCheckpointRisks(root, baseCommit, checkpointCommit = 'HEAD') {
  const nameStatus = parseNameStatus(git(root, ['diff', '--name-status', '-M', `${baseCommit}..${checkpointCommit}`]).stdout);
  const diff = git(root, ['diff', '--unified=0', '--no-ext-diff', `${baseCommit}..${checkpointCommit}`], { trim: false }).stdout;
  const evidence = [];
  const seen = new Set();
  const add = (area, item) => {
    const key = `${area}:\0${item.path}:\0${item.line}`;
    if (seen.has(key) || evidence.length >= 8) return;
    seen.add(key);
    evidence.push({ area, ...item });
  };
  for (const changed of nameStatus) {
    if (changed.path && DEPLOYMENT_PATH.test(changed.path)) {
      add('deployment or replica behavior', { path: changed.path, line: 1, reason: 'deployment configuration changed' });
    }
  }
  for (const row of addedLineEvidence(diff)) {
    if (!row.path || TEST_PATH.test(row.path)) continue;
    for (const [area, pattern] of RISK_PATTERNS) {
      if (pattern.test(row.text)) add(area, { path: row.path, line: row.line, reason: row.text.trim().slice(0, 160) });
    }
  }
  const productionRoots = new Set(nameStatus
    .map(item => item.path)
    .filter(Boolean)
    .filter(item => SOURCE_EXTENSION.test(item) && !TEST_PATH.test(item))
    .map(item => item.split('/').slice(0, Math.min(2, item.split('/').length - 1 || 1)).join('/')));
  if (productionRoots.size > 1) {
    add('component boundary', { path: [...productionRoots].join(', '), line: 1, reason: 'production changes cross component roots' });
  }
  return {
    risks: [...new Set(evidence.map(item => item.area))],
    evidence,
    changed_paths: nameStatus.map(item => item.path).filter(Boolean),
  };
}

function determinePath({ declaredRisk = null, checkpointRisks = [] }) {
  const declared = normalizeRisk(declaredRisk);
  const observed = [...new Set((checkpointRisks || []).map(item => String(item).replace(/\s+/gu, ' ').trim()).filter(Boolean))];
  if (declared || observed.length > 0) {
    const observedText = observed.length > 0 ? `checkpoint indicates ${observed.join(', ')}` : null;
    return {
      path: 'architecture-sensitive',
      risk: normalizeRisk([declared, observedText].filter(Boolean).join('; ').slice(0, 240)),
    };
  }
  return { path: 'routine', risk: null };
}

function isTestPath(repositoryPath) {
  return TEST_PATH.test(path.posix.normalize(repositoryPath));
}

module.exports = {
  determinePath,
  inspectCheckpointRisks,
  isTestPath,
  normalizeRisk,
  renderDesignCheckMarkdown,
  validateDesignCheck,
};
