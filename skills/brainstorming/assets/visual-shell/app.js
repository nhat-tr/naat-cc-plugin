function reconcileChoices(choices, next, { selected, multiselect }) {
  const sameOption = choice => choice.componentId === next.componentId;
  if (!selected) return choices.filter(choice => !sameOption(choice));
  const updated = next.groupId && !multiselect
    ? choices.filter(choice => choice.groupId !== next.groupId)
    : [...choices];
  const existing = updated.findIndex(sameOption);
  if (existing >= 0) updated[existing] = next;
  else updated.push(next);
  return updated;
}

function isChoiceSelected(choices, componentId) {
  return choices.some(choice => choice.componentId === componentId);
}

function normalizeFeedbackDraft(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    annotations: Array.isArray(source.annotations) ? source.annotations : [],
    choices: Array.isArray(source.choices) ? source.choices : [],
    message: typeof source.message === 'string' ? source.message : '',
    clientTurnId: typeof source.clientTurnId === 'string' && source.clientTurnId ? source.clientTurnId : null,
  };
}

function groupAnnotationsByComponent(annotations = []) {
  const grouped = new Map();
  for (const annotation of annotations) {
    const componentId = annotation?.target?.componentId;
    if (!componentId) continue;
    const current = grouped.get(componentId) || [];
    current.push(annotation);
    grouped.set(componentId, current);
  }
  return grouped;
}

function annotationSummary(annotations = []) {
  const count = annotations.length;
  const noun = count === 1 ? 'annotation' : 'annotations';
  const messages = annotations
    .map((annotation, index) => `${index + 1}. ${String(annotation.comment || '').trim()}`)
    .join('\n');
  return `${count} ${noun}:${messages ? `\n${messages}` : ''}`;
}

async function readResponseError(response, fallback) {
  try {
    const value = await response.json();
    return typeof value?.error === 'string' && value.error ? value.error : fallback;
  } catch {
    return fallback;
  }
}

function documentRevision(value) {
  // Stable content fingerprint (FNV-1a) so feedback can be attributed to the exact document
  // version the user reviewed, and publish-while-composing races are detectable.
  const json = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// Detects code references like Factory.cs:135, docs/architecture.md, or assets/app.js so the
// renderer can promote them to copyable chips. Bare .js/.ts names require a :line suffix to
// avoid matching product names such as Node.js.
const FILE_REFERENCE_PATTERN = new RegExp(
  '(?<![\\w./-])(?:'
  + '(?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+\\.[A-Za-z]{1,7}(?::\\d+(?:-\\d+)?)?'
  + '|[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*\\.(?:cs|csproj|sln|tsx|jsx|cjs|mjs|jsonl|json|md|ya?ml|toml|css|scss|html|sh|py|go|rs|java|kt|rb|sql|xml|config|props|targets)(?::\\d+(?:-\\d+)?)?'
  + '|[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*\\.(?:js|ts):\\d+(?:-\\d+)?'
  + ')(?!\\w)',
  'g',
);

function splitFileReferences(value) {
  const segments = [];
  let last = 0;
  for (const match of value.matchAll(FILE_REFERENCE_PATTERN)) {
    if (match.index > last) segments.push({ type: 'text', value: value.slice(last, match.index) });
    segments.push({ type: 'fileref', value: match[0] });
    last = match.index + match[0].length;
  }
  if (last < value.length) segments.push({ type: 'text', value: value.slice(last) });
  return segments;
}

const INLINE_MARKUP_PATTERN = /`([^`]+)`|\*\*((?:[^*]|\*(?!\*))+)\*\*/g;

// Documents and chat replies are plain text by contract, but agents naturally write **bold**,
// `code`, and file:line references. Parse that minimal vocabulary into typed segments; the
// renderer builds DOM text nodes from them, so no markup is ever interpreted as HTML.
function parseInlineSegments(text) {
  const source = String(text ?? '');
  const segments = [];
  let last = 0;
  for (const match of source.matchAll(INLINE_MARKUP_PATTERN)) {
    if (match.index > last) segments.push(...splitFileReferences(source.slice(last, match.index)));
    if (match[1] != null) segments.push({ type: 'code', value: match[1] });
    else segments.push({ type: 'strong', value: match[2] });
    last = match.index + match[0].length;
  }
  if (last < source.length) segments.push(...splitFileReferences(source.slice(last)));
  return segments;
}

// Walks a visual document into a flat component map keyed by the same ids the renderer emits
// (sections, items/nodes/regions, options, derived -pN points and -eN elements). Container
// fingerprints exclude their child collections so an edited point flags only the point.
function collectComponents(documentValue) {
  const map = new Map();
  const add = (id, payload, label, parent) => map.set(id, { fingerprint: JSON.stringify(payload), label, parent });
  for (const section of documentValue?.sections || []) {
    const { items, nodes, options, regions, ...sectionOwn } = section;
    add(section.id, sectionOwn, section.title, null);
    for (const child of items || nodes || regions || []) {
      const { points, elements, ...childOwn } = child;
      add(child.id, childOwn, child.title, section.id);
      (points || []).forEach((point, index) => add(`${child.id}-p${index + 1}`, point, `${child.title} · point ${index + 1}`, child.id));
      (elements || []).forEach((element, index) => add(`${child.id}-e${index + 1}`, element, `${child.title} · ${element.kind} ${index + 1}`, child.id));
    }
    for (const option of options || []) {
      const { points, ...optionOwn } = option;
      add(option.id, optionOwn, option.label, section.id);
      (points || []).forEach((point, index) => add(`${option.id}-p${index + 1}`, point, `${option.label} · point ${index + 1}`, option.id));
    }
  }
  return map;
}

// What changed between two published revisions, at the most specific component level:
// the reviewer re-reads only what the agent touched instead of the whole document.
function computeComponentChanges(previousDocument, nextDocument) {
  if (!previousDocument) return { added: [], updated: [], removed: [] };
  const before = collectComponents(previousDocument);
  const after = collectComponents(nextDocument);
  const addedSet = new Set();
  const added = [];
  const updated = [];
  for (const [id, entry] of after) {
    const prior = before.get(id);
    if (!prior) {
      addedSet.add(id);
      if (!addedSet.has(entry.parent)) added.push(id);
    } else if (prior.fingerprint !== entry.fingerprint) {
      updated.push(id);
    }
  }
  const removedSet = new Set([...before.keys()].filter(id => !after.has(id)));
  const removed = [...removedSet]
    .filter(id => !removedSet.has(before.get(id).parent))
    .map(id => ({ id, label: before.get(id).label }));
  return { added, updated, removed };
}

// Groups message lines into paragraph / ordered / bulleted blocks so chat replies render as
// structured text instead of a preformatted wall. List item text keeps its inline markup raw;
// callers run parseInlineSegments per item.
function parseMessageBlocks(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  const flush = () => {
    if (!paragraph.length) return;
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
    paragraph = [];
  };
  for (const line of lines) {
    const ordered = line.match(/^\s*\d{1,3}[.)]\s+(.*)$/);
    const bulleted = line.match(/^\s*[-•]\s+(.*)$/) || line.match(/^\s*\*(?!\*)\s+(.*)$/);
    if (ordered || bulleted) {
      flush();
      const type = ordered ? 'ordered' : 'bulleted';
      const item = (ordered || bulleted)[1].trim();
      const last = blocks[blocks.length - 1];
      if (last?.type === type) last.items.push(item);
      else blocks.push({ type, items: [item] });
    } else if (!line.trim()) {
      flush();
    } else {
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks;
}

(function startVisualShell() {
  if (typeof document === 'undefined') return;
  // A standalone export embeds its screen + history and renders read-only with no server.
  const embedded = typeof window !== 'undefined' && window.__BRAINSTORM_EMBEDDED__ || null;
  const basePath = document.body.dataset.basePath || '/';
  const storageKey = `visual-feedback:${location.origin}${basePath}`;
  if (location.search) history.replaceState(null, '', basePath);
  const state = {
    annotate: false,
    annotations: [],
    clientTurnId: null,
    choices: [],
    document: null,
    events: [],
    message: '',
    screenRevision: null,
    selectedTarget: null,
    submitting: false,
  };
  const byId = id => document.getElementById(id);
  const elements = Object.fromEntries([
    'annotate', 'annotate-hint', 'annotation-comment', 'annotation-dialog', 'annotation-target',
    'audience', 'canvas', 'changes', 'clear', 'connection', 'doc-meta', 'document-summary',
    'document-title', 'handoff', 'highlight', 'highlight-label', 'history', 'message', 'pending',
    'profile', 'queue-annotation', 'refresh', 'revision', 'save', 'save-status', 'screen-error', 'submit',
  ].map(id => [id, byId(id)]));

  function safeStorageGet() {
    try { return sessionStorage.getItem(storageKey); } catch { return null; }
  }
  function safeStorageSet(value) {
    try { sessionStorage.setItem(storageKey, value); } catch { /* storage blocked; draft is best-effort */ }
  }

  if (!embedded) {
    try {
      Object.assign(state, normalizeFeedbackDraft(JSON.parse(safeStorageGet() || '{}')));
      elements.message.value = state.message;
    } catch {
      // A malformed draft starts clean; never touch storage in the catch since the access
      // itself can throw (private mode) and abort the shell before it renders.
    }
  }

  function persist() {
    if (embedded) return;
    safeStorageSet(JSON.stringify({
      annotations: state.annotations,
      choices: state.choices,
      message: state.message,
      clientTurnId: state.clientTurnId,
    }));
  }

  function showScreenError(message) {
    if (!elements['screen-error']) return;
    elements['screen-error'].textContent = message;
    elements['screen-error'].hidden = false;
  }
  function clearScreenError() {
    if (elements['screen-error']) elements['screen-error'].hidden = true;
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function renderInline(container, text) {
    for (const segment of parseInlineSegments(text)) {
      if (segment.type === 'strong') container.append(node('strong', '', segment.value));
      else if (segment.type === 'code') container.append(node('code', 'inline-code', segment.value));
      else if (segment.type === 'fileref') {
        const reference = node('code', 'file-ref', segment.value);
        reference.title = 'Click to copy';
        container.append(reference);
      } else container.append(document.createTextNode(segment.value));
    }
  }

  function renderBlocks(container, text) {
    for (const block of parseMessageBlocks(text)) {
      if (block.type === 'paragraph') {
        const paragraph = node('p');
        renderInline(paragraph, block.text);
        container.append(paragraph);
      } else {
        const list = node(block.type === 'ordered' ? 'ol' : 'ul');
        block.items.forEach(item => {
          const entry = node('li');
          renderInline(entry, item);
          list.append(entry);
        });
        container.append(list);
      }
    }
  }

  function selectable(element, id, label) {
    element.dataset.brainstormId = id;
    element.dataset.brainstormLabel = label;
    element.classList.add('visual-selectable');
    return element;
  }

  // Each point is its own annotatable component (<owner-id>-pN), so feedback can target
  // one claim instead of the whole card. Ids are positional: edit points in place, append
  // new ones at the end.
  function appendPoints(container, ownerId, ownerTitle, points) {
    if (!points?.length) return;
    const list = node('div', 'point-list');
    list.setAttribute('role', 'list');
    points.forEach((point, index) => {
      const entry = selectable(node('div', 'point'), `${ownerId}-p${index + 1}`, `${ownerTitle} · point ${index + 1}`);
      entry.setAttribute('role', 'listitem');
      const content = node('span', 'point-text');
      renderInline(content, point);
      entry.append(content);
      list.append(entry);
    });
    container.append(list);
  }

  function itemCard(item, extraClass = '') {
    const card = selectable(node('article', `item-card tone-${item.tone} ${extraClass}`.trim()), item.id, item.title);
    card.append(node('h3', '', item.title));
    if (item.detail) {
      const detail = node('p');
      renderInline(detail, item.detail);
      card.append(detail);
    }
    appendPoints(card, item.id, item.title, item.points);
    return card;
  }

  function sectionFrame(section, index) {
    const frame = selectable(node('section', `visual-section section-${section.kind}`), section.id, section.title);
    const header = node('header', 'section-header');
    const label = node('div', 'section-label');
    label.append(node('span', 'section-index', String(index + 1).padStart(2, '0')));
    label.append(node('span', 'section-kind', section.kind));
    header.append(label);
    header.append(node('h2', '', section.title));
    if (section.summary) {
      const summary = node('p');
      renderInline(summary, section.summary);
      header.append(summary);
    }
    frame.append(header);
    return frame;
  }

  function renderFlow(section, index) {
    const frame = sectionFrame(section, index);
    const pipeline = node('ol', 'pipeline');
    section.nodes.forEach((item, itemIndex) => {
      if (itemIndex) {
        const arrow = node('li', 'pipeline-arrow', '→');
        arrow.setAttribute('aria-hidden', 'true');
        pipeline.append(arrow);
      }
      const step = selectable(node('li', `pipeline-step tone-${item.tone}`), item.id, item.title);
      const body = node('div', 'step-body');
      body.append(node('h3', '', item.title));
      if (item.detail) {
        const detail = node('p');
        renderInline(detail, item.detail);
        body.append(detail);
      }
      step.append(body);
      pipeline.append(step);
    });
    frame.append(pipeline);
    return frame;
  }

  function renderDecision(section, index) {
    const frame = sectionFrame(section, index);
    const options = node('div', 'decision-options');
    options.dataset.choiceGroup = section.groupId;
    if (section.multiselect) options.dataset.multiselect = 'true';
    section.options.forEach(option => {
      const button = selectable(node('button', `decision-option tone-${option.tone}`, ''), option.id, option.label);
      button.type = 'button';
      button.dataset.choice = option.id;
      button.dataset.groupId = section.groupId;
      const selected = isChoiceSelected(state.choices, option.id);
      button.setAttribute('aria-pressed', String(selected));
      button.classList.toggle('selected', selected);
      const heading = node('span', 'option-heading');
      heading.append(node('span', 'option-mark'));
      heading.append(node('strong', '', option.label));
      const badges = node('span', 'option-badges');
      if (option.recommended) badges.append(node('span', 'recommended', 'Recommended'));
      if (option.score != null) badges.append(node('span', 'score', `${option.score}/10`));
      if (badges.childNodes.length) heading.append(badges);
      button.append(heading);
      if (option.detail) {
        const detail = node('span', 'option-detail');
        renderInline(detail, option.detail);
        button.append(detail);
      }
      appendPoints(button, option.id, option.label, option.points);
      options.append(button);
    });
    frame.append(options);
    return frame;
  }

  // Prototype element renderers: schema-validated UI controls that look real but are inert.
  // Every element is its own annotation target (<region-id>-eN).
  function renderElement(element) {
    if (element.kind === 'heading') return node('div', 'el-heading', element.text);
    if (element.kind === 'text') return node('div', 'el-text', element.text);
    if (element.kind === 'button') return node('span', `el-button el-button-${element.variant}`, element.label);
    if (element.kind === 'badge') return node('span', `el-badge tone-${element.tone}`, element.label);
    if (element.kind === 'metric') {
      const metric = node('div', 'el-metric');
      metric.append(node('span', 'el-metric-value', element.value));
      metric.append(node('span', 'el-metric-label', element.label));
      return metric;
    }
    if (element.kind === 'input') {
      const field = node('label', `el-input el-input-${element.control}`);
      if (element.label) field.append(node('span', 'el-input-label', element.label));
      if (element.control === 'checkbox') {
        field.append(node('span', 'el-checkbox'));
      } else if (element.control === 'toggle') {
        field.append(node('span', 'el-toggle'));
      } else {
        const box = node('span', 'el-field');
        if (element.control === 'search') box.append(node('span', 'el-field-affix', '⌕'));
        box.append(node('span', element.value ? 'el-field-value' : 'el-field-placeholder', element.value || element.placeholder || ' '));
        if (element.control === 'select') box.append(node('span', 'el-field-affix', '▾'));
        field.append(box);
      }
      return field;
    }
    if (element.kind === 'tabs') {
      const tabs = node('div', 'el-tabs');
      element.labels.forEach((label, tabIndex) => {
        tabs.append(node('span', `el-tab${tabIndex === element.active ? ' active' : ''}`, label));
      });
      return tabs;
    }
    if (element.kind === 'table') {
      const table = node('table', 'el-table');
      const head = node('thead');
      const headRow = node('tr');
      element.columns.forEach(column => headRow.append(node('th', '', column)));
      head.append(headRow);
      table.append(head);
      const body = node('tbody');
      element.rows.forEach(row => {
        const tableRow = node('tr');
        row.forEach(cell => tableRow.append(node('td', '', cell)));
        body.append(tableRow);
      });
      table.append(body);
      return table;
    }
    if (element.kind === 'cells') {
      const grid = node('div', 'el-cells');
      if (element.columns) grid.style.gridTemplateColumns = `repeat(${element.columns}, minmax(30px, 1fr))`;
      element.items.forEach(cell => {
        grid.append(node('span', `el-cell tone-${cell.tone}${cell.filled ? ' filled' : ''}`, cell.label));
      });
      return grid;
    }
    if (element.kind === 'list') {
      const list = node('div', 'el-list');
      element.items.forEach(entry => {
        const row = node('div', 'el-list-row');
        row.append(node('span', 'el-list-title', entry.title));
        if (entry.meta) row.append(node('span', 'el-list-meta', entry.meta));
        list.append(row);
      });
      return list;
    }
    const placeholder = node('div', 'el-placeholder');
    placeholder.append(node('span', '', element.label));
    return placeholder;
  }

  function renderMockup(section, index) {
    const frame = sectionFrame(section, index);
    const device = node('div', `mockup mockup-${section.device}`);
    const bar = node('div', 'mockup-bar');
    bar.append(node('i'), node('i'), node('i'));
    device.append(bar);
    const surface = node('div', 'mockup-surface');
    section.regions.forEach(region => {
      let panel;
      if (region.elements?.length) {
        panel = selectable(node('div', `mockup-region mockup-panel role-${region.role || 'content'}`), region.id, region.title);
        region.elements.forEach((element, elementIndex) => {
          const rendered = renderElement(element);
          selectable(rendered, `${region.id}-e${elementIndex + 1}`, `${region.title} · ${element.kind} ${elementIndex + 1}`);
          panel.append(rendered);
        });
      } else {
        panel = itemCard(region, `mockup-region role-${region.role || 'content'}`);
      }
      if (region.span) panel.style.gridColumn = `span ${region.span}`;
      surface.append(panel);
    });
    device.append(surface);
    frame.append(device);
    return frame;
  }

  function renderList(section, index) {
    const frame = sectionFrame(section, index);
    const list = node('div', `${section.kind}-items`);
    section.items.forEach((item, itemIndex) => {
      const card = itemCard(item, `${section.kind}-item`);
      if (section.kind === 'timeline') card.prepend(node('span', 'timeline-index', String(itemIndex + 1)));
      list.append(card);
    });
    frame.append(list);
    return frame;
  }

  function renderCallout(section, index) {
    const frame = selectable(node('aside', `visual-section callout tone-${section.tone}`), section.id, section.title);
    const header = node('header', 'section-header');
    const label = node('div', 'section-label');
    label.append(node('span', 'section-index', String(index + 1).padStart(2, '0')));
    label.append(node('span', 'section-kind', section.kind));
    header.append(label);
    header.append(node('h2', '', section.title));
    frame.append(header);
    const body = node('div', 'callout-body');
    renderBlocks(body, section.body);
    frame.append(body);
    return frame;
  }

  function renderChangeFlags(changes) {
    if (!elements.changes) return;
    if (!changes || (!changes.added.length && !changes.updated.length && !changes.removed.length)) {
      elements.changes.hidden = true;
      return;
    }
    for (const [ids, css, text] of [[changes.added, 'flag-new', 'new'], [changes.updated, 'flag-updated', 'updated']]) {
      for (const id of ids) {
        const target = elements.canvas.querySelector(`[data-brainstorm-id="${id}"]`);
        if (!target) continue;
        const flag = node('span', `component-flag ${css}`, text);
        flag.setAttribute('aria-hidden', 'true');
        target.append(flag);
      }
    }
    elements.changes.hidden = !changes.removed.length;
    if (changes.removed.length) {
      elements.changes.textContent = `Removed in this revision: ${changes.removed.map(entry => entry.label).join(' · ')}`;
    }
  }

  function renderDocument(documentValue) {
    // Diff against the previously rendered revision so a republish shows the reviewer what
    // moved instead of forcing a full re-read. Same-revision refreshes stay unflagged.
    const nextRevision = documentRevision(documentValue);
    const changes = state.document && state.screenRevision !== nextRevision
      ? computeComponentChanges(state.document, documentValue)
      : null;
    state.document = documentValue;
    state.screenRevision = nextRevision;
    clearScreenError();
    document.body.dataset.profile = documentValue.profile;
    elements.profile.textContent = documentValue.profile;
    elements.audience.textContent = documentValue.audience ? `For ${documentValue.audience}` : '';
    elements['document-title'].textContent = documentValue.title;
    elements['document-summary'].textContent = documentValue.summary;
    if (elements.revision) elements.revision.textContent = `rev ${state.screenRevision}`;
    if (elements['doc-meta']) {
      const count = documentValue.sections.length;
      elements['doc-meta'].textContent = `${documentValue.profile} · ${count} ${count === 1 ? 'section' : 'sections'}`;
    }
    elements.canvas.replaceChildren();
    const renderers = {
      anchor: renderList,
      callout: renderCallout,
      cards: renderList,
      decision: renderDecision,
      flow: renderFlow,
      mockup: renderMockup,
      timeline: renderList,
    };
    documentValue.sections.forEach((section, index) => elements.canvas.append(renderers[section.kind](section, index)));
    renderAnnotationMarkers();
    renderChangeFlags(changes);
  }

  async function loadScreen() {
    if (embedded) { renderDocument(embedded.screen); return; }
    const response = await fetch(`${basePath}api/screen`);
    if (!response.ok) throw new Error(await readResponseError(response, `screen request failed: ${response.status}`));
    renderDocument(await response.json());
  }

  function historyEntry(event) {
    const card = node('article', `history-item ${event.role}`);
    const head = node('header', 'history-head');
    head.append(node('strong', '', event.role === 'agent' ? 'Agent' : 'You'));
    if (event.timestamp) {
      const time = node('time', '', new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      head.append(time);
    }
    card.append(head);
    const body = node('div', 'history-body');
    renderBlocks(body, event.message || (event.role === 'user' ? 'Visual feedback saved.' : 'Response received.'));
    card.append(body);
    const annotations = Array.isArray(event.annotations) ? event.annotations : [];
    const choices = Array.isArray(event.choices) ? event.choices : [];
    if (annotations.length || choices.length) {
      const parts = [];
      if (annotations.length) parts.push(`${annotations.length} ${annotations.length === 1 ? 'note' : 'notes'}`);
      if (choices.length) parts.push(`${choices.length} ${choices.length === 1 ? 'choice' : 'choices'}`);
      card.append(node('p', 'history-meta', parts.join(' · ')));

      // Render each submitted note and choice verbatim so feedback stays reviewable in the
      // browser after submit + refresh, not just as a count. The data is on the event.
      if (annotations.length) {
        const list = node('ul', 'history-details');
        annotations.forEach(annotation => {
          const item = node('li', 'history-detail history-note');
          const label = annotation?.target?.label || annotation?.target?.componentId;
          if (label) item.append(node('span', 'history-detail-label', label));
          const comment = node('span', 'history-detail-text');
          renderInline(comment, String(annotation.comment || ''));
          item.append(comment);
          list.append(item);
        });
        card.append(list);
      }
      if (choices.length) {
        const list = node('ul', 'history-details');
        choices.forEach(choice => {
          const item = node('li', 'history-detail history-choice');
          item.append(node('span', 'history-detail-label', 'Chose'));
          item.append(node('span', 'history-detail-text', choice.label || choice.value));
          list.append(item);
        });
        card.append(list);
      }
    }
    return card;
  }

  async function loadSession() {
    let snapshot;
    if (embedded) {
      snapshot = embedded.session;
    } else {
      const response = await fetch(`${basePath}api/session`);
      if (!response.ok) throw new Error(await readResponseError(response, `session request failed: ${response.status}`));
      snapshot = await response.json();
    }
    state.events = (snapshot && snapshot.events) || [];
    elements.history.replaceChildren();
    if (!state.events.length) {
      elements.history.append(node('p', 'history-empty', 'No feedback exchanged yet. Select options, annotate components, then save one batch.'));
    }
    state.events.forEach(event => elements.history.append(historyEntry(event)));
    elements.history.scrollTop = elements.history.scrollHeight;
    // Submitted annotations come from history, so committed markers must refresh with it.
    renderAnnotationMarkers();
  }

  function renderPending() {
    elements.pending.replaceChildren();
    const addChip = (kind, label, remove) => {
      const chip = node('span', `chip chip-${kind}`);
      chip.append(node('span', 'chip-kind', kind === 'note' ? 'Note' : 'Choice'));
      chip.append(node('span', 'chip-label', label));
      const button = node('button', '', '×');
      button.type = 'button';
      button.setAttribute('aria-label', `Remove ${kind}: ${label}`);
      button.addEventListener('click', remove);
      chip.append(button);
      elements.pending.append(chip);
    };
    state.annotations.forEach((annotation, index) => addChip('note', annotation.target.label, () => {
      state.annotations.splice(index, 1); persist(); renderPending();
    }));
    state.choices.forEach((choice, index) => addChip('choice', choice.label, () => {
      state.choices.splice(index, 1); persist(); renderPending();
      const option = Array.from(document.querySelectorAll('[data-choice]'))
        .find(element => element.dataset.brainstormId === choice.componentId);
      option?.setAttribute('aria-pressed', 'false');
      option?.classList.remove('selected');
    }));
    elements.submit.disabled = state.submitting
      || (!state.message.trim() && !state.annotations.length && !state.choices.length);
    renderAnnotationMarkers();
  }

  function submittedAnnotations() {
    // Every annotation the user has already submitted lives in the session history; these stay
    // on the components as committed markers so feedback remains visible after submit and after
    // the agent replies or revises the screen — not only in the chat panel.
    const all = [];
    for (const event of state.events) {
      if (event.role !== 'user' || !Array.isArray(event.annotations)) continue;
      all.push(...event.annotations);
    }
    return all;
  }

  function renderAnnotationMarkers() {
    document.querySelectorAll('[data-annotation-badge]').forEach(element => element.remove());
    document.querySelectorAll('.has-annotations').forEach(element => {
      element.classList.remove('has-annotations', 'has-pending-annotations', 'has-committed-annotations');
      element.removeAttribute('data-annotation-count');
      element.removeAttribute('title');
      element.removeAttribute('aria-label');
    });

    const pendingByComponent = groupAnnotationsByComponent(state.annotations);
    const submittedByComponent = groupAnnotationsByComponent(submittedAnnotations());
    const componentIds = new Set([...submittedByComponent.keys(), ...pendingByComponent.keys()]);
    for (const componentId of componentIds) {
      const target = Array.from(document.querySelectorAll('[data-brainstorm-id]'))
        .find(element => element.dataset.brainstormId === componentId);
      if (!target) continue;
      const pending = pendingByComponent.get(componentId) || [];
      const submitted = submittedByComponent.get(componentId) || [];
      const combined = [...submitted, ...pending];
      const summary = annotationSummary(combined);
      // Pending (unsent) markers keep the amber attention style; once everything on a component
      // is submitted it becomes the quieter committed style.
      const badge = node('span', `annotation-badge${pending.length ? '' : ' committed'}`, String(combined.length));
      badge.dataset.annotationBadge = 'true';
      badge.setAttribute('aria-hidden', 'true');
      target.classList.add('has-annotations', pending.length ? 'has-pending-annotations' : 'has-committed-annotations');
      target.dataset.annotationCount = String(combined.length);
      target.title = summary;
      target.setAttribute('aria-label', `${target.dataset.brainstormLabel || target.textContent.trim()}. ${summary}`);
      target.append(badge);
    }
  }

  function describeTarget(target) {
    return {
      componentId: target.dataset.brainstormId,
      label: target.dataset.brainstormLabel || target.textContent.trim().slice(0, 120),
    };
  }

  function highlight(target) {
    if (!state.annotate || !target) { elements.highlight.hidden = true; return; }
    const rectangle = target.getBoundingClientRect();
    Object.assign(elements.highlight.style, {
      left: `${rectangle.left}px`, top: `${rectangle.top}px`, width: `${rectangle.width}px`, height: `${rectangle.height}px`,
    });
    elements['highlight-label'].textContent = target.dataset.brainstormLabel;
    elements.highlight.hidden = false;
  }

  function setAnnotate(active) {
    state.annotate = active;
    elements.annotate.setAttribute('aria-pressed', String(active));
    elements.annotate.textContent = active ? 'Annotating' : 'Annotate';
    document.body.classList.toggle('annotating', active);
    if (elements['annotate-hint']) elements['annotate-hint'].hidden = !active;
    if (!active) highlight(null);
  }

  function queueChoice(target) {
    if (embedded) return;
    const group = target.closest('[data-choice-group]');
    const selected = target.getAttribute('aria-pressed') !== 'true';
    target.setAttribute('aria-pressed', String(selected));
    target.classList.toggle('selected', selected);
    if (group && !group.hasAttribute('data-multiselect') && selected) {
      group.querySelectorAll('[data-choice]').forEach(option => {
        if (option !== target) { option.setAttribute('aria-pressed', 'false'); option.classList.remove('selected'); }
      });
    }
    state.choices = reconcileChoices(state.choices, {
      groupId: target.dataset.groupId,
      componentId: target.dataset.brainstormId,
      value: target.dataset.choice,
      label: target.dataset.brainstormLabel,
    }, { selected, multiselect: Boolean(group?.hasAttribute('data-multiselect')) });
    persist(); renderPending();
  }

  async function submitFeedback() {
    // One Feedback Batch replaces per-note turns and agent-side polling.
    if (embedded || state.submitting) return;
    state.submitting = true;
    state.clientTurnId ||= globalThis.crypto?.randomUUID?.() || `feedback-${Date.now()}`;
    persist(); renderPending();
    try {
      const response = await fetch(`${basePath}api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientTurnId: state.clientTurnId,
          message: state.message.trim(),
          annotations: state.annotations,
          choices: state.choices,
          screen: { id: 'screen', file: 'screen.json', revision: state.screenRevision },
        }),
      });
      if (!response.ok) throw new Error((await response.json()).error || `feedback request failed: ${response.status}`);
      state.annotations = [];
      state.choices = [];
      state.message = '';
      state.clientTurnId = null;
      elements.message.value = '';
      persist();
      loadSession().catch(() => {});
      elements.handoff.textContent = 'Feedback saved. Waiting for Codex or Claude to pick it up from this session.';
      elements.handoff.classList.add('saved');
    } finally {
      state.submitting = false;
      renderPending();
    }
  }

  document.addEventListener('pointerover', event => {
    if (!state.annotate) return;
    highlight(event.target.closest?.('[data-brainstorm-id]'));
  }, true);
  document.addEventListener('click', event => {
    if (!state.annotate) return;
    const target = event.target.closest?.('[data-brainstorm-id]');
    if (!target) return;
    event.preventDefault(); event.stopImmediatePropagation();
    state.selectedTarget = describeTarget(target);
    elements['annotation-target'].textContent = state.selectedTarget.label;
    elements['annotation-comment'].value = '';
    elements['annotation-dialog'].showModal();
  }, true);
  document.addEventListener('click', event => {
    if (state.annotate) return;
    const choice = event.target.closest?.('[data-choice]');
    if (choice) { queueChoice(choice); return; }
    const reference = event.target.closest?.('.file-ref');
    if (reference && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(reference.textContent).then(() => {
        reference.classList.add('copied');
        setTimeout(() => reference.classList.remove('copied'), 900);
      }).catch(() => {});
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.annotate) { setAnnotate(false); return; }
    if (embedded) return;
    // ⌘/Ctrl+Enter saves the batch from anywhere, including mid-typing in the note field.
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      submitFeedback().catch(error => { elements.handoff.textContent = error.message; });
      return;
    }
    // `a` toggles annotation mode, but never while typing.
    const active = document.activeElement;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(active?.tagName || '') || active?.isContentEditable;
    if (!typing && !event.metaKey && !event.ctrlKey && !event.altKey && event.key === 'a') {
      event.preventDefault();
      setAnnotate(!state.annotate);
    }
  });
  elements['queue-annotation'].addEventListener('click', event => {
    const comment = elements['annotation-comment'].value.trim();
    if (!comment || !state.selectedTarget) { event.preventDefault(); return; }
    if (state.annotations.length >= 50) {
      event.preventDefault();
      elements.handoff.textContent = 'Annotation limit reached (50). Submit this batch, then continue.';
      return;
    }
    state.annotations.push({
      id: globalThis.crypto?.randomUUID?.() || `note-${Date.now()}`,
      comment,
      target: state.selectedTarget,
    });
    state.selectedTarget = null; persist(); renderPending();
  });
  elements.annotate.addEventListener('click', () => setAnnotate(!state.annotate));
  elements.clear.addEventListener('click', () => {
    state.annotations = [];
    state.choices = [];
    state.message = '';
    state.clientTurnId = null;
    elements.message.value = '';
    document.querySelectorAll('[data-choice]').forEach(option => {
      option.setAttribute('aria-pressed', 'false');
      option.classList.remove('selected');
    });
    persist(); renderPending();
  });
  elements.message.addEventListener('input', () => {
    state.message = elements.message.value;
    persist(); renderPending();
  });
  async function saveVisual() {
    if (embedded) return;
    elements.save.disabled = true;
    try {
      const response = await fetch(`${basePath}api/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) throw new Error(await readResponseError(response, `save failed: ${response.status}`));
      const result = await response.json();
      elements['save-status'].textContent = `Saved a standalone snapshot → ${result.path}`;
    } catch (error) {
      elements['save-status'].textContent = error.message;
    } finally {
      elements['save-status'].hidden = false;
      elements.save.disabled = embedded;
    }
  }

  elements.submit.addEventListener('click', () => submitFeedback().catch(error => { elements.handoff.textContent = error.message; }));
  elements.save.addEventListener('click', () => saveVisual());
  elements.refresh.addEventListener('click', () => Promise.all([
    loadScreen().catch(error => showScreenError(error.message)),
    loadSession().catch(() => { elements.connection.textContent = 'Session error'; }),
  ]));

  if (embedded) {
    // Read-only export: no live server to talk to, so disable every feedback control.
    elements.connection.textContent = 'Offline export';
    elements.connection.classList.add('offline');
    elements.handoff.textContent = 'Read-only export. Feedback is disabled in this standalone copy.';
    ['annotate', 'clear', 'submit', 'refresh', 'save', 'message'].forEach(id => { if (elements[id]) elements[id].disabled = true; });
  } else {
    const updates = new EventSource(`${basePath}api/events`);
    updates.addEventListener('open', () => {
      elements.connection.textContent = 'Connected';
      elements.connection.classList.add('live');
    });
    updates.addEventListener('screen', () => loadScreen().catch(error => showScreenError(error.message)));
    updates.addEventListener('session', () => loadSession().catch(() => { elements.connection.textContent = 'Session error'; }));
    updates.addEventListener('error', () => {
      elements.connection.textContent = 'Reconnecting';
      elements.connection.classList.remove('live');
    });
  }

  renderPending();
  Promise.all([
    loadScreen().catch(error => { showScreenError(error.message); elements.canvas.textContent = error.message; }),
    loadSession().catch(() => { elements.connection.textContent = 'Session error'; }),
  ]);
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    annotationSummary,
    computeComponentChanges,
    groupAnnotationsByComponent,
    isChoiceSelected,
    normalizeFeedbackDraft,
    parseInlineSegments,
    parseMessageBlocks,
    readResponseError,
    reconcileChoices,
  };
}
