const assert = require('node:assert/strict');
const test = require('node:test');

const { parseInlineSegments, parseMessageBlocks } = require('../assets/visual-shell/app.js');

test('plain text stays one text segment', () => {
  assert.deepEqual(parseInlineSegments('keep the render path simple'), [
    { type: 'text', value: 'keep the render path simple' },
  ]);
});

test('bold and code markup become typed segments instead of literal asterisks', () => {
  assert.deepEqual(parseInlineSegments('**Multi-tool** uses `agent.ui.render` once'), [
    { type: 'strong', value: 'Multi-tool' },
    { type: 'text', value: ' uses ' },
    { type: 'code', value: 'agent.ui.render' },
    { type: 'text', value: ' once' },
  ]);
});

test('code spans keep their content literal', () => {
  assert.deepEqual(parseInlineSegments('`**not bold**`'), [
    { type: 'code', value: '**not bold**' },
  ]);
});

test('file references with line numbers become fileref segments without trailing punctuation', () => {
  assert.deepEqual(parseInlineSegments('wired in Factory.cs:135, see AgentRunMiddleware.cs:154.'), [
    { type: 'text', value: 'wired in ' },
    { type: 'fileref', value: 'Factory.cs:135' },
    { type: 'text', value: ', see ' },
    { type: 'fileref', value: 'AgentRunMiddleware.cs:154' },
    { type: 'text', value: '.' },
  ]);
});

test('paths and line ranges are detected; product names like Node.js are not', () => {
  assert.deepEqual(parseInlineSegments('Node.js reads assets/app.js and Tool.cs:203-216'), [
    { type: 'text', value: 'Node.js reads ' },
    { type: 'fileref', value: 'assets/app.js' },
    { type: 'text', value: ' and ' },
    { type: 'fileref', value: 'Tool.cs:203-216' },
  ]);
});

test('unterminated markup falls back to literal text', () => {
  assert.deepEqual(parseInlineSegments('a ** dangling `tick'), [
    { type: 'text', value: 'a ** dangling `tick' },
  ]);
});

test('numbered lines group into one ordered list block', () => {
  assert.deepEqual(parseMessageBlocks('Answered your notes:\n\n1. **Yes** it works\n2. See Node.cs:27'), [
    { type: 'paragraph', text: 'Answered your notes:' },
    { type: 'ordered', items: ['**Yes** it works', 'See Node.cs:27'] },
  ]);
});

test('dash lines group into one bulleted list block', () => {
  assert.deepEqual(parseMessageBlocks('- first\n- second'), [
    { type: 'bulleted', items: ['first', 'second'] },
  ]);
});

test('blank lines split paragraphs and inner newlines are preserved', () => {
  assert.deepEqual(parseMessageBlocks('line one\nline two\n\nnext paragraph'), [
    { type: 'paragraph', text: 'line one\nline two' },
    { type: 'paragraph', text: 'next paragraph' },
  ]);
});
