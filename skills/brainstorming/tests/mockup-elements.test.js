const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { normalizeVisualDocument } = require('../scripts/visual-document.cjs');

function mockupDocument(regions) {
  return {
    version: 1,
    profile: 'product',
    title: 'Order screen',
    sections: [{ kind: 'mockup', id: 'screen', title: 'Proposed screen', device: 'desktop', regions }],
  };
}

test('mockup regions accept typed UI elements with materialized defaults', () => {
  const document = normalizeVisualDocument(mockupDocument([{
    id: 'toolbar',
    title: 'Toolbar',
    span: 12,
    elements: [
      { kind: 'heading', text: 'Regrinding orders' },
      { kind: 'input', placeholder: 'Search serial…', control: 'search' },
      { kind: 'button', label: 'New order', variant: 'primary' },
      { kind: 'button', label: 'Export' },
    ],
  }]));
  const region = document.sections[0].regions[0];
  assert.equal(region.span, 12);
  assert.deepEqual(region.elements[0], { kind: 'heading', text: 'Regrinding orders' });
  assert.deepEqual(region.elements[1], { kind: 'input', control: 'search', placeholder: 'Search serial…' });
  assert.deepEqual(region.elements[2], { kind: 'button', label: 'New order', variant: 'primary' });
  assert.deepEqual(region.elements[3], { kind: 'button', label: 'Export', variant: 'secondary' });
});

test('tables, tabs, lists, metrics, badges, and placeholders normalize with bounds', () => {
  const document = normalizeVisualDocument(mockupDocument([{
    id: 'content',
    title: 'Content',
    elements: [
      { kind: 'tabs', labels: ['Open', 'Done'], active: 1 },
      { kind: 'table', columns: ['Serial', 'Tool', 'Status'], rows: [['SN-1042', 'Cutter', 'Grinding']] },
      { kind: 'list', items: [{ title: 'SN-1042', meta: 'today' }] },
      { kind: 'metric', label: 'Open orders', value: '14' },
      { kind: 'badge', label: 'Overdue', tone: 'critical' },
      { kind: 'placeholder', label: 'Throughput chart' },
      { kind: 'cells', columns: 8, items: [{ label: '1', filled: true }, { label: '2' }] },
    ],
  }]));
  const elements = document.sections[0].regions[0].elements;
  assert.deepEqual(elements[6], {
    kind: 'cells',
    columns: 8,
    items: [{ label: '1', tone: 'neutral', filled: true }, { label: '2', tone: 'neutral', filled: false }],
  });
  assert.deepEqual(elements[0], { kind: 'tabs', labels: ['Open', 'Done'], active: 1 });
  assert.deepEqual(elements[1].rows, [['SN-1042', 'Cutter', 'Grinding']]);
  assert.deepEqual(elements[2].items, [{ title: 'SN-1042', meta: 'today' }]);
  assert.deepEqual(elements[3], { kind: 'metric', label: 'Open orders', value: '14' });
  assert.deepEqual(elements[4], { kind: 'badge', label: 'Overdue', tone: 'critical' });
  assert.deepEqual(elements[5], { kind: 'placeholder', label: 'Throughput chart' });
});

test('element documents are canonical under re-normalization', () => {
  const once = normalizeVisualDocument(mockupDocument([{
    id: 'a', title: 'A', span: 4,
    elements: [{ kind: 'button', label: 'Save' }, { kind: 'tabs', labels: ['One', 'Two'] }],
  }]));
  assert.deepEqual(normalizeVisualDocument(once), once);
  assert.equal(once.sections[0].regions[0].elements[1].active, 0);
});

test('element abuse is rejected: unknown kinds, ragged tables, oversize groups, bad spans', () => {
  const attempt = (regions, pattern) => assert.throws(() => normalizeVisualDocument(mockupDocument(regions)), pattern);
  attempt([{ id: 'a', title: 'A', elements: [{ kind: 'iframe', src: 'x' }] }], /element kind/);
  attempt([{ id: 'a', title: 'A', elements: [{ kind: 'button', label: 'x', onclick: 'x' }] }], /unsupported field/);
  attempt([{ id: 'a', title: 'A', elements: [{ kind: 'table', columns: ['A', 'B'], rows: [['only-one']] }] }], /row/);
  attempt([{ id: 'a', title: 'A', elements: Array.from({ length: 9 }, () => ({ kind: 'badge', label: 'x' })) }], /elements/);
  attempt([{ id: 'a', title: 'A', span: 13, elements: [{ kind: 'badge', label: 'x' }] }], /span/);
});

test('regions without elements stay valid for existing documents', () => {
  const document = normalizeVisualDocument(mockupDocument([
    { id: 'plain', title: 'Primary task', detail: 'Old-style labeled region.' },
  ]));
  const region = document.sections[0].regions[0];
  assert.equal('elements' in region, false);
  assert.equal('span' in region, false);
});

test('the shell renders elements as annotatable prototype components', () => {
  const app = fs.readFileSync(path.join(__dirname, '../ui/app/WorkspaceHost.tsx'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '../assets/visual-shell/styles.css'), 'utf8');
  assert.match(app, /ElementView/);
  assert.match(app, /-e\$\{/); // derived per-element ids like <region-id>-e1
  assert.match(styles, /\.el-button\b/);
  assert.match(styles, /\.el-input\b/);
  assert.match(styles, /\.el-table\b/);
});
