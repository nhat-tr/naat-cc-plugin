const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const skill = path.resolve(__dirname, '../SKILL.md');

test('registered Pair and brainstorming conversations retain bounded semantic checkpoints while unrelated conversations remain inert', () => {
  const content = fs.readFileSync(skill, 'utf8');
  assert.match(content, /Agent Conversation Checkpoint/u);
  assert.match(content, /material research or decision boundary/u);
  assert.match(content, /confirmed Core Anchor/u);
  assert.match(content, /never persist.*prompt.*transcript.*private reasoning/isu);
});
