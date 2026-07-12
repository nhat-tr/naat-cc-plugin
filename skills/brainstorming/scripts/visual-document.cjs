const MAX_DOCUMENT_BYTES = 8_000;
const PROFILES = new Set(['technical', 'product', 'business']);
const SECTION_KINDS = new Set(['anchor', 'callout', 'cards', 'decision', 'flow', 'mockup', 'timeline']);
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
}

function rejectUnknown(value, allowed, label) {
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown !== undefined) throw new TypeError(`unsupported field ${label}.${unknown}`);
}

function text(value, maximum, label, required = false) {
  if (value == null) {
    if (required) throw new TypeError(`${label} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new TypeError(`${label} must be text`);
  const normalized = value.trim();
  if (required && !normalized) throw new TypeError(`${label} is required`);
  if (normalized.length > maximum) throw new RangeError(`${label} must be at most ${maximum} characters`);
  return normalized;
}

function identifier(value, label) {
  const normalized = text(value, 80, label, true);
  if (!ID_PATTERN.test(normalized)) throw new TypeError(`${label} must use lowercase letters, numbers, hyphens, or underscores`);
  return normalized;
}

// Claim-sized fragments: each point renders as its own annotatable component
// (<item-id>-pN), which is what lets a reviewer target one claim instead of a paragraph.
function normalizePoints(value, label) {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > 6) {
    throw new RangeError(`${label}.points must contain 1-6 short claims`);
  }
  if (value.length === 0) return undefined;
  return value.map((point, index) => text(point, 160, `${label}.points[${index}]`, true));
}

function normalizeItem(value, label, seenIds, allowedExtra = []) {
  assertObject(value, label);
  rejectUnknown(value, ['id', 'title', 'detail', 'points', 'tone', 'role', ...allowedExtra], label);
  const id = identifier(value.id, `${label}.id`);
  if (seenIds.has(id)) throw new TypeError(`duplicate visual component id ${id}`);
  seenIds.add(id);
  const tone = text(value.tone, 20, `${label}.tone`) || 'neutral';
  if (!['neutral', 'accent', 'positive', 'warning', 'critical'].includes(tone)) {
    throw new TypeError(`${label}.tone is unsupported`);
  }
  const points = normalizePoints(value.points, label);
  return {
    id,
    title: text(value.title, 120, `${label}.title`, true),
    detail: text(value.detail, 500, `${label}.detail`),
    tone,
    ...(points ? { points } : {}),
    ...(value.role ? { role: text(value.role, 30, `${label}.role`) } : {}),
  };
}

// Typed prototype vocabulary for mockup regions. Bounded and validated like everything else:
// no HTML, no styling, no handlers — but the shell renders these as real-looking UI controls,
// each one an annotatable component (<region-id>-eN).
const ELEMENT_KINDS = new Set(['heading', 'text', 'button', 'input', 'tabs', 'table', 'list', 'metric', 'badge', 'placeholder', 'cells']);

function normalizeElement(value, label) {
  assertObject(value, label);
  const kind = text(value.kind, 20, `${label}.kind`, true);
  if (!ELEMENT_KINDS.has(kind)) throw new TypeError(`unsupported element kind ${kind}`);

  if (kind === 'heading' || kind === 'text') {
    rejectUnknown(value, ['kind', 'text'], label);
    return { kind, text: text(value.text, kind === 'heading' ? 80 : 200, `${label}.text`, true) };
  }
  if (kind === 'button') {
    rejectUnknown(value, ['kind', 'label', 'variant'], label);
    const variant = text(value.variant, 20, `${label}.variant`) || 'secondary';
    if (!['primary', 'secondary', 'danger'].includes(variant)) throw new TypeError(`${label}.variant is unsupported`);
    return { kind, label: text(value.label, 40, `${label}.label`, true), variant };
  }
  if (kind === 'input') {
    rejectUnknown(value, ['kind', 'label', 'placeholder', 'value', 'control'], label);
    const control = text(value.control, 20, `${label}.control`) || 'text';
    if (!['text', 'search', 'select', 'checkbox', 'toggle'].includes(control)) throw new TypeError(`${label}.control is unsupported`);
    return {
      kind,
      control,
      ...(value.label ? { label: text(value.label, 40, `${label}.label`) } : {}),
      ...(value.placeholder ? { placeholder: text(value.placeholder, 60, `${label}.placeholder`) } : {}),
      ...(value.value ? { value: text(value.value, 60, `${label}.value`) } : {}),
    };
  }
  if (kind === 'tabs') {
    rejectUnknown(value, ['kind', 'labels', 'active'], label);
    if (!Array.isArray(value.labels) || value.labels.length < 2 || value.labels.length > 6) {
      throw new RangeError(`${label}.labels must contain 2-6 tabs`);
    }
    const labels = value.labels.map((tab, tabIndex) => text(tab, 24, `${label}.labels[${tabIndex}]`, true));
    const active = value.active == null ? 0 : value.active;
    if (!Number.isInteger(active) || active < 0 || active >= labels.length) {
      throw new RangeError(`${label}.active must index a tab`);
    }
    return { kind, labels, active };
  }
  if (kind === 'table') {
    rejectUnknown(value, ['kind', 'columns', 'rows'], label);
    if (!Array.isArray(value.columns) || value.columns.length < 1 || value.columns.length > 5) {
      throw new RangeError(`${label}.columns must contain 1-5 columns`);
    }
    const columns = value.columns.map((column, columnIndex) => text(column, 24, `${label}.columns[${columnIndex}]`, true));
    const rows = value.rows == null ? [] : value.rows;
    if (!Array.isArray(rows) || rows.length > 6) throw new RangeError(`${label}.rows must contain at most 6 rows`);
    const normalizedRows = rows.map((row, rowIndex) => {
      if (!Array.isArray(row) || row.length !== columns.length) {
        throw new RangeError(`${label}.rows[${rowIndex}] must match the row width of ${columns.length} columns`);
      }
      return row.map((cell, cellIndex) => text(cell, 40, `${label}.rows[${rowIndex}][${cellIndex}]`));
    });
    return { kind, columns, rows: normalizedRows };
  }
  if (kind === 'list') {
    rejectUnknown(value, ['kind', 'items'], label);
    if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 6) {
      throw new RangeError(`${label}.items must contain 1-6 rows`);
    }
    const items = value.items.map((entry, entryIndex) => {
      assertObject(entry, `${label}.items[${entryIndex}]`);
      rejectUnknown(entry, ['title', 'meta'], `${label}.items[${entryIndex}]`);
      return {
        title: text(entry.title, 60, `${label}.items[${entryIndex}].title`, true),
        ...(entry.meta ? { meta: text(entry.meta, 40, `${label}.items[${entryIndex}].meta`) } : {}),
      };
    });
    return { kind, items };
  }
  if (kind === 'cells') {
    // Spatial cell grids: tool racks, slots, bins, seat maps. Each cell is one small click
    // target; `filled` distinguishes occupied from empty at a glance.
    rejectUnknown(value, ['kind', 'columns', 'items'], label);
    if (value.columns != null && (!Number.isInteger(value.columns) || value.columns < 2 || value.columns > 16)) {
      throw new RangeError(`${label}.columns must be an integer between 2 and 16`);
    }
    if (!Array.isArray(value.items) || value.items.length < 2 || value.items.length > 60) {
      throw new RangeError(`${label}.items must contain 2-60 cells`);
    }
    const items = value.items.map((cell, cellIndex) => {
      assertObject(cell, `${label}.items[${cellIndex}]`);
      rejectUnknown(cell, ['label', 'tone', 'filled'], `${label}.items[${cellIndex}]`);
      const tone = text(cell.tone, 20, `${label}.items[${cellIndex}].tone`) || 'neutral';
      if (!['neutral', 'accent', 'positive', 'warning', 'critical'].includes(tone)) {
        throw new TypeError(`${label}.items[${cellIndex}].tone is unsupported`);
      }
      return {
        label: text(cell.label, 6, `${label}.items[${cellIndex}].label`, true),
        tone,
        filled: cell.filled === true,
      };
    });
    return { kind, ...(value.columns != null ? { columns: value.columns } : {}), items };
  }
  if (kind === 'metric') {
    rejectUnknown(value, ['kind', 'label', 'value'], label);
    return {
      kind,
      label: text(value.label, 40, `${label}.label`, true),
      value: text(value.value, 20, `${label}.value`, true),
    };
  }
  if (kind === 'badge') {
    rejectUnknown(value, ['kind', 'label', 'tone'], label);
    const tone = text(value.tone, 20, `${label}.tone`) || 'neutral';
    if (!['neutral', 'accent', 'positive', 'warning', 'critical'].includes(tone)) throw new TypeError(`${label}.tone is unsupported`);
    return { kind, label: text(value.label, 24, `${label}.label`, true), tone };
  }
  rejectUnknown(value, ['kind', 'label'], label);
  return { kind, label: text(value.label, 40, `${label}.label`, true) };
}

function normalizeMockupRegion(value, label, seenIds) {
  const region = normalizeItem(value, label, seenIds, ['span', 'elements']);
  const output = { ...region };
  if (value.span != null) {
    if (!Number.isInteger(value.span) || value.span < 1 || value.span > 12) {
      throw new RangeError(`${label}.span must be an integer between 1 and 12`);
    }
    output.span = value.span;
  }
  if (value.elements != null) {
    if (!Array.isArray(value.elements) || value.elements.length < 1 || value.elements.length > 8) {
      throw new RangeError(`${label}.elements must contain 1-8 elements`);
    }
    output.elements = value.elements.map((element, elementIndex) => normalizeElement(element, `${label}.elements[${elementIndex}]`));
  }
  return output;
}

function normalizeList(value, label, seenIds, limits = { minimum: 1, maximum: 12 }) {
  if (!Array.isArray(value) || value.length < limits.minimum || value.length > limits.maximum) {
    throw new RangeError(`${label} must contain ${limits.minimum}-${limits.maximum} items`);
  }
  return value.map((item, index) => normalizeItem(item, `${label}[${index}]`, seenIds));
}

function normalizeSection(value, index, seenIds) {
  const label = `sections[${index}]`;
  assertObject(value, label);
  const kind = text(value.kind, 20, `${label}.kind`, true);
  if (!SECTION_KINDS.has(kind)) throw new TypeError(`unsupported section kind ${kind}`);
  const common = ['kind', 'id', 'title', 'summary'];
  const id = identifier(value.id, `${label}.id`);
  if (seenIds.has(id)) throw new TypeError(`duplicate visual component id ${id}`);
  seenIds.add(id);
  const base = {
    kind,
    id,
    title: text(value.title, 140, `${label}.title`, true),
    summary: text(value.summary, 500, `${label}.summary`),
  };

  if (kind === 'flow') {
    rejectUnknown(value, [...common, 'nodes'], label);
    return { ...base, nodes: normalizeList(value.nodes, `${label}.nodes`, seenIds, { minimum: 2, maximum: 12 }) };
  }
  if (kind === 'decision') {
    rejectUnknown(value, [...common, 'groupId', 'options', 'multiselect'], label);
    if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 5) {
      throw new RangeError(`${label}.options must contain 2-5 items`);
    }
    const options = value.options.map((option, optionIndex) => {
      const optionLabel = `${label}.options[${optionIndex}]`;
      assertObject(option, optionLabel);
      rejectUnknown(option, ['id', 'label', 'title', 'detail', 'points', 'score', 'recommended', 'tone'], optionLabel);
      const legacyTitle = text(option.title, 120, `${optionLabel}.title`);
      const canonicalLabel = text(option.label, 120, `${optionLabel}.label`, true);
      if (legacyTitle && legacyTitle !== canonicalLabel) {
        throw new TypeError(`${optionLabel}.title must match label when present`);
      }
      const item = normalizeItem({
        id: option.id,
        title: canonicalLabel,
        detail: option.detail,
        points: option.points,
        tone: option.tone,
      }, optionLabel, seenIds);
      let score = null;
      if (option.score != null) {
        if (typeof option.score !== 'number') throw new TypeError(`${optionLabel}.score must be a number`);
        score = option.score;
      }
      if (score != null && (!Number.isFinite(score) || score < 1 || score > 10)) {
        throw new RangeError(`${optionLabel}.score must be between 1 and 10`);
      }
      return {
        id: item.id,
        label: item.title,
        detail: item.detail,
        tone: item.tone,
        ...(item.points ? { points: item.points } : {}),
        score,
        recommended: option.recommended === true,
      };
    });
    return {
      ...base,
      groupId: value.groupId ? identifier(value.groupId, `${label}.groupId`) : id,
      multiselect: value.multiselect === true,
      options,
    };
  }
  if (kind === 'mockup') {
    rejectUnknown(value, [...common, 'device', 'regions'], label);
    const device = text(value.device, 20, `${label}.device`) || 'desktop';
    if (!['desktop', 'mobile'].includes(device)) throw new TypeError(`${label}.device is unsupported`);
    if (!Array.isArray(value.regions) || value.regions.length < 1 || value.regions.length > 12) {
      throw new RangeError(`${label}.regions must contain 1-12 items`);
    }
    const regions = value.regions.map((region, regionIndex) => normalizeMockupRegion(region, `${label}.regions[${regionIndex}]`, seenIds));
    return { ...base, device, regions };
  }
  if (kind === 'callout') {
    rejectUnknown(value, [...common, 'body', 'tone'], label);
    const tone = text(value.tone, 20, `${label}.tone`) || 'accent';
    if (!['accent', 'positive', 'warning', 'critical'].includes(tone)) throw new TypeError(`${label}.tone is unsupported`);
    return { ...base, body: text(value.body, 800, `${label}.body`, true), tone };
  }

  rejectUnknown(value, [...common, 'items'], label);
  return { ...base, items: normalizeList(value.items, `${label}.items`, seenIds) };
}

function normalizeVisualDocument(value) {
  assertObject(value, 'visual document');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new RangeError(`visual document exceeds ${MAX_DOCUMENT_BYTES} bytes`);
  }
  rejectUnknown(value, ['version', 'profile', 'audience', 'title', 'summary', 'sections'], 'visual document');
  const profile = text(value.profile, 20, 'visual document.profile') || 'technical';
  if (!PROFILES.has(profile)) throw new TypeError(`unsupported visual profile ${profile}`);
  if (!Array.isArray(value.sections) || value.sections.length < 1 || value.sections.length > 12) {
    throw new RangeError('visual document.sections must contain 1-12 sections');
  }
  const seenIds = new Set();
  return {
    version: 1,
    profile,
    audience: text(value.audience, 160, 'visual document.audience'),
    title: text(value.title, 160, 'visual document.title', true),
    summary: text(value.summary, 600, 'visual document.summary'),
    sections: value.sections.map((section, index) => normalizeSection(section, index, seenIds)),
  };
}

function scaffoldSection(kind, index) {
  const id = `${kind}-${index + 1}`;
  const item = (suffix, title, detail) => ({ id: `${id}-${suffix}`, title, detail });
  const base = { kind, id, title: `${kind[0].toUpperCase()}${kind.slice(1)} section` };

  if (kind === 'flow') {
    return {
      ...base,
      nodes: [
        item('input', 'Input', 'Replace with the observed entry point.'),
        item('framework', 'Framework capability', 'Replace with verified framework-owned behavior.'),
        item('result', 'Result', 'Replace with the observable outcome.'),
      ],
    };
  }
  if (kind === 'decision') {
    return {
      ...base,
      options: [
        { id: `${id}-framework-native`, label: 'Framework-native baseline', detail: 'Replace with the smallest verified composition.' },
        { id: `${id}-application-owned`, label: 'Application-owned alternative', detail: 'Use only when evidence justifies custom ownership.' },
      ],
    };
  }
  if (kind === 'mockup') {
    return {
      ...base,
      device: 'desktop',
      regions: [
        {
          id: `${id}-toolbar`, title: 'Toolbar', detail: '', tone: 'neutral', span: 12,
          elements: [
            { kind: 'heading', text: 'Replace with the screen title' },
            { kind: 'input', control: 'search', placeholder: 'Replace with the primary lookup' },
            { kind: 'button', label: 'Primary action', variant: 'primary' },
          ],
        },
        {
          id: `${id}-content`, title: 'Content', detail: '', tone: 'neutral', span: 12,
          elements: [
            { kind: 'table', columns: ['Replace', 'With real', 'Columns'], rows: [['Replace', 'with real', 'rows']] },
          ],
        },
      ],
    };
  }
  if (kind === 'callout') {
    return { ...base, body: 'Replace with one load-bearing conclusion, warning, or open question.', tone: 'accent' };
  }
  if (kind === 'anchor') {
    return {
      ...base,
      items: [
        {
          ...item('purpose', 'Purpose', 'Replace with a one-sentence lede.'),
          points: [
            'Replace with one confirmed claim per point.',
            'Each point is separately annotatable — keep them short.',
          ],
        },
        item('rejection-criteria', 'Rejection criteria', 'Replace with conditions that make the design wrong.'),
        item('contrasts', 'Contrasts', 'Replace with plausible sibling interpretations that are out of scope.'),
      ],
    };
  }
  if (kind === 'timeline') {
    return {
      ...base,
      items: [
        item('current', 'Current', 'Replace with the observed starting state.'),
        item('next', 'Next', 'Replace with the next meaningful stage.'),
      ],
    };
  }
  return {
    ...base,
    items: [
      item('observed', 'Observed capability', 'Replace with repository or framework evidence.'),
      item('unknown', 'Unknown', 'Replace with a load-bearing evidence gap.'),
    ],
  };
}

function createVisualScaffold(options = {}) {
  const kinds = options.kinds || ['anchor', 'flow', 'decision'];
  if (!Array.isArray(kinds) || kinds.length < 1 || kinds.length > 12) {
    throw new RangeError('visual scaffold kinds must contain 1-12 section kinds');
  }
  for (const kind of kinds) {
    if (!SECTION_KINDS.has(kind)) throw new TypeError(`unsupported scaffold section kind ${kind}`);
  }
  return normalizeVisualDocument({
    version: 1,
    profile: options.profile || 'technical',
    audience: options.audience || '',
    title: options.title || 'Brainstorming visual',
    summary: options.summary || '',
    sections: kinds.map(scaffoldSection),
  });
}

module.exports = { MAX_DOCUMENT_BYTES, createVisualScaffold, normalizeVisualDocument };
