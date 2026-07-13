const crypto = require('node:crypto');

const QUALITY_FLOORS = {
  low: 0.85,
  medium: 0.92,
  high: 0.97,
  critical: 1,
};

const PROFILE_VALUES = {
  type: ['bugfix', 'feature', 'refactor', 'test', 'docs', 'migration'],
  risk: ['low', 'medium', 'high', 'critical'],
  scope: ['local', 'cross-module', 'contract', 'architecture'],
  uncertainty: ['low', 'medium', 'high'],
};

const REQUIRED_PLAN_SECTIONS = [
  'context',
  'intent contract',
  'implementation context',
  'capability evidence',
  'simplicity contract',
  'streams',
  'acceptance criteria',
  'open questions',
];

function planContractDigest(plan) {
  if (typeof plan !== 'string') throw new TypeError('Pair plan must be a string');
  const normalized = plan
    .replace(
      /^(\s*[-*]\s+)\[[xX]\](\s+(?:Task\b|AC-[1-9][0-9]*:))/gm,
      '$1[ ]$2',
    )
    .replace(
      /(?:^|\r?\n)  - Pair-v3 recovery context for [A-Za-z0-9][A-Za-z0-9._-]*: [^\r\n]*(?=\r?\n|$)/g,
      '',
    );
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function inferType(text) {
  const value = text.toLowerCase();
  if (/\b(tests?|specs?|coverage)\b/.test(value)) return 'test';
  if (/\b(doc|readme|comment)\b/.test(value)) return 'docs';
  if (/\b(refactor|simplif|cleanup|rename)\b/.test(value)) return 'refactor';
  if (/\b(migrat|upgrade|convert)\b/.test(value)) return 'migration';
  if (/\b(fix|bug|regression|correct)\b/.test(value)) return 'bugfix';
  return 'feature';
}

function inferRisk(text) {
  const value = text.toLowerCase();
  if (/\b(data[- ]loss|credential|secret|payment|authorization|authentication|production)\b/.test(value)) return 'critical';
  if (/\b(public|contract|schema|migration|security|permission|database|api)\b/.test(value)) return 'high';
  if (/\b(cross[- ]module|integration|concurrency|async|shared)\b/.test(value)) return 'medium';
  return 'low';
}

function inferScope(text, files) {
  const value = text.toLowerCase();
  if (/\b(architecture|redesign)\b/.test(value)) return 'architecture';
  if (/\b(public|contract|schema|api)\b/.test(value)) return 'contract';
  const roots = new Set(files.map(file => file.split('/')[0]).filter(Boolean));
  return roots.size > 1 ? 'cross-module' : 'local';
}

function taskFromParts(id, rawText, lineNumber, prefix = '') {
  const fileClause = rawText.match(/\s*[-:–—]\s*files?:\s*((?:`[^`]+`(?:\s*,\s*)?)+)/i)?.[1] || '';
  const files = [...fileClause.matchAll(/`([^`]+)`/g)].map(item => item[1]);
  const verify = rawText.match(/\s*[-:–—]\s*verify:\s*`([^`]+)`/i)?.[1]?.trim() || '';
  const complexityMatch = rawText.match(/\*\*([SML])\*\*\s*$/i);
  const complexity = complexityMatch?.[1]?.toUpperCase() || 'M';
  const tags = Object.fromEntries([...rawText.matchAll(/\[(type|risk|scope|uncertainty|phase|ac):([^\]]+)\]/gi)]
    .map(item => [item[1].toLowerCase(), item[2].trim()]));
  const acceptanceCriteria = (tags.ac || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const text = rawText
    .replace(/\s*\[(?:type|risk|scope|uncertainty|phase|ac):[^\]]+\]/gi, '')
    .replace(/\s*[-:–—]\s*files?:\s*(?:`[^`]+`(?:\s*,\s*)?)+/i, '')
    .replace(/\s*[-:–—]\s*verify:\s*`[^`]+`/i, '')
    .replace(/\s*[-:–—]\s*\*\*[SML]\*\*\s*$/i, '')
    .trim();
  const joined = `${text} ${files.join(' ')}`;

  return {
    id,
    text: `${prefix}${text}`,
    complexity,
    complexityExplicit: Boolean(complexityMatch),
    type: tags.type?.toLowerCase() || inferType(text),
    risk: tags.risk?.toLowerCase() || inferRisk(joined),
    scope: tags.scope?.toLowerCase() || inferScope(joined, files),
    uncertainty: tags.uncertainty?.toLowerCase()
      || (/\b(investigat|unknown|explor|spike)\b/i.test(text) ? 'high' : 'medium'),
    phase: tags.phase?.toLowerCase() || null,
    acceptanceCriteria,
    files,
    verify,
    explicitTags: new Set(Object.keys(tags)),
    raw: rawText,
    line: lineNumber,
  };
}

function sectionMap(lines) {
  const sections = new Map();
  let current = null;
  for (let index = 0; index < lines.length; index++) {
    const heading = lines[index].match(/^##\s+(.+)\s*$/);
    if (heading) {
      current = heading[1].trim().toLowerCase();
      sections.set(current, { heading: heading[1].trim(), line: index + 1, lines: [] });
      continue;
    }
    if (current) sections.get(current).lines.push({ text: lines[index], line: index + 1 });
  }
  return sections;
}

function parseDependencies(raw) {
  if (!raw || /^none\.?$/i.test(raw.trim())) return [];
  return [...raw.matchAll(/(?:Stream\s+)?([A-Za-z0-9._-]+)/gi)]
    .map(match => match[1])
    .filter(value => value.toLowerCase() !== 'stream');
}

function parsePlan(plan) {
  const lines = plan.split(/\r?\n/);
  const sections = sectionMap(lines);
  const streams = [];
  const tasks = [];
  const malformedTaskLines = [];
  const executableCheckboxesOutsidePlan = [];
  let currentSection = '';
  let currentStream = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const sectionHeading = line.match(/^##\s+(.+)\s*$/);
    if (sectionHeading) {
      currentSection = sectionHeading[1].trim().toLowerCase();
      currentStream = null;
      continue;
    }

    if (currentSection !== 'streams') {
      if (currentSection !== 'acceptance criteria' && /^\s*[-*]\s+\[ \]\s+/.test(line)) {
        executableCheckboxesOutsidePlan.push({ line: index + 1, text: line.trim(), section: currentSection });
      }
      continue;
    }
    const streamHeading = line.match(/^###\s+Stream\s+([A-Za-z0-9._-]+)\s*:\s*(.+?)(?:\s+[-–—]\s+complexity:\s*([SML]))?\s*$/i);
    if (streamHeading) {
      currentStream = {
        id: streamHeading[1],
        name: streamHeading[2].trim(),
        complexity: streamHeading[3]?.toUpperCase() || null,
        line: index + 1,
        dependsOn: null,
        tasks: [],
      };
      streams.push(currentStream);
      continue;
    }

    if (!currentStream) continue;
    const dependency = line.match(/^\*\*Depends on:\*\*\s*(.+)\s*$/i);
    if (dependency) {
      currentStream.dependsOn = parseDependencies(dependency[1]);
      continue;
    }

    const checkbox = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (!checkbox) continue;
    const taskMatch = checkbox[2].match(/^(?:Task\s+)?([A-Za-z0-9._-]+)\s*[-:–—]\s*(.+)$/i);
    if (!taskMatch) {
      malformedTaskLines.push({ line: index + 1, text: checkbox[2] });
      continue;
    }
    const task = taskFromParts(taskMatch[1], taskMatch[2], index + 1);
    task.checked = checkbox[1].toLowerCase() === 'x';
    task.streamId = currentStream.id;
    currentStream.tasks.push(task);
    tasks.push(task);
  }

  const acceptanceCriteria = [];
  const malformedAcceptanceCriteria = [];
  for (const item of sections.get('acceptance criteria')?.lines || []) {
    const checkbox = item.text.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (!checkbox) continue;
    const criterion = checkbox[2].match(/^([A-Za-z0-9._-]+)\s*:\s*(.+)$/);
    if (!criterion) {
      malformedAcceptanceCriteria.push({ line: item.line, text: checkbox[2] });
      continue;
    }
    acceptanceCriteria.push({
      id: criterion[1],
      text: criterion[2].trim(),
      checked: checkbox[1].toLowerCase() === 'x',
      line: item.line,
    });
  }

  const capabilityEvidence = (sections.get('capability evidence')?.lines || [])
    .filter(item => /^\s*[-*]\s+\*\*(Dependency|Repository capability):\*\*/i.test(item.text))
    .map(item => {
      const record = item.text.match(/\*\*(Dependency|Repository capability):\*\*\s*([^|]+)/i);
      const decision = item.text.match(/\|\s*decision:\s*(reuse|extend|build)\b/i)?.[1]?.toLowerCase() || null;
      const evidence = item.text.match(/\|\s*evidence:\s*([^|]+)/i)?.[1]?.trim() || '';
      const gap = item.text.match(/\|\s*gap:\s*(.+)\s*$/i)?.[1]?.trim() || '';
      return {
        ...item,
        kind: record?.[1]?.toLowerCase() || '',
        capability: record?.[2]?.replaceAll('`', '').trim() || '',
        decision,
        evidence,
        gap,
      };
    });

  const openQuestions = (sections.get('open questions')?.lines || [])
    .filter(item => /^\s*[-*]\s+/.test(item.text));

  return {
    lines,
    sections,
    streams,
    tasks,
    malformedTaskLines,
    executableCheckboxesOutsidePlan,
    acceptanceCriteria,
    malformedAcceptanceCriteria,
    capabilityEvidence,
    openQuestions,
  };
}

function sectionContent(section) {
  return section?.lines.map(item => item.text).join('\n').trim() || '';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isConcreteValue(value) {
  const normalized = value.trim().replace(/^`|`$/g, '').trim();
  if (!normalized) return false;
  return !/^(?:<[^>]+>|todo|tbd|unknown|to be determined)\.?$/i.test(normalized);
}

function validatePlan(plan) {
  const parsed = parsePlan(plan);
  const errors = [];
  const warnings = [];

  if (/plan-phase:\s*sketch|<!--\s*sketch/i.test(plan)) {
    errors.push('plan is still a sketch');
  }

  for (const name of REQUIRED_PLAN_SECTIONS) {
    const section = parsed.sections.get(name);
    if (!section) errors.push(`missing ## ${name.replace(/\b\w/g, value => value.toUpperCase())} section`);
    else if (!sectionContent(section)) errors.push(`## ${section.heading} section is empty`);
  }

  const requiredFields = {
    'intent contract': ['Spec', 'Purpose', 'Rejection Criteria', 'Contrasts'],
    'implementation context': ['Language / Framework', 'Existing patterns', 'Constraints', 'Verification'],
    'simplicity contract': ['Native baseline', 'Custom modules justified', 'Real seams', 'Rejected abstractions'],
  };
  for (const [sectionName, fields] of Object.entries(requiredFields)) {
    const content = sectionContent(parsed.sections.get(sectionName));
    for (const field of fields) {
      const fieldMatch = content.match(new RegExp(`\\*\\*${escapeRegExp(field)}:\\*\\*[ \\t]*([^\\r\\n]*)`, 'i'));
      if (!fieldMatch) {
        const heading = sectionName.replace(/\b\w/g, value => value.toUpperCase());
        errors.push(`## ${heading} is missing **${field}:**`);
      } else if (!isConcreteValue(fieldMatch[1])) {
        errors.push(`**${field}:** must have a concrete value in ## ${sectionName.replace(/\b\w/g, value => value.toUpperCase())}`);
      }
    }
  }

  for (const item of parsed.executableCheckboxesOutsidePlan) {
    errors.push(`line ${item.line} has an executable checkbox outside ## Streams; revise the plan instead of delegating plan-review notes`);
  }

  if (parsed.streams.length === 0) errors.push('no stream headings found under ## Streams');
  for (const malformed of parsed.malformedTaskLines) {
    errors.push(`line ${malformed.line} has a task checkbox without a stable task ID`);
  }
  if (parsed.tasks.length === 0) errors.push('no runnable tasks with stable IDs found');

  const taskIds = new Set();
  const criterionIds = new Set();
  const coveredCriteria = new Set();
  for (const malformed of parsed.malformedAcceptanceCriteria) {
    errors.push(`line ${malformed.line} has an acceptance criterion without a stable ID`);
  }
  if (parsed.acceptanceCriteria.length === 0) errors.push('no acceptance criteria with stable IDs found');
  for (const criterion of parsed.acceptanceCriteria) {
    if (criterionIds.has(criterion.id)) errors.push(`duplicate acceptance criterion ID ${criterion.id}`);
    criterionIds.add(criterion.id);
  }

  for (const task of parsed.tasks) {
    if (taskIds.has(task.id)) errors.push(`duplicate task ID ${task.id}`);
    taskIds.add(task.id);

    for (const [key, allowed] of Object.entries(PROFILE_VALUES)) {
      if (!task.explicitTags.has(key)) errors.push(`Task ${task.id} is missing explicit ${key}`);
      else if (!allowed.includes(task[key])) errors.push(`Task ${task.id} has invalid ${key} "${task[key]}"`);
    }
    if (!task.complexityExplicit) errors.push(`Task ${task.id} is missing explicit S/M/L complexity`);
    if (task.files.length === 0) errors.push(`Task ${task.id} must name at least one owned file`);
    if (!task.verify) errors.push(`Task ${task.id} must include an exact verify command`);
    if (task.acceptanceCriteria.length === 0) errors.push(`Task ${task.id} must reference at least one acceptance criterion with [ac:...]`);
    for (const criterion of task.acceptanceCriteria) {
      coveredCriteria.add(criterion);
      if (!criterionIds.has(criterion)) errors.push(`Task ${task.id} references unknown acceptance criterion ${criterion}`);
    }
    if (task.uncertainty === 'high') {
      errors.push(`Task ${task.id} has high uncertainty; resolve it with capability evidence before promotion`);
    }
    if (task.phase && task.phase !== 'red') errors.push(`Task ${task.id} has unsupported phase "${task.phase}"`);
    if (task.phase === 'red' && task.type !== 'test') errors.push(`Task ${task.id} uses phase:red but is not a test task`);
    if (task.type === 'test' && task.phase !== 'red') errors.push(`Task ${task.id} is a test task and must use [phase:red]`);
  }

  for (const criterion of parsed.acceptanceCriteria) {
    if (!coveredCriteria.has(criterion.id)) errors.push(`acceptance criterion ${criterion.id} is not covered by any task`);
  }

  const streamIndex = new Map();
  for (const [index, stream] of parsed.streams.entries()) {
    if (streamIndex.has(stream.id)) errors.push(`duplicate stream ID ${stream.id}`);
    else streamIndex.set(stream.id, index);
  }
  for (const [index, stream] of parsed.streams.entries()) {
    if (!stream.complexity) errors.push(`Stream ${stream.id} is missing S/M/L complexity`);
    if (stream.dependsOn === null) errors.push(`Stream ${stream.id} is missing **Depends on:**`);
    for (const dependency of stream.dependsOn || []) {
      if (!streamIndex.has(dependency)) errors.push(`Stream ${stream.id} depends on unknown Stream ${dependency}`);
      else if (streamIndex.get(dependency) >= index) errors.push(`Stream ${stream.id} depends on Stream ${dependency}, which appears later; topologically order streams`);
    }
    const first = stream.tasks[0];
    if (!first || first.type !== 'test' || first.phase !== 'red') {
      errors.push(`Stream ${stream.id} must start with an explicit [type:test] [phase:red] task`);
    }
    const firstImplementation = stream.tasks.findIndex(task => task.type !== 'test');
    if (firstImplementation >= 0) {
      for (const task of stream.tasks.slice(firstImplementation + 1)) {
        if (task.phase === 'red') errors.push(`Task ${task.id} schedules a failing test after implementation in Stream ${stream.id}`);
      }
    }
  }

  const integrationTasks = parsed.tasks.filter(task => task.type === 'test' && /integration[- ]test/i.test(task.text));
  if (integrationTasks.length === 0) errors.push('no integration-test task covering acceptance criteria');
  for (const task of integrationTasks) {
    if (task.phase !== 'red') errors.push(`integration-test Task ${task.id} must be scheduled as [phase:red] before implementation`);
  }

  if (parsed.capabilityEvidence.length === 0) {
    errors.push('Capability Evidence must contain at least one structured **Dependency:** or **Repository capability:** entry');
  }
  for (const evidence of parsed.capabilityEvidence) {
    if (evidence.kind === 'dependency') {
      const versionSeparator = evidence.capability.lastIndexOf('@');
      if (versionSeparator <= 0 || versionSeparator === evidence.capability.length - 1) {
        errors.push(`line ${evidence.line} dependency ${evidence.capability || '(missing)'} must include its pinned version as name@version`);
      }
    }
    if (!evidence.decision) errors.push(`line ${evidence.line} capability evidence is missing decision: reuse|extend|build`);
    if (!evidence.evidence) errors.push(`line ${evidence.line} capability evidence is missing a repository or official evidence source`);
    else if (/\b(model memory|assum(?:e|ed|ption)|probably|unknown|tbd|todo)\b/i.test(evidence.evidence)) {
      errors.push(`line ${evidence.line} ${evidence.evidence} is not capability evidence; cite repository usage, pinned API metadata, official documentation, or a probe`);
    }
    if (evidence.decision === 'reuse' && (!evidence.gap || !/^none\.?$/i.test(evidence.gap))) {
      errors.push(`line ${evidence.line} reuse decision requires gap: none`);
    }
    if (['extend', 'build'].includes(evidence.decision) && (!evidence.gap || /^none\.?$/i.test(evidence.gap))) {
      errors.push(`line ${evidence.line} ${evidence.decision} decision requires a confirmed gap`);
    }
  }

  const blockingQuestion = (parsed.sections.get('open questions')?.lines || [])
    .find(item => /\[blocking\]/i.test(item.text));
  if (blockingQuestion) errors.push(`line ${blockingQuestion.line} contains a blocking open question`);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    tasksTotal: parsed.tasks.length,
    tasksOpen: parsed.tasks.filter(task => !task.checked).length,
    parsed,
  };
}

function nextOpenTask(plan) {
  const lines = plan.split(/\r?\n/);
  let explicitSection = '';
  for (let index = 0; index < lines.length; index++) {
    const heading = lines[index].match(/^##\s+(.+)/);
    if (heading) explicitSection = heading[1].trim().toLowerCase();
    if (explicitSection === 'acceptance criteria') continue;
    const match = lines[index].match(/^\s*[-*]\s+\[ \]\s+(?:Task\s+)?([A-Za-z0-9._-]+)\s*[-:–—]\s*(.+)$/i);
    if (match) return taskFromParts(match[1], match[2].trim(), index + 1);
  }

  for (const targetSection of ['tasks', 'acceptance criteria']) {
    let section = '';
    let ordinal = 0;
    for (let index = 0; index < lines.length; index++) {
      const heading = lines[index].match(/^##\s+(.+)/);
      if (heading) section = heading[1].trim().toLowerCase();
      const checkbox = lines[index].match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
      if (!checkbox || section !== targetSection) continue;
      ordinal++;
      if (checkbox[1] !== ' ') continue;
      if (targetSection === 'tasks') return taskFromParts(`loop.${ordinal}`, checkbox[2].trim(), index + 1);
      const namedCriterion = checkbox[2].match(/^([A-Za-z0-9._-]+)\s*:\s*(.+)$/);
      const id = namedCriterion?.[1] || `AC${ordinal}`;
      const text = namedCriterion?.[2] || checkbox[2].trim();
      return taskFromParts(id, text, index + 1, 'verify acceptance criterion: ');
    }
  }
  return null;
}

function sameProfile(left, right) {
  return ['type', 'complexity', 'risk', 'scope', 'uncertainty']
    .every(key => !left[key] || !right[key] || left[key] === right[key]);
}

function wilsonLowerBound(successes, total, z = 1.645) {
  if (total === 0) return 0;
  const rate = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = rate + (z * z) / (2 * total);
  const margin = z * Math.sqrt((rate * (1 - rate) + (z * z) / (4 * total)) / total);
  return (centre - margin) / denominator;
}

function routeStats(route, profile, history) {
  const records = history.filter(record => record.valid && record.routeId === route.id && sameProfile(record.profile || {}, profile));
  const successes = records.filter(record => record.success).length;
  const costs = records.map(record => record.totalCost).filter(Number.isFinite);
  return {
    samples: records.length,
    lowerQuality: wilsonLowerBound(successes, records.length),
    expectedCost: costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0) / costs.length : route.expectedCost ?? Infinity,
  };
}

function staticStrength(profile) {
  if (profile.risk === 'critical' || profile.uncertainty === 'high') return 4;
  if (profile.risk === 'high' || profile.complexity === 'L' || profile.scope === 'architecture') return 3;
  if (profile.risk === 'medium' || profile.complexity === 'M' || profile.scope === 'contract') return 2;
  return 1;
}

function selectRoute(profile, routes, history = []) {
  if (!Array.isArray(routes) || routes.length === 0) throw new Error('No model routes are configured');
  const ranked = routes.map((route, index) => ({ ...route, strength: route.strength ?? index + 1 }));
  const strongest = ranked.reduce((best, route) => route.strength > best.strength ? route : best, ranked[0]);
  const invalidProfile = Object.entries(PROFILE_VALUES)
    .some(([key, allowed]) => profile[key] && !allowed.includes(profile[key]));
  if (invalidProfile || profile.risk === 'critical' || profile.uncertainty === 'high') return strongest;

  const floor = QUALITY_FLOORS[profile.risk] ?? QUALITY_FLOORS.medium;
  const qualified = ranked
    .map(route => ({ route, stats: routeStats(route, profile, history) }))
    .filter(item => item.stats.samples >= 5 && item.stats.lowerQuality >= floor)
    .sort((left, right) => left.stats.expectedCost - right.stats.expectedCost);
  if (qualified.length > 0) return qualified[0].route;

  const needed = staticStrength(profile);
  return ranked.find(route => route.strength >= needed) || strongest;
}

function classifyOutcome({ workerStatus, workerBlocker = '', verification, findings = [], priorAttempts = 0, priorModelAttempts = priorAttempts, runtimeStatus = 0, reviewStatus = 0, recommendedAction = 'approve' }) {
  if (runtimeStatus !== 0) {
    return priorAttempts > 0
      ? { disposition: 'human-takeover', action: 'stop', cause: 'environment-failure' }
      : { disposition: 'regenerated', action: 'retry-infrastructure', cause: 'environment-failure' };
  }
  if (workerStatus === 'blocked' && /\bincorrect-plan\b/i.test(workerBlocker)) {
    return priorAttempts > 0
      ? { disposition: 'human-takeover', action: 'stop', cause: 'incorrect-plan' }
      : { disposition: 'redesign', action: 'redesign', cause: 'incorrect-plan' };
  }
  if (workerStatus === 'blocked') {
    return priorAttempts > 0
      ? { disposition: 'human-takeover', action: 'stop', cause: 'task-ambiguity' }
      : { disposition: 'regenerated', action: 'retry-context', cause: 'task-ambiguity' };
  }
  if (reviewStatus !== 0) {
    return priorAttempts > 0
      ? { disposition: 'human-takeover', action: 'stop', cause: 'reviewer-error' }
      : { disposition: 'regenerated', action: 'retry-infrastructure', cause: 'reviewer-error' };
  }
  if (recommendedAction === 'redesign') {
    return priorAttempts > 0
      ? { disposition: 'human-takeover', action: 'stop', cause: 'incorrect-plan' }
      : { disposition: 'redesign', action: 'redesign', cause: 'incorrect-plan' };
  }
  if (recommendedAction === 'rewrite') {
    return { disposition: 'substantial-rewrite', action: 'escalate', cause: 'model-capability' };
  }
  if (verification === 'fail') {
    return priorModelAttempts > 0
      ? { disposition: 'substantial-rewrite', action: 'escalate', cause: 'model-capability' }
      : { disposition: 'local-fix', action: 'local-fix', cause: 'model-capability' };
  }

  const blockers = findings.filter(finding => finding.severity === 'BLOCKER').length;
  const majors = findings.filter(finding => finding.severity === 'MAJOR').length;
  if (blockers > 0 || (majors > 0 && priorModelAttempts > 0)) {
    return { disposition: 'substantial-rewrite', action: 'escalate', cause: 'model-capability' };
  }
  if (majors > 0 || recommendedAction === 'local-fix') return { disposition: 'local-fix', action: 'local-fix', cause: 'model-capability' };
  return { disposition: 'accepted', action: 'complete-task', cause: null };
}

function buildRuntimeCommand({ runtime, root, prompt, model, effort, schemaPath, outputPath, schema }) {
  if (runtime === 'codex') {
    const args = ['exec', '--json', '--ephemeral', '--sandbox', 'workspace-write', '-C', root];
    if (model && model !== 'default') args.push('--model', model);
    if (effort && effort !== 'default') args.push('-c', `model_reasoning_effort="${effort}"`);
    if (schemaPath) args.push('--output-schema', schemaPath);
    if (outputPath) args.push('--output-last-message', outputPath);
    args.push(prompt);
    return { file: 'codex', args, cwd: root };
  }
  if (runtime === 'claude') {
    const args = ['-p', prompt, '--output-format', 'json', '--no-session-persistence', '--permission-mode', 'acceptEdits'];
    if (schema) args.push('--json-schema', JSON.stringify(schema));
    if (model && model !== 'default') args.push('--model', model);
    if (effort && effort !== 'default') args.push('--effort', effort);
    return { file: 'claude', args, cwd: root };
  }
  throw new Error(`Unsupported runtime: ${runtime}`);
}

function parseRuntimeUsage(runtime, raw) {
  const empty = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: null };
  if (!raw.trim()) return empty;
  if (runtime === 'codex') {
    const events = raw.split(/\r?\n/).filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    const usage = [...events].reverse().find(event => event.type === 'turn.completed')?.usage || {};
    return {
      inputTokens: usage.input_tokens || 0,
      cachedInputTokens: usage.cached_input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      reasoningTokens: usage.reasoning_output_tokens || 0,
      costUsd: null,
    };
  }

  let result;
  try { result = JSON.parse(raw); } catch { return empty; }
  const usage = result.usage || result.result?.usage || {};
  return {
    inputTokens: usage.input_tokens || usage.inputTokens || 0,
    cachedInputTokens: usage.cache_read_input_tokens || usage.cached_input_tokens || 0,
    outputTokens: usage.output_tokens || usage.outputTokens || 0,
    reasoningTokens: usage.reasoning_tokens || 0,
    costUsd: Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : null,
  };
}

function createAttempt({
  task,
  route,
  policyVersion,
  baseline,
  workId = null,
  specDigest = null,
  planDigest = null,
  planStateDigest = null,
  decisionRecordIds = [],
  now = new Date().toISOString(),
}) {
  const digest = crypto.createHash('sha256').update(`${task.id}:${route.id}:${now}`).digest('hex').slice(0, 10);
  return {
    schemaVersion: 1,
    attemptId: `${task.id}-${digest}`,
    taskId: task.id,
    profile: {
      type: task.type,
      complexity: task.complexity,
      risk: task.risk,
      scope: task.scope,
      uncertainty: task.uncertainty,
    },
    routeId: route.id,
    runtime: route.runtime,
    model: route.model,
    effort: route.effort,
    policyVersion,
    baseline,
    workId,
    specDigest,
    planDigest,
    planStateDigest,
    decisionRecordIds: [...new Set(decisionRecordIds)].sort(),
    acceptanceCriteria: [...new Set(task.acceptanceCriteria || [])].sort(),
    expectedFiles: [...new Set(task.files || [])].sort(),
    verificationCommand: task.verify || null,
    startedAt: now,
    status: 'running',
  };
}

module.exports = {
  QUALITY_FLOORS,
  buildRuntimeCommand,
  classifyOutcome,
  createAttempt,
  nextOpenTask,
  planContractDigest,
  parsePlan,
  parseRuntimeUsage,
  selectRoute,
  validatePlan,
  wilsonLowerBound,
};
