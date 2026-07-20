const crypto = require('node:crypto');

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
  'change map',
  'streams',
  'acceptance criteria',
  'open questions',
];

const TASK_BUDGETS = {
  S: { files: 3, acceptanceCriteria: 1, text: 240 },
  M: { files: 6, acceptanceCriteria: 2, text: 420 },
  L: { files: 10, acceptanceCriteria: 3, text: 650 },
};
const RED_MODES = ['assertion', 'compile', 'runtime'];
const TEST_BOUNDARIES = ['unit', 'integration', 'e2e'];
const RISK_STRENGTH = { low: 1, medium: 2, high: 3, critical: 4 };

function planContractDigest(plan) {
  if (typeof plan !== 'string') throw new TypeError('Pair plan must be a string');
  const normalized = plan
    .replace(
      /^(\s*[-*]\s+)\[[-xX ]\](\s+(?:Task\b|AC-[1-9][0-9]*:))/gm,
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

function parseConsumes(raw) {
  if (!raw || /^none\.?$/i.test(raw.trim())) return [];
  const entries = [];
  for (const match of raw.matchAll(/(?:^|;)\s*(repository|[A-Za-z0-9._-]+)\s*:\s*`([^`]+)`/gi)) {
    entries.push({ source: match[1], contract: match[2].trim() });
  }
  return entries;
}

function parseProduces(raw) {
  if (!raw || /^none\.?$/i.test(raw.trim())) return [];
  return [...raw.matchAll(/`([^`]+)`/g)].map(match => match[1].trim());
}

function parseTestBoundaries(raw) {
  if (!raw) return [];
  return raw.split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
}

function taskFromParts(id, rawText, lineNumber, prefix = '') {
  const fileClause = rawText.match(/\s*[-:–—]\s*files?:\s*((?:`[^`]+`(?:\s*,\s*)?)+)/i)?.[1] || '';
  const files = [...fileClause.matchAll(/`([^`]+)`/g)].map(item => item[1]);
  const testFileClause = rawText.match(/\s*[-:–—]\s*tests?:\s*((?:`[^`]+`(?:\s*,\s*)?)+)/i)?.[1] || '';
  const testFiles = [...testFileClause.matchAll(/`([^`]+)`/g)].map(item => item[1]);
  const redVerify = rawText.match(/\s*[-:–—]\s*red:\s*`([^`]+)`/i)?.[1]?.trim() || '';
  const redExpected = rawText.match(/\s*[-:–—]\s*red-expect:\s*`([^`]+)`/i)?.[1]?.trim() || '';
  const verify = rawText.match(/\s*[-:–—]\s*verify:\s*`([^`]+)`/i)?.[1]?.trim() || '';
  const complexityMatch = rawText.match(/\*\*([SML])\*\*/i);
  const complexity = complexityMatch?.[1]?.toUpperCase() || 'M';
  const tags = Object.fromEntries([...rawText.matchAll(/\[(type|risk|scope|uncertainty|phase|ac|tdd|red|test):([^\]]+)\]/gi)]
    .map(item => [item[1].toLowerCase(), item[2].trim()]));
  const acceptanceCriteria = (tags.ac || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const text = rawText
    .replace(/\s*\[(?:type|risk|scope|uncertainty|phase|ac|tdd|red|test):[^\]]+\]/gi, '')
    .replace(/\s*[-:–—]\s*files?:\s*(?:`[^`]+`(?:\s*,\s*)?)+/i, '')
    .replace(/\s*[-:–—]\s*tests?:\s*(?:`[^`]+`(?:\s*,\s*)?)+/i, '')
    .replace(/\s*[-:–—]\s*red-expect:\s*`[^`]+`/i, '')
    .replace(/\s*[-:–—]\s*red:\s*`[^`]+`/i, '')
    .replace(/\s*[-:–—]\s*verify:\s*`[^`]+`/i, '')
    .replace(/\s*(?:[-:–—·])\s*\*\*[SML]\*\*/gi, '')
    .trim();
  const joined = `${text} ${files.join(' ')}`;

  return {
    id,
    text: `${prefix}${text}`,
    description: text,
    complexity,
    complexityExplicit: Boolean(complexityMatch),
    type: tags.type?.toLowerCase() || inferType(text),
    risk: tags.risk?.toLowerCase() || inferRisk(joined),
    scope: tags.scope?.toLowerCase() || inferScope(joined, files),
    uncertainty: tags.uncertainty?.toLowerCase()
      || (/\b(investigat|unknown|explor|spike)\b/i.test(text) ? 'high' : 'medium'),
    phase: tags.phase?.toLowerCase() || null,
    tddMode: tags.tdd?.toLowerCase() === 'cycle'
      ? 'cycle'
      : tags.tdd?.toLowerCase() === 'red-contract'
        ? 'red-contract'
        : tags.tdd?.match(/^covered-by\s+/i)
          ? 'covered-by'
          : null,
    tddCoveredBy: tags.tdd?.match(/^covered-by\s+([A-Za-z0-9._-]+)$/i)?.[1] || null,
    redMode: tags.red?.toLowerCase() || null,
    redVerify,
    redExpected,
    acceptanceCriteria,
    files,
    testFiles,
    verify,
    consumesRaw: '',
    consumes: [],
    producesRaw: '',
    produces: [],
    defect: '',
    reviewBoundary: '',
    testBoundaries: parseTestBoundaries(tags.test || ''),
    explicitTags: new Set(Object.keys(tags)),
    raw: rawText,
    line: lineNumber,
  };
}

function addTaskMetadata(task, label, value) {
  const normalized = label.toLowerCase();
  const clause = {
    profile: value,
    files: ` - files: ${value}`,
    tests: ` - tests: ${value}`,
    red: ` - red: ${value}`,
    'red expect': ` - red-expect: ${value}`,
    verify: ` - verify: ${value}`,
  }[normalized];
  if (!clause) return;

  const reparsed = taskFromParts(task.id, `${task.description} ${task.metadataRaw || ''}${clause}`, task.line);
  const preserved = {
    checked: task.checked,
    streamId: task.streamId,
    consumesRaw: task.consumesRaw,
    consumes: task.consumes,
    producesRaw: task.producesRaw,
    produces: task.produces,
    defect: task.defect,
    reviewBoundary: task.reviewBoundary,
  };
  Object.assign(task, reparsed, preserved, {
    metadataRaw: `${task.metadataRaw || ''}${clause}`,
  });
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
  let currentTask = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const sectionHeading = line.match(/^##\s+(.+)\s*$/);
    if (sectionHeading) {
      currentSection = sectionHeading[1].trim().toLowerCase();
      currentStream = null;
      currentTask = null;
      continue;
    }

    if (currentSection !== 'streams') {
      if (currentSection !== 'acceptance criteria' && /^\s*[-*]\s+\[[ -]\]\s+/.test(line)) {
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
      currentTask = null;
      continue;
    }

    if (!currentStream) continue;
    const dependency = line.match(/^\*\*Depends on:\*\*\s*(.+)\s*$/i);
    if (dependency) {
      currentStream.dependsOn = parseDependencies(dependency[1]);
      continue;
    }

    const taskContract = line.match(/^\s{2,}[-*]\s+\*\*(Consumes|Produces|Defect|Review boundary|Test boundary):\*\*\s*(.+)\s*$/i);
    if (taskContract && currentTask) {
      const key = taskContract[1].toLowerCase();
      const value = taskContract[2].trim();
      if (key === 'consumes') {
        currentTask.consumesRaw = value;
        currentTask.consumes = parseConsumes(value);
      } else if (key === 'produces') {
        currentTask.producesRaw = value;
        currentTask.produces = parseProduces(value);
      } else if (key === 'defect') currentTask.defect = value;
      else if (key === 'review boundary') currentTask.reviewBoundary = value;
      else if (key === 'test boundary') currentTask.testBoundaries = parseTestBoundaries(value);
      continue;
    }

    const taskMetadata = line.match(/^\s{2,}[-*]\s+\*\*(Profile|Files|Tests|Red|Red expect|Verify):\*\*\s*(.+)\s*$/i);
    if (taskMetadata && currentTask) {
      addTaskMetadata(currentTask, taskMetadata[1], taskMetadata[2].trim());
      continue;
    }

    const checkbox = line.match(/^\s*[-*]\s+\[([ xX-])\]\s+(.+)$/);
    if (!checkbox) continue;
    const taskMatch = checkbox[2].match(/^(?:Task\s+)?([A-Za-z0-9._-]+)\s*[-:–—]\s*(.+)$/i);
    if (!taskMatch) {
      malformedTaskLines.push({ line: index + 1, text: checkbox[2] });
      continue;
    }
    const task = taskFromParts(taskMatch[1], taskMatch[2], index + 1);
    task.checked = checkbox[1].toLowerCase() === 'x';
    task.active = checkbox[1] === '-';
    task.marker = task.checked ? 'accepted' : task.active ? 'active' : 'queued';
    task.streamId = currentStream.id;
    currentStream.tasks.push(task);
    tasks.push(task);
    currentTask = task;
  }

  const acceptanceCriteria = [];
  const malformedAcceptanceCriteria = [];
  for (const item of sections.get('acceptance criteria')?.lines || []) {
    const checkbox = item.text.match(/^\s*[-*]\s+\[([ xX-])\]\s+(.+)$/);
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
      active: checkbox[1] === '-',
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

  const changeMap = (sections.get('change map')?.lines || [])
    .filter(item => /^\s*[-*]\s+`[^`]+`\s+[-–—:]/.test(item.text))
    .map(item => ({
      ...item,
      path: item.text.match(/`([^`]+)`/)?.[1] || '',
    }));

  const verificationLines = [
    ...(sections.get('intent contract')?.lines || []),
    ...(sections.get('implementation context')?.lines || []),
  ].filter(item => /\*\*Verification:\*\*/i.test(item.text));
  const fullVerificationCommands = [...new Set(verificationLines.flatMap(item =>
    [...item.text.matchAll(/`([^`]+)`/g)].map(match => match[1].trim()),
  ).filter(Boolean))];

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
    changeMap,
    fullVerificationCommands,
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

function minimumRisk(task) {
  if (task.risk === 'critical') return 'critical';
  if (task.scope === 'contract' || task.scope === 'architecture') return 'high';
  if (task.scope === 'cross-module' || task.complexity === 'L'
      || task.files.length > 3 || task.acceptanceCriteria.length > 1) return 'medium';
  return 'low';
}

function isRepositoryRelativeFile(file) {
  return Boolean(file)
    && !file.startsWith('/')
    && !file.startsWith('~')
    && !file.split(/[\\/]/).includes('..');
}

function validateLitePlan(plan, parsed) {
  const errors = [];
  const warnings = [];
  const requiredSections = [
    'intent contract',
    'streams',
    'acceptance criteria',
    'open questions',
  ];

  if (/plan-phase:\s*sketch|<!--\s*sketch/i.test(plan)) {
    errors.push('plan is still a sketch');
  }
  if (Buffer.byteLength(plan, 'utf8') > 24 * 1024) {
    errors.push('Pair-lite plan exceeds 24 KiB; keep repository investigation and history outside the executable plan');
  }
  if (parsed.tasks.length > 12) {
    errors.push(`Pair-lite plan has ${parsed.tasks.length} tasks; split independent Work capabilities (maximum 12 slices)`);
  }
  for (const name of requiredSections) {
    const section = parsed.sections.get(name);
    if (!section) errors.push(`missing ## ${name.replace(/\b\w/g, value => value.toUpperCase())} section`);
    else if (!sectionContent(section)) errors.push(`## ${section.heading} section is empty`);
  }
  const intent = sectionContent(parsed.sections.get('intent contract'));
  for (const field of ['Spec', 'Purpose', 'Repository evidence', 'Constraints', 'Verification']) {
    const match = intent.match(new RegExp(`\\*\\*${escapeRegExp(field)}:\\*\\*[ \\t]*([^\\r\\n]*)`, 'i'));
    if (!match) errors.push(`## Intent Contract is missing **${field}:**`);
    else if (!isConcreteValue(match[1])) errors.push(`**${field}:** must have a concrete value in ## Intent Contract`);
  }
  const fullVerificationLine = parsed.sections.get('intent contract')?.lines
    .find(item => /\*\*Verification:\*\*/i.test(item.text));
  if (fullVerificationLine && !/`[^`]+`/.test(fullVerificationLine.text)) {
    errors.push('**Verification:** must contain at least one exact backticked command');
  }
  for (const item of parsed.executableCheckboxesOutsidePlan) {
    errors.push(`line ${item.line} has an executable checkbox outside ## Streams; keep only task and Acceptance Criteria state in the plan`);
  }
  if (parsed.streams.length === 0) errors.push('no stream headings found under ## Streams');
  for (const malformed of parsed.malformedTaskLines) {
    errors.push(`line ${malformed.line} has a task checkbox without a stable task ID`);
  }
  if (parsed.tasks.length === 0) errors.push('no runnable tasks with stable IDs found');

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

  const taskIds = new Set();
  for (const task of parsed.tasks) {
    if (taskIds.has(task.id)) errors.push(`duplicate task ID ${task.id}`);
    taskIds.add(task.id);
    if (!task.explicitTags.has('risk')) errors.push(`Task ${task.id} is missing explicit risk`);
    else if (!PROFILE_VALUES.risk.includes(task.risk)) errors.push(`Task ${task.id} has invalid risk "${task.risk}"`);
    if (!task.complexityExplicit) errors.push(`Task ${task.id} is missing explicit S/M/L complexity`);
    if (task.files.length === 0) errors.push(`Task ${task.id} must name at least one owned file`);
    for (const file of task.files) {
      if (!isRepositoryRelativeFile(file)) {
        errors.push(`Task ${task.id} file ${file} is outside the repository`);
      }
    }
    if (!task.verify) errors.push(`Task ${task.id} must include an exact verify command`);
    if (task.acceptanceCriteria.length === 0) errors.push(`Task ${task.id} must reference at least one acceptance criterion with [ac:...]`);
    for (const criterion of task.acceptanceCriteria) {
      coveredCriteria.add(criterion);
      if (!criterionIds.has(criterion)) errors.push(`Task ${task.id} references unknown acceptance criterion ${criterion}`);
    }
    if (task.uncertainty === 'high') {
      errors.push(`Task ${task.id} still expresses unresolved investigation; ground it before promotion`);
    }
    const floor = minimumRisk(task);
    if (RISK_STRENGTH[task.risk] < RISK_STRENGTH[floor]) {
      errors.push(`Task ${task.id} risk ${task.risk} understates its ${task.scope}/${task.complexity} change shape; minimum risk is ${floor}`);
    }
    const budget = TASK_BUDGETS[task.complexity] || TASK_BUDGETS.M;
    if (task.files.length > budget.files) {
      errors.push(`Task ${task.id} owns ${task.files.length} files; ${task.complexity} slices may own at most ${budget.files}`);
    }
    if (task.acceptanceCriteria.length > budget.acceptanceCriteria) {
      errors.push(`Task ${task.id} maps ${task.acceptanceCriteria.length} acceptance criteria; ${task.complexity} slices may map at most ${budget.acceptanceCriteria}`);
    }
    if (task.text.length > budget.text) {
      errors.push(`Task ${task.id} description is ${task.text.length} characters; ${task.complexity} slices are limited to ${budget.text}`);
    }
    if (task.type !== 'docs') {
      if (task.testFiles.length === 0) {
        errors.push(`Task ${task.id} must identify its test-owned files with - tests: \`...\``);
      }
      for (const testFile of task.testFiles) {
        if (!task.files.includes(testFile)) errors.push(`Task ${task.id} test file ${testFile} is not included in its owned files`);
      }
      if (task.testBoundaries.length === 0) {
        errors.push(`Task ${task.id} must declare [test:unit|integration|e2e]`);
      }
      for (const boundary of task.testBoundaries) {
        if (!TEST_BOUNDARIES.includes(boundary)) errors.push(`Task ${task.id} has unsupported test boundary "${boundary}"`);
      }
    }
  }
  for (const criterion of parsed.acceptanceCriteria) {
    if (!coveredCriteria.has(criterion.id)) errors.push(`acceptance criterion ${criterion.id} is not covered by any task`);
  }
  const integrationTasks = parsed.tasks.filter((task) =>
    task.testBoundaries.includes('integration') || task.testBoundaries.includes('e2e'),
  );
  if (integrationTasks.length === 0) {
    errors.push('no Pair-lite slice declares an integration or e2e test boundary for the Acceptance Criteria');
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

function validatePlan(plan) {
  const parsed = parsePlan(plan);
  if (/^\*\*Pair mode:\*\*\s*lite\s*$/im.test(plan)) {
    return validateLitePlan(plan, parsed);
  }
  const errors = [];
  const warnings = [];

  if (/plan-phase:\s*sketch|<!--\s*sketch/i.test(plan)) {
    errors.push('plan is still a sketch');
  }
  if (Buffer.byteLength(plan, 'utf8') > 64 * 1024) {
    errors.push('plan exceeds 64 KiB; split independent subsystems into separate Work plans and keep execution history out of the plan contract');
  }
  if (parsed.tasks.length > 24) {
    errors.push(`plan has ${parsed.tasks.length} tasks; split independent subsystems into separate Work plans (maximum 24 Review Slices)`);
  }
  for (const sectionName of parsed.sections.keys()) {
    if (/^(?:execution|implementation|progress|recovery)(?: log| history| notes)?$/i.test(sectionName)) {
      errors.push(`## ${parsed.sections.get(sectionName).heading} does not belong in the plan contract; use the attempt ledger or canonical Work evidence`);
    }
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
  if (parsed.changeMap.length === 0) errors.push('## Change Map must map exact repository-relative files to one responsibility each');
  const changeMapPaths = new Set(parsed.changeMap.map(item => item.path));

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
    for (const file of task.files) {
      if (!isRepositoryRelativeFile(file)) {
        errors.push(`Task ${task.id} file ${file} is outside the repository; create a separate Work plan for the other repository`);
      }
      if (!changeMapPaths.has(file)) errors.push(`Task ${task.id} file ${file} is missing from ## Change Map`);
    }
    if (!task.verify) errors.push(`Task ${task.id} must include an exact verify command`);
    if (task.acceptanceCriteria.length === 0) errors.push(`Task ${task.id} must reference at least one acceptance criterion with [ac:...]`);
    for (const criterion of task.acceptanceCriteria) {
      coveredCriteria.add(criterion);
      if (!criterionIds.has(criterion)) errors.push(`Task ${task.id} references unknown acceptance criterion ${criterion}`);
    }
    if (task.uncertainty === 'high') {
      errors.push(`Task ${task.id} has high uncertainty; resolve it with capability evidence before promotion`);
    }
    const floor = minimumRisk(task);
    if (RISK_STRENGTH[task.risk] < RISK_STRENGTH[floor]) {
      errors.push(`Task ${task.id} risk ${task.risk} understates its ${task.scope}/${task.complexity} change shape; minimum risk is ${floor}`);
    }

    const budget = TASK_BUDGETS[task.complexity] || TASK_BUDGETS.M;
    if (task.files.length > budget.files) {
      errors.push(`Task ${task.id} owns ${task.files.length} files; ${task.complexity} Review Slices may own at most ${budget.files}`);
    }
    if (task.acceptanceCriteria.length > budget.acceptanceCriteria) {
      errors.push(`Task ${task.id} maps ${task.acceptanceCriteria.length} acceptance criteria; ${task.complexity} Review Slices may map at most ${budget.acceptanceCriteria}`);
    }
    if (task.text.length > budget.text) {
      errors.push(`Task ${task.id} description is ${task.text.length} characters; ${task.complexity} Review Slices are limited to ${budget.text} — split independent behavior`);
    }

    if (task.type !== 'docs') {
      if (!task.consumesRaw || (task.consumes.length === 0 && !/^none\.?$/i.test(task.consumesRaw))) {
        errors.push(`Task ${task.id} must declare parseable **Consumes:** entries as repository:\`contract\` or <task-id>:\`contract\``);
      }
      if (!task.producesRaw || task.produces.length === 0) {
        errors.push(`Task ${task.id} must declare at least one exact **Produces:** contract`);
      }
      if (!isConcreteValue(task.defect)) errors.push(`Task ${task.id} must name one concrete **Defect:** class`);
      if (!isConcreteValue(task.reviewBoundary)) errors.push(`Task ${task.id} must state an independently approvable **Review boundary:**`);
    }

    if (task.phase && task.phase !== 'red') errors.push(`Task ${task.id} has unsupported phase "${task.phase}"`);
    if (task.type === 'test') {
      if (task.phase !== 'red' || task.tddMode !== 'red-contract') {
        errors.push(`Task ${task.id} is a standalone test contract and must use [type:test] [phase:red] [tdd:red-contract]`);
      }
    } else if (task.phase) {
      errors.push(`Task ${task.id} uses phase:red but is not a standalone [type:test] [tdd:red-contract] task`);
    }
    if (task.type !== 'docs' && !['cycle', 'covered-by', 'red-contract'].includes(task.tddMode)) {
      errors.push(`Task ${task.id} must use [tdd:cycle], [tdd:covered-by <task-id>], or the exceptional [tdd:red-contract]`);
    }
    if (task.tddMode === 'cycle' || task.tddMode === 'red-contract') {
      if (task.testFiles.length === 0) errors.push(`Task ${task.id} must identify its test-owned files with - tests: \`...\``);
      for (const testFile of task.testFiles) {
        if (!task.files.includes(testFile)) errors.push(`Task ${task.id} test file ${testFile} is not included in its owned files`);
      }
      if (!RED_MODES.includes(task.redMode)) errors.push(`Task ${task.id} must declare [red:${RED_MODES.join('|')}]`);
      if (!task.redVerify) errors.push(`Task ${task.id} must include an exact red command with - red: \`...\``);
      if (!isConcreteValue(task.redExpected)) errors.push(`Task ${task.id} must include a concrete - red-expect: \`...\` signal`);
      if (task.testBoundaries.length === 0) errors.push(`Task ${task.id} must declare **Test boundary:** unit, integration, or e2e`);
      for (const boundary of task.testBoundaries) {
        if (!TEST_BOUNDARIES.includes(boundary)) errors.push(`Task ${task.id} has unsupported test boundary "${boundary}"`);
      }
    }
    if (task.explicitTags.has('tdd') && !task.tddMode) {
      errors.push(`Task ${task.id} has a malformed tdd tag; use cycle, red-contract, or covered-by <task-id>`);
    }
  }

  const tasksById = new Map(parsed.tasks.map(task => [task.id, task]));
  const taskOrder = new Map(parsed.tasks.map((task, index) => [task.id, index]));
  for (const task of parsed.tasks) {
    if (task.tddCoveredBy) {
      const covering = tasksById.get(task.tddCoveredBy);
      if (!covering) errors.push(`Task ${task.id} declares tdd:covered-by unknown task ${task.tddCoveredBy}`);
      else if (!['cycle', 'red-contract'].includes(covering.tddMode)) {
        errors.push(`Task ${task.id} tdd:covered-by must reference a prior [tdd:cycle] or [tdd:red-contract] Review Slice`);
      } else if (taskOrder.get(covering.id) >= taskOrder.get(task.id)) {
        errors.push(`Task ${task.id} tdd:covered-by references ${covering.id}, which is not earlier in plan order`);
      }
    }
    for (const consumed of task.consumes) {
      if (consumed.source.toLowerCase() === 'repository') continue;
      const producer = tasksById.get(consumed.source);
      if (!producer) {
        errors.push(`Task ${task.id} consumes ${consumed.contract} from unknown Task ${consumed.source}`);
      } else if (taskOrder.get(producer.id) >= taskOrder.get(task.id)) {
        errors.push(`Task ${task.id} consumes ${consumed.contract} from Task ${producer.id}, which is not earlier in plan order`);
      } else if (!producer.produces.includes(consumed.contract)) {
        errors.push(`Task ${task.id} consumes ${consumed.contract} from Task ${producer.id}, but that exact contract is not produced there`);
      }
    }
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
    const cycleExempt = stream.tasks.length > 0
      && stream.tasks.every(task => task.type === 'docs' || task.tddCoveredBy);
    if (!first || (!['cycle', 'red-contract'].includes(first.tddMode) && !cycleExempt)) {
      errors.push(`Stream ${stream.id} must start with a behavior-sized [tdd:cycle] or [tdd:red-contract] Review Slice, unless every task is docs or covered by an earlier slice`);
    }
  }

  const integrationTasks = parsed.tasks.filter(task => task.testBoundaries.includes('integration') || task.testBoundaries.includes('e2e'));
  if (integrationTasks.length === 0) errors.push('no TDD Review Slice declares integration or e2e verification for the acceptance criteria');

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
  const parsed = parsePlan(plan);
  if (parsed.tasks.length > 0) {
    const open = parsed.tasks.find(task => task.active)
      || parsed.tasks.find(task => !task.checked);
    if (open) return open;
  }
  // Acceptance Criteria are completion state, not executable work. Canonical Pair
  // plans declare their model work under Streams; once those tasks are closed the
  // runner is finished. The generic checkbox fallback remains available for the
  // deliberately simpler .claude-loop.md format, which has no Stream contract.
  if (parsed.streams.length > 0) return null;
  const lines = plan.split(/\r?\n/);
  let explicitSection = '';
  for (let index = 0; index < lines.length; index++) {
    const heading = lines[index].match(/^##\s+(.+)/);
    if (heading) explicitSection = heading[1].trim().toLowerCase();
    if (explicitSection === 'acceptance criteria') continue;
    const match = lines[index].match(/^\s*[-*]\s+\[[ -]\]\s+(?:Task\s+)?([A-Za-z0-9._-]+)\s*[-:–—]\s*(.+)$/i);
    if (match) return taskFromParts(match[1], match[2].trim(), index + 1);
  }

  for (const targetSection of ['tasks', 'acceptance criteria']) {
    let section = '';
    let ordinal = 0;
    for (let index = 0; index < lines.length; index++) {
      const heading = lines[index].match(/^##\s+(.+)/);
      if (heading) section = heading[1].trim().toLowerCase();
      const checkbox = lines[index].match(/^\s*[-*]\s+\[([ xX-])\]\s+(.+)$/);
      if (!checkbox || section !== targetSection) continue;
      ordinal++;
      if (![' ', '-'].includes(checkbox[1])) continue;
      if (targetSection === 'tasks') return taskFromParts(`loop.${ordinal}`, checkbox[2].trim(), index + 1);
      const namedCriterion = checkbox[2].match(/^([A-Za-z0-9._-]+)\s*:\s*(.+)$/);
      const id = namedCriterion?.[1] || `AC${ordinal}`;
      const text = namedCriterion?.[2] || checkbox[2].trim();
      return taskFromParts(id, text, index + 1, 'verify acceptance criterion: ');
    }
  }
  return null;
}

function staticStrength(profile) {
  if (profile.risk === 'critical' || profile.uncertainty === 'high') return 4;
  if (profile.risk === 'high' || profile.complexity === 'L'
      || profile.scope === 'contract' || profile.scope === 'architecture'
      || (profile.files?.length || 0) > 6
      || (profile.acceptanceCriteria?.length || 0) > 2) return 3;
  if (profile.risk === 'medium' || profile.complexity === 'M' || profile.scope === 'cross-module') return 2;
  return 1;
}

// Static routing policy. Learned per-profile routing needs fleet-scale evidence
// (>=5 valid same-profile samples per route) that a single developer never
// accumulates, so the exploration ladder only ever added failed cheap attempts on
// the way to the strong model (attempts ledger 2026-07: cheapest tier 0% accepted;
// feature/high accepted only on the opus tiers). Strength is decided by the task
// profile alone, floored at the second tier for code-writing work — the cheapest
// tier is reserved for docs-type tasks because it cannot reliably emit structured
// worker results.
function selectRoute(profile, routes) {
  if (!Array.isArray(routes) || routes.length === 0) throw new Error('No model routes are configured');
  const ranked = routes.map((route, index) => ({ ...route, strength: route.strength ?? index + 1 }));
  const strongest = ranked.reduce((best, route) => route.strength > best.strength ? route : best, ranked[0]);
  const invalidProfile = Object.entries(PROFILE_VALUES)
    .some(([key, allowed]) => profile[key] && !allowed.includes(profile[key]));
  if (invalidProfile || profile.risk === 'critical' || profile.uncertainty === 'high') return strongest;
  const needed = profile.type === 'docs'
    ? staticStrength(profile)
    : Math.max(2, staticStrength(profile));
  return ranked.find(route => route.strength >= needed) || strongest;
}

function classifyOutcome({ workerStatus, workerBlocker = '', verification, ownership = null, findings = [], priorRetryCounts = {}, runtimeStatus = 0, reviewStatus = 0, recommendedAction = 'approve', workerParseError = false }) {
  const retried = action => (priorRetryCounts[action] || 0) > 0;
  // A runtime that exits non-zero failed to run (spawn error, timeout, shim collision):
  // a stronger model cannot fix that, so retry the SAME route once. Never train routing on
  // it; a blocker the worker actually authored is handled by the task-ambiguity branch below.
  if (runtimeStatus !== 0) {
    return retried('retry-infrastructure')
      ? { disposition: 'human-takeover', action: 'stop', cause: 'environment-failure' }
      : { disposition: 'regenerated', action: 'retry-infrastructure', cause: 'environment-failure' };
  }
  // The runtime exited clean but produced output we cannot parse into the worker schema.
  // This is usually a model too weak to emit structured output (e.g. the cheapest tier), so
  // retry on a STRONGER route rather than burning another attempt on the same one.
  if (workerParseError) {
    return retried('retry-stronger')
      ? { disposition: 'human-takeover', action: 'stop', cause: 'environment-failure' }
      : { disposition: 'regenerated', action: 'retry-stronger', cause: 'environment-failure' };
  }
  if (workerStatus === 'blocked' && /\bincorrect-plan\b/i.test(workerBlocker)) {
    return { disposition: 'redesign', action: 'return-to-promotion', cause: 'incorrect-plan' };
  }
  // Crossing the Review Slice boundary is neither a generic verification defect nor
  // proof that the plan is wrong. Feed the exact boundary evidence back once; if the
  // same class recurs, promotion must decide whether ownership needs to expand.
  if (ownership?.status === 'fail') {
    return retried('retry-ownership')
      ? { disposition: 'redesign', action: 'return-to-promotion', cause: 'incorrect-plan' }
      : { disposition: 'regenerated', action: 'retry-ownership', cause: 'integration-conflict' };
  }
  if (workerStatus === 'blocked' && /^verification-defect:/i.test(workerBlocker)) {
    return retried('retry-verification')
      ? { disposition: 'human-takeover', action: 'stop', cause: 'verification-defect' }
      : { disposition: 'regenerated', action: 'retry-verification', cause: 'verification-defect' };
  }
  if (workerStatus === 'blocked') {
    return retried('retry-context')
      ? { disposition: 'human-takeover', action: 'stop', cause: 'task-ambiguity' }
      : { disposition: 'regenerated', action: 'retry-context', cause: 'task-ambiguity' };
  }
  if (reviewStatus !== 0) {
    return retried('retry-infrastructure')
      ? { disposition: 'human-takeover', action: 'stop', cause: 'reviewer-error' }
      : { disposition: 'regenerated', action: 'retry-infrastructure', cause: 'reviewer-error' };
  }
  // Materiality gate: a recommendation is only actionable when backed by at least one
  // BLOCKER/MAJOR finding with a concrete failure scenario. A reviewer that says
  // fix/rewrite/redesign while itemizing nothing material is noise, and acting on it
  // burns a full attempt cycle — so it is ignored and the verified work is accepted.
  const blockers = findings.filter(finding => finding.severity === 'BLOCKER').length;
  const majors = findings.filter(finding => finding.severity === 'MAJOR').length;
  const material = blockers + majors;
  const environmentFindings = findings.filter(finding => finding.origin === 'environment').length;
  if (environmentFindings > 0) {
    return retried('retry-infrastructure')
      ? { disposition: 'human-takeover', action: 'stop', cause: 'environment-failure' }
      : { disposition: 'regenerated', action: 'retry-infrastructure', cause: 'environment-failure' };
  }
  const planFindings = findings.filter(finding => finding.origin === 'plan').length;
  if (planFindings > 0) {
    return { disposition: 'redesign', action: 'return-to-promotion', cause: 'incorrect-plan' };
  }
  if (recommendedAction === 'redesign' && material > 0) {
    return { disposition: 'redesign', action: 'return-to-promotion', cause: 'incorrect-plan' };
  }
  if (recommendedAction === 'local-fix' && material > 0) {
    return { disposition: 'local-fix', action: 'local-fix', cause: 'model-capability' };
  }
  if (recommendedAction === 'rewrite' && material > 0) {
    return retried('retry-review')
      ? { disposition: 'human-takeover', action: 'stop', cause: 'model-capability' }
      : { disposition: 'regenerated', action: 'retry-review', cause: 'model-capability' };
  }
  if (verification === 'fail') {
    return retried('retry-verification')
      ? { disposition: 'human-takeover', action: 'stop', cause: 'verification-defect' }
      : { disposition: 'regenerated', action: 'retry-verification', cause: 'verification-defect' };
  }

  if (blockers > 0 || majors > 0) {
    return retried('retry-review')
      ? { disposition: 'human-takeover', action: 'stop', cause: 'model-capability' }
      : { disposition: 'regenerated', action: 'retry-review', cause: 'model-capability' };
  }
  return { disposition: 'accepted', action: 'complete-task', cause: null };
}

// A review is only trustworthy if it carries a schema verdict and a findings array.
// A truncated reviewer result (e.g. the review model hitting an account session limit)
// parses into a partial object that is missing findings; treating it as a real verdict
// once produced bogus "redesign" dispositions and crashed writeReviewFiles.
function reviewIsWellFormed(review) {
  const text = value => typeof value === 'string' && value.trim().length > 0;
  return Boolean(review)
    && (review.verdict === 'approve' || review.verdict === 'fix-needed')
    && ['approve', 'local-fix', 'rewrite', 'redesign'].includes(review.recommended_action)
    && text(review.summary)
    && Array.isArray(review.findings)
    && review.findings.every(finding => Boolean(finding)
      && (finding.severity === 'BLOCKER' || finding.severity === 'MAJOR')
      && ['implementation', 'plan', 'environment'].includes(finding.origin)
      && text(finding.file)
      && Number.isInteger(finding.line)
      && finding.line >= 1
      && text(finding.title)
      && text(finding.detail)
      && text(finding.failure_scenario)
      && text(finding.suggestion));
}

// Coerce any parsed review into the review schema shape so downstream classification
// and file writing never touch an undefined field. Fills gaps only; never invents a
// verdict beyond a safe fix-needed default when one is missing.
// Only material findings (BLOCKER/MAJOR) survive: anything else is workflow noise that
// must never reach the worker, the plan, or the disposition — dropped here so every
// consumer sees the same filtered view regardless of which runtime produced the review.
function normalizeReview(review) {
  const source = review && typeof review === 'object' ? review : {};
  const findings = Array.isArray(source.findings)
    ? source.findings.filter(finding => finding && typeof finding === 'object'
      && (finding.severity === 'BLOCKER' || finding.severity === 'MAJOR'))
    : [];
  const verdict = source.verdict === 'approve' ? 'approve' : 'fix-needed';
  const recommendedAction = ['approve', 'local-fix', 'rewrite', 'redesign'].includes(source.recommended_action)
    ? source.recommended_action
    : (verdict === 'approve' ? 'approve' : 'rewrite');
  const summary = typeof source.summary === 'string' && source.summary.trim()
    ? source.summary
    : 'review returned no parseable summary';
  return { verdict, recommended_action: recommendedAction, summary, findings };
}

// The safety cap and escalation must count real attempts at the task, not toolchain
// interruptions. An interrupted attempt (hard kill/crash/manual .pair reset, recorded
// status:'interrupted') did not exercise the model, so it must not consume the retry
// budget nor push classifyOutcome toward human-takeover. Pair v4 treats repeated
// interruptions as observable recovery evidence, never as a count-based stop condition.
function attemptCapStatus(history, maxAttempts) {
  const records = Array.isArray(history) ? history : [];
  const substantiveRecords = records.filter(record => !['interrupted', 'completed-out-of-band'].includes(record.status));
  const retryCounts = {};
  for (const record of substantiveRecords) {
    if (typeof record.action !== 'string' || !record.action.startsWith('retry-')) continue;
    retryCounts[record.action] = (retryCounts[record.action] || 0) + 1;
  }
  const substantive = substantiveRecords.length;
  let trailingInterrupts = 0;
  for (let index = records.length - 1; index >= 0 && records[index]?.status === 'interrupted'; index--) {
    trailingInterrupts++;
  }
  return {
    substantive,
    trailingInterrupts,
    retryCounts,
    overCap: substantive >= maxAttempts,
    unstable: false,
    warning: trailingInterrupts >= 2 ? 'repeated-interruptions' : null,
  };
}

function buildRuntimeCommand({ runtime, root, prompt, model, effort, schemaPath, outputPath, schema, externalSandbox = false }) {
  if (runtime === 'codex') {
    const args = [
      'exec',
      '--json',
      '--ephemeral',
      ...(externalSandbox
        ? ['--dangerously-bypass-approvals-and-sandbox']
        : ['--sandbox', 'workspace-write']),
      '-C',
      root,
    ];
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
    tddMode: task.tddMode || null,
    redContract: task.redVerify ? {
      mode: task.redMode,
      command: task.redVerify,
      expectedSignal: task.redExpected,
    } : null,
    consumes: task.consumes || [],
    produces: task.produces || [],
    verificationCommand: task.verify || null,
    startedAt: now,
    status: 'running',
  };
}

module.exports = {
  attemptCapStatus,
  buildRuntimeCommand,
  classifyOutcome,
  createAttempt,
  nextOpenTask,
  normalizeReview,
  planContractDigest,
  parsePlan,
  parseRuntimeUsage,
  reviewIsWellFormed,
  selectRoute,
  validatePlan,
};
