const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { parsePlan, planContractDigest, providerExecutorInstruction, validatePlan } = require('./pair-core');
const { readPairEvents } = require('./pair-state');
const { validateEvidenceFile } = require('../../../brainstorming/scripts/work-lineage.cjs');

const IMPLEMENTATION_DESIGN_KIND = 'implementation-design-contract';
const MAX_DESIGN_BYTES = 128 * 1024;
const MAX_PACKET_BYTES = 16 * 1024;
const CHEAP_PACKET_BYTES = 8 * 1024;
const DECISION_ID = /^IMP-[0-9]{3}$/u;
const AC_ID = /^AC-[1-9][0-9]*$/u;
const EVIDENCE_PATH = /^docs\/work\/(work-[0-9]{8}-[a-z0-9]+(?:-[a-z0-9]+)*)\/evidence\/(EVD-[0-9]{3}-[a-z0-9]+(?:-[a-z0-9]+)*)\.json$/u;
const UNRESOLVED = /(?:\bTODO\b|\bTBD\b|\bunknown\b|to be determined|decide later|unresolved)/iu;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function repositoryRelative(value) {
  return typeof value === 'string'
    && value.length > 0
    && !path.isAbsolute(value)
    && !value.startsWith('~')
    && !value.split(/[\\/]/u).includes('..');
}

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function exactKeys(value, allowed, label, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${label} has unsupported field ${key}`);
  }
  return true;
}

function textArray(value, label, errors, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    errors.push(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array`);
    return [];
  }
  for (const [index, item] of value.entries()) {
    if (!isText(item)) errors.push(`${label}[${index}] must be non-blank text`);
    else if (UNRESOLVED.test(item)) errors.push(`${label}[${index}] contains an unresolved decision`);
  }
  return value;
}

function rejectProviderExecutorInstructions(value, label, errors) {
  if (typeof value === 'string') {
    if (providerExecutorInstruction(value)) errors.push(`${label} contains a provider-specific executor instruction`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectProviderExecutorInstructions(item, `${label}[${index}]`, errors));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    rejectProviderExecutorInstructions(item, `${label}.${key}`, errors);
  }
}

function validateImplementationDesignRecord(record) {
  const errors = [];
  const warnings = [];
  exactKeys(record, [
    'schema', 'id', 'work_id', 'kind', 'acceptance_criteria', 'decision_record_ids',
    'source', 'recorded_at', 'result',
  ], 'Implementation Design Contract', errors);
  if (record?.schema !== 1) errors.push('Implementation Design Contract schema must be 1');
  if (!/^EVD-[0-9]{3}-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(record?.id || '')) errors.push('Implementation Design Contract evidence ID is invalid');
  if (!/^work-[0-9]{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(record?.work_id || '')) errors.push('Implementation Design Contract Work ID is invalid');
  if (record?.kind !== IMPLEMENTATION_DESIGN_KIND) errors.push(`Implementation Design Contract kind must be ${IMPLEMENTATION_DESIGN_KIND}`);
  const outerCriteria = textArray(record?.acceptance_criteria, 'Implementation Design Contract acceptance_criteria', errors);
  for (const id of outerCriteria) if (!AC_ID.test(id)) errors.push(`invalid Acceptance Criterion ID ${id}`);
  if (new Set(outerCriteria).size !== outerCriteria.length) errors.push('Implementation Design Contract acceptance_criteria contains duplicates');
  if (!Array.isArray(record?.decision_record_ids)) errors.push('Implementation Design Contract decision_record_ids must be an array');
  else {
    if (new Set(record.decision_record_ids).size !== record.decision_record_ids.length) errors.push('Implementation Design Contract decision_record_ids contains duplicates');
    for (const id of record.decision_record_ids) {
      if (!/^DR-[0-9]{3}-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) errors.push(`invalid Decision Record ID ${id}`);
    }
  }
  if (!isText(record?.source)) errors.push('Implementation Design Contract source is required');
  if (!isText(record?.recorded_at) || Number.isNaN(Date.parse(record.recorded_at))) errors.push('Implementation Design Contract recorded_at must be an ISO date-time');
  if (Buffer.byteLength(JSON.stringify(record || {}), 'utf8') > MAX_DESIGN_BYTES) errors.push('Implementation Design Contract exceeds 128 KiB');

  const result = record?.result;
  if (exactKeys(result, ['schema', 'spec', 'repository_evidence', 'decisions'], 'Implementation Design Contract result', errors)) {
    if (result.schema !== 1) errors.push('Implementation Design Contract result schema must be 1');
    if (exactKeys(result.spec, ['path', 'sha256'], 'Implementation Design Contract spec', errors)) {
      if (!repositoryRelative(result.spec.path)) errors.push('Implementation Design Contract spec path must be repository-relative');
      if (!/^[a-f0-9]{64}$/u.test(result.spec.sha256 || '')) errors.push('Implementation Design Contract spec sha256 is invalid');
    }
    if (!Array.isArray(result.repository_evidence) || result.repository_evidence.length === 0) {
      errors.push('Implementation Design Contract repository_evidence must be a non-empty array');
    } else {
      const evidencePaths = new Set();
      for (const [index, evidence] of result.repository_evidence.entries()) {
        const label = `repository_evidence[${index}]`;
        exactKeys(evidence, ['path', 'symbols'], label, errors);
        if (!repositoryRelative(evidence?.path)) errors.push(`${label}.path must be repository-relative`);
        else if (evidencePaths.has(evidence.path)) errors.push(`duplicate repository evidence path ${evidence.path}`);
        else evidencePaths.add(evidence.path);
        const symbols = textArray(evidence?.symbols, `${label}.symbols`, errors);
        if (new Set(symbols).size !== symbols.length) errors.push(`${label}.symbols contains duplicates`);
      }
    }
    if (!Array.isArray(result.decisions) || result.decisions.length === 0) {
      errors.push('Implementation Design Contract decisions must be a non-empty array');
    } else if (result.decisions.length > 24) {
      errors.push('Implementation Design Contract may contain at most 24 decisions');
    } else {
      const decisionIds = new Set();
      for (const [index, decision] of result.decisions.entries()) {
        const label = `implementation decision ${decision?.id || index + 1}`;
        exactKeys(decision, [
          'id', 'outcome', 'acceptance_criteria', 'depends_on', 'symbols', 'call_paths',
          'contract', 'data_shapes', 'state_flow', 'wiring', 'failure_handling', 'deletions',
          'pattern_references', 'tests', 'verify', 'non_goals',
        ], label, errors);
        if (!DECISION_ID.test(decision?.id || '')) errors.push(`${label} has an invalid ID`);
        else if (decisionIds.has(decision.id)) errors.push(`duplicate implementation decision ID ${decision.id}`);
        else decisionIds.add(decision.id);
        if (!isText(decision?.outcome)) errors.push(`${label}.outcome is required`);
        else if (UNRESOLVED.test(decision.outcome)) errors.push(`${label}.outcome contains an unresolved decision`);
        for (const id of textArray(decision?.acceptance_criteria, `${label}.acceptance_criteria`, errors)) {
          if (!AC_ID.test(id)) errors.push(`${label} has invalid Acceptance Criterion ID ${id}`);
          if (!outerCriteria.includes(id)) errors.push(`${label} references Acceptance Criterion ${id} outside the evidence envelope`);
        }
        for (const id of textArray(decision?.depends_on, `${label}.depends_on`, errors, { allowEmpty: true })) {
          if (!DECISION_ID.test(id)) errors.push(`${label} has invalid dependency ${id}`);
        }
        if (!Array.isArray(decision?.symbols) || decision.symbols.length === 0) errors.push(`${label}.symbols must be a non-empty array`);
        else for (const [symbolIndex, symbol] of decision.symbols.entries()) {
          exactKeys(symbol, ['path', 'symbol', 'action'], `${label}.symbols[${symbolIndex}]`, errors);
          if (!repositoryRelative(symbol?.path)) errors.push(`${label}.symbols[${symbolIndex}].path must be repository-relative`);
          if (!isText(symbol?.symbol)) errors.push(`${label}.symbols[${symbolIndex}].symbol is required`);
          if (!['read', 'add', 'modify', 'delete'].includes(symbol?.action)) errors.push(`${label}.symbols[${symbolIndex}].action is invalid`);
        }
        textArray(decision?.call_paths, `${label}.call_paths`, errors);
        if (exactKeys(decision?.contract, ['before', 'after', 'errors'], `${label}.contract`, errors)) {
          textArray(decision.contract.before, `${label}.contract.before`, errors);
          textArray(decision.contract.after, `${label}.contract.after`, errors);
          textArray(decision.contract.errors, `${label}.contract.errors`, errors);
        }
        textArray(decision?.data_shapes, `${label}.data_shapes`, errors);
        textArray(decision?.state_flow, `${label}.state_flow`, errors);
        textArray(decision?.wiring, `${label}.wiring`, errors);
        textArray(decision?.failure_handling, `${label}.failure_handling`, errors);
        textArray(decision?.deletions, `${label}.deletions`, errors, { allowEmpty: true });
        if (!Array.isArray(decision?.pattern_references) || decision.pattern_references.length === 0) errors.push(`${label}.pattern_references must be a non-empty array`);
        else for (const [patternIndex, pattern] of decision.pattern_references.entries()) {
          exactKeys(pattern, ['path', 'symbol'], `${label}.pattern_references[${patternIndex}]`, errors);
          if (!repositoryRelative(pattern?.path)) errors.push(`${label}.pattern_references[${patternIndex}].path must be repository-relative`);
          if (!isText(pattern?.symbol)) errors.push(`${label}.pattern_references[${patternIndex}].symbol is required`);
        }
        if (!Array.isArray(decision?.tests) || decision.tests.length === 0) errors.push(`${label}.tests must be a non-empty array`);
        else for (const [testIndex, testCase] of decision.tests.entries()) {
          const testLabel = `${label}.tests[${testIndex}]`;
          exactKeys(testCase, ['name', 'file', 'boundary', 'purpose', 'red_signal'], testLabel, errors);
          if (!isText(testCase?.name)) errors.push(`${testLabel}.name is required`);
          if (!repositoryRelative(testCase?.file)) errors.push(`${testLabel}.file must be repository-relative`);
          if (!['unit', 'integration', 'e2e'].includes(testCase?.boundary)) errors.push(`${testLabel}.boundary is invalid`);
          for (const field of ['purpose', 'red_signal']) {
            if (!isText(testCase?.[field])) errors.push(`${testLabel}.${field} is required`);
            else if (UNRESOLVED.test(testCase[field])) errors.push(`${testLabel}.${field} contains an unresolved decision`);
          }
        }
        if (!isText(decision?.verify)) errors.push(`${label}.verify is required`);
        textArray(decision?.non_goals, `${label}.non_goals`, errors);
        rejectProviderExecutorInstructions(decision, label, errors);
      }
      for (const decision of result.decisions) {
        for (const dependency of decision.depends_on || []) {
          if (!decisionIds.has(dependency)) errors.push(`implementation decision ${decision.id} depends on missing ${dependency}`);
          if (dependency === decision.id) errors.push(`implementation decision ${decision.id} cannot depend on itself`);
        }
      }
      const visiting = new Set();
      const visited = new Set();
      const visit = id => {
        if (visiting.has(id)) {
          errors.push(`implementation decision dependency cycle includes ${id}`);
          return;
        }
        if (visited.has(id) || !decisionIds.has(id)) return;
        visiting.add(id);
        const decision = result.decisions.find(item => item.id === id);
        for (const dependency of decision?.depends_on || []) visit(dependency);
        visiting.delete(id);
        visited.add(id);
      };
      for (const id of decisionIds) visit(id);
    }
  }
  return { valid: errors.length === 0, errors, warnings, record };
}

function fieldValue(plan, field) {
  return plan.match(new RegExp(`\\*\\*${field}:\\*\\*[^\\r\\n]*?\\x60([^\\x60]+)\\x60(?:\\s*\\(\\x60sha256:([a-f0-9]{64})\\x60\\))?`, 'iu'));
}

function intentText(plan, field) {
  return plan.match(new RegExp(`^\\s*[-*]\\s+\\*\\*${field}:\\*\\*\\s*(.+?)\\s*$`, 'imu'))?.[1]?.trim() || '';
}

function safeFile(root, relativePath, label) {
  if (!repositoryRelative(relativePath)) throw new Error(`${label} path must be repository-relative`);
  const resolvedRoot = fs.realpathSync(root);
  const candidate = path.resolve(resolvedRoot, relativePath);
  if (!candidate.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`${label} path escapes the repository`);
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-symbolic file`);
  const real = fs.realpathSync(candidate);
  if (!real.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`${label} resolves outside the repository`);
  return real;
}

function specCriteria(spec) {
  const result = new Map();
  for (const match of spec.matchAll(/^\s*[-*]\s+(?:\[[ xX-]\]\s+)?(AC-[1-9][0-9]*):\s*(.+?)\s*$/gmu)) {
    result.set(match[1], match[2].trim());
  }
  return result;
}

// candidateDesign is preflight-only: it lets a promoter check slice packet
// budgets and decision mapping against an unpersisted design in scratch. The
// packet budget is otherwise only knowable after the evidence record is
// already immutable, so every re-slice mints a throwaway EVD. Supplying it
// skips the canonical-path, digest-binding, and Work-index checks, which hold
// only once the record exists -- it is never a substitute for the gate of
// record.
function validatePlanImplementationDesign({ root, planPath, plan, candidateDesign = null }) {
  const structural = validatePlan(plan);
  const errors = [...structural.errors];
  const warnings = [...structural.warnings];
  if (structural.parsed.pairMode !== 'compiled') {
    return { ...structural, valid: errors.length === 0, errors, warnings, parsed: structural.parsed, design: null };
  }
  const designMatch = fieldValue(plan, 'Implementation design');
  const specMatch = fieldValue(plan, 'Spec');
  if (!designMatch || !designMatch[2]) errors.push('Implementation design reference and sha256 digest could not be parsed');
  if (!specMatch || !specMatch[2]) errors.push('Spec reference and sha256 digest could not be parsed');
  if (!designMatch || !specMatch || errors.length > 0) {
    return { ...structural, valid: false, errors: [...new Set(errors)], warnings, parsed: structural.parsed, design: null };
  }
  let designFile;
  let bytes;
  let record;
  if (candidateDesign) {
    designFile = candidateDesign.path;
    bytes = candidateDesign.bytes;
    record = candidateDesign.record;
  } else {
  try {
    const pathMatch = designMatch[1].match(EVIDENCE_PATH);
    if (!pathMatch) throw new Error('Implementation design path is not a canonical Work evidence path');
    designFile = safeFile(root, designMatch[1], 'Implementation design');
    bytes = fs.readFileSync(designFile);
    if (sha256(bytes) !== designMatch[2]) throw new Error('Implementation design digest mismatch');
    record = validateEvidenceFile(designFile);
    if (pathMatch[1] !== record.work_id || pathMatch[2] !== record.id) throw new Error('Implementation design identity does not match its canonical path');
    const workFile = safeFile(root, `docs/work/${record.work_id}/work.json`, 'Work index');
    const work = JSON.parse(fs.readFileSync(workFile, 'utf8'));
    if (!Array.isArray(work.evidence_records) || !work.evidence_records.includes(designMatch[1])) {
      throw new Error('Implementation design is not indexed by canonical Work');
    }
  } catch (error) {
    errors.push(error.message);
    return { ...structural, valid: false, errors: [...new Set(errors)], warnings, parsed: structural.parsed, design: null };
  }
  }
  const contractValidation = validateImplementationDesignRecord(record);
  errors.push(...contractValidation.errors);
  const result = record.result;
  const evidenceByPath = new Map((result.repository_evidence || []).map(evidence => [evidence.path, evidence]));
  const referencedEvidencePaths = new Set();
  try {
    if (result.spec.path !== specMatch[1] || result.spec.sha256 !== specMatch[2]) {
      errors.push('Implementation Design Contract spec does not match the plan Spec binding');
    }
    const specFile = safeFile(root, specMatch[1], 'canonical spec');
    const specBytes = fs.readFileSync(specFile);
    if (sha256(specBytes) !== specMatch[2]) errors.push('canonical spec digest mismatch');
    const canonicalCriteria = specCriteria(specBytes.toString('utf8'));
    for (const criterion of structural.parsed.acceptanceCriteria) {
      if (!canonicalCriteria.has(criterion.id)) errors.push(`plan Acceptance Criterion ${criterion.id} is absent from the canonical spec`);
      else if (canonicalCriteria.get(criterion.id) !== criterion.text) errors.push(`plan Acceptance Criterion ${criterion.id} is not copied verbatim from the canonical spec`);
    }
    const plannedDeletions = new Set((result.decisions || [])
      .flatMap(decision => decision.symbols || [])
      .filter(symbol => symbol.action === 'delete')
      .map(symbol => symbol.path));
    const workStarted = readPairEvents(root, record.work_id)
      .some(event => event.event === 'attempt.started');
    for (const evidence of result.repository_evidence || []) {
      try {
        safeFile(root, evidence.path, `repository evidence ${evidence.path}`);
      } catch (error) {
        if (!(workStarted && plannedDeletions.has(evidence.path) && error.code === 'ENOENT')) throw error;
      }
    }
    for (const decision of result.decisions || []) {
      for (const symbol of decision.symbols || []) {
        if (symbol.action === 'add') continue;
        referencedEvidencePaths.add(symbol.path);
        const evidence = evidenceByPath.get(symbol.path);
        if (!evidence) {
          errors.push(`implementation decision ${decision.id} existing symbol path ${symbol.path} is absent from repository_evidence`);
        } else if (!(evidence.symbols || []).includes(symbol.symbol)) {
          errors.push(`repository evidence ${symbol.path} does not name implementation symbol ${symbol.symbol}`);
        }
      }
      for (const pattern of decision.pattern_references || []) {
        referencedEvidencePaths.add(pattern.path);
        const evidence = evidenceByPath.get(pattern.path);
        if (!evidence) {
          errors.push(`implementation decision ${decision.id} pattern ${pattern.path} is absent from repository_evidence`);
        } else if (!(evidence.symbols || []).includes(pattern.symbol)) {
          errors.push(`repository evidence ${pattern.path} does not name pattern symbol ${pattern.symbol}`);
        }
      }
    }
    for (const evidence of result.repository_evidence || []) {
      if (!referencedEvidencePaths.has(evidence.path)) {
        errors.push(`repository evidence ${evidence.path} is not referenced by an implementation decision`);
      }
    }
  } catch (error) {
    errors.push(error.message);
  }

  const decisions = new Map((result.decisions || []).map(decision => [decision.id, decision]));
  const taskIndex = new Map(structural.parsed.tasks.map((task, index) => [task.id, index]));
  const mappedBy = new Map();
  for (const task of structural.parsed.tasks) {
    const mapped = task.implementationDecisionIds || [];
    const coveredPaths = new Set();
    const coveredBoundaries = new Set();
    for (const id of mapped) {
      const decision = decisions.get(id);
      if (!decision) {
        errors.push(`Task ${task.id} references missing implementation decision ${id}`);
        continue;
      }
      if (mappedBy.has(id)) errors.push(`implementation decision ${id} is mapped by more than one Review Slice`);
      else mappedBy.set(id, task.id);
      const taskCriteria = [...task.acceptanceCriteria].sort();
      const decisionCriteria = [...decision.acceptance_criteria].sort();
      if (JSON.stringify(taskCriteria) !== JSON.stringify(decisionCriteria)) {
        errors.push(`Task ${task.id} and implementation decision ${id} have different Acceptance Criteria mappings`);
      }
      for (const symbol of decision.symbols || []) {
        coveredPaths.add(symbol.path);
        if (symbol.action !== 'read' && !task.files.includes(symbol.path)) {
          errors.push(`implementation decision ${id} path ${symbol.path} is not in Task ${task.id} owned files`);
        }
      }
      for (const testCase of decision.tests || []) {
        coveredPaths.add(testCase.file);
        coveredBoundaries.add(testCase.boundary);
        if (!task.testFiles.includes(testCase.file)) errors.push(`implementation decision ${id} test ${testCase.file} is not test-owned by Task ${task.id}`);
        if (task.type !== 'docs' && !task.testBoundaries.includes(testCase.boundary)) {
          errors.push(`implementation decision ${id} test boundary ${testCase.boundary} is not declared by Task ${task.id}`);
        }
      }
      if (decision.verify !== task.verify) errors.push(`implementation decision ${id} verify command differs from Task ${task.id}`);
    }
    for (const ownedFile of task.files) {
      if (!coveredPaths.has(ownedFile)) errors.push(`Task ${task.id} owned file ${ownedFile} is not covered by a mapped implementation decision`);
    }
    if (task.type !== 'docs') {
      for (const boundary of task.testBoundaries) {
        if (!coveredBoundaries.has(boundary)) errors.push(`Task ${task.id} test boundary ${boundary} is not covered by its implementation decisions`);
      }
    }
  }
  for (const decision of decisions.values()) {
    if (!mappedBy.has(decision.id)) errors.push(`implementation decision ${decision.id} is not mapped to a Review Slice`);
    const ownerIndex = taskIndex.get(mappedBy.get(decision.id));
    for (const dependency of decision.depends_on || []) {
      const dependencyOwner = mappedBy.get(dependency);
      if (!dependencyOwner) continue;
      if (taskIndex.get(dependencyOwner) > ownerIndex) errors.push(`implementation decision ${decision.id} depends on later decision ${dependency}`);
    }
  }
  const planCriteria = [...structural.parsed.acceptanceCriteria.map(item => item.id)].sort();
  const designCriteria = [...record.acceptance_criteria].sort();
  if (JSON.stringify(planCriteria) !== JSON.stringify(designCriteria)) errors.push('plan and Implementation Design Contract Acceptance Criteria sets differ');

  return {
    ...structural,
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    warnings,
    parsed: structural.parsed,
    design: { record, path: designMatch[1], sha256: designMatch[2], file: designFile },
    planPath,
  };
}

function routingFor(task, packetBytes) {
  const reasons = [];
  let recommendedStrength = task.type === 'docs' ? 1 : 2;
  if (task.risk === 'critical' || task.uncertainty === 'high') recommendedStrength = 4;
  else if (task.risk === 'high' || task.complexity === 'L' || ['contract', 'architecture'].includes(task.scope)) recommendedStrength = 3;
  if (!['S', 'M'].includes(task.complexity)) reasons.push(`${task.complexity} complexity exceeds the cheap-ready S/M boundary`);
  if (!['low', 'medium'].includes(task.risk)) reasons.push(`${task.risk} risk requires a stronger model`);
  if (!['local', 'cross-module'].includes(task.scope)) reasons.push(`${task.scope} scope requires a stronger model`);
  if (task.uncertainty !== 'low') reasons.push(`${task.uncertainty} uncertainty is not cheap-ready`);
  if (packetBytes > CHEAP_PACKET_BYTES) reasons.push(`execution packet exceeds ${CHEAP_PACKET_BYTES} bytes`);
  return { cheap_ready: reasons.length === 0, recommended_strength: recommendedStrength, reasons, packet_bytes: packetBytes };
}

function compileReviewSliceExecutionPacket({ root, planPath, plan, taskId, candidateDesign = null }) {
  const validation = validatePlanImplementationDesign({ root, planPath, plan, candidateDesign });
  if (!validation.valid) throw new Error(`compiled plan is not executable: ${validation.errors.join('; ')}`);
  const task = validation.parsed.tasks.find(item => item.id === taskId);
  if (!task) throw new Error(`Review Slice ${taskId} does not exist`);
  const criteria = new Map(validation.parsed.acceptanceCriteria.map(item => [item.id, item.text]));
  const decisions = new Map(validation.design.record.result.decisions.map(item => [item.id, item]));
  const mappedDecisions = task.implementationDecisionIds.map(id => decisions.get(id));
  const mappedIds = new Set(task.implementationDecisionIds);
  const dependencyIds = [];
  const visitedDependencies = new Set();
  const visitDependency = id => {
    if (mappedIds.has(id) || visitedDependencies.has(id)) return;
    visitedDependencies.add(id);
    const decision = decisions.get(id);
    for (const dependency of decision?.depends_on || []) visitDependency(dependency);
    if (decision) dependencyIds.push(id);
  };
  for (const decision of mappedDecisions) {
    for (const dependency of decision.depends_on || []) visitDependency(dependency);
  }
  const dependencyDecisions = dependencyIds.map(id => decisions.get(id));
  const relevantPaths = new Set([...dependencyDecisions, ...mappedDecisions].flatMap(decision => [
    ...(decision.symbols || []).filter(symbol => symbol.action !== 'add').map(symbol => symbol.path),
    ...(decision.pattern_references || []).map(pattern => pattern.path),
  ]));
  const repositoryEvidence = validation.design.record.result.repository_evidence
    .filter(evidence => relevantPaths.has(evidence.path));
  const packet = {
    schema: 1,
    work_id: validation.design.record.work_id,
    plan: {
      path: path.relative(root, planPath).split(path.sep).join('/'),
      sha256: planContractDigest(plan),
    },
    implementation_design: {
      evidence_id: validation.design.record.id,
      path: validation.design.path,
      sha256: validation.design.sha256,
    },
    review_slice: {
      id: task.id,
      outcome: task.description,
      profile: {
        type: task.type,
        complexity: task.complexity,
        risk: task.risk,
        scope: task.scope,
        uncertainty: task.uncertainty,
      },
      acceptance_criteria: task.acceptanceCriteria.map(id => ({ id, text: criteria.get(id) })),
      constraints: [intentText(plan, 'Constraints')],
      repository_evidence: repositoryEvidence,
      owned_files: [...task.files],
      test_files: [...task.testFiles],
      consumes: task.consumes || [],
      produces: task.produces || [],
      implementation_decisions: mappedDecisions,
      dependency_decisions: dependencyDecisions,
      non_goals: [...new Set(mappedDecisions.flatMap(item => item.non_goals || []))],
      verification: task.verify,
    },
    routing: { cheap_ready: false, recommended_strength: 4, reasons: [], packet_bytes: 0 },
  };
  let previous = -1;
  for (let iteration = 0; iteration < 4; iteration++) {
    const bytes = Buffer.byteLength(JSON.stringify(packet), 'utf8');
    packet.routing = routingFor(task, bytes);
    if (bytes === previous) break;
    previous = bytes;
  }
  packet.routing.packet_bytes = Buffer.byteLength(JSON.stringify(packet), 'utf8');
  if (packet.routing.packet_bytes > CHEAP_PACKET_BYTES && !packet.routing.reasons.some(reason => /execution packet exceeds/u.test(reason))) {
    packet.routing.reasons.push(`execution packet exceeds ${CHEAP_PACKET_BYTES} bytes`);
    packet.routing.cheap_ready = false;
    packet.routing.packet_bytes = Buffer.byteLength(JSON.stringify(packet), 'utf8');
  }
  if (packet.routing.packet_bytes > MAX_PACKET_BYTES) throw new Error(`Review Slice Execution Packet exceeds ${MAX_PACKET_BYTES} bytes`);
  return packet;
}

module.exports = {
  CHEAP_PACKET_BYTES,
  IMPLEMENTATION_DESIGN_KIND,
  MAX_PACKET_BYTES,
  compileReviewSliceExecutionPacket,
  validateImplementationDesignRecord,
  validatePlanImplementationDesign,
};
