const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('the injected companion supports React-compatible annotation and shared-session chat', () => {
  const app = read('assets/visual-shell/app.js');
  const styles = read('assets/visual-shell/styles.css');
  const shell = read('assets/visual-shell/index.html');

  assert.match(shell, /visual-shell-root/);
  assert.match(app, /data-brainstorm-id/);
  assert.match(app, /annotation/i);
  assert.match(app, /annotation-badge/i);
  assert.match(styles, /annotation-badge/);
  assert.match(app, /feedback batch/i);
  assert.match(app, /Waiting for Codex or Claude/i);
  assert.doesNotMatch(app, /visual ready/i);
  assert.match(app, /state\.submitting/);
  assert.match(app, /history\.replaceState/);
  assert.match(styles, /data-profile="technical"/);
  assert.match(styles, /data-profile="product"/);
  assert.match(styles, /data-profile="business"/);
  assert.match(styles, /@media \(max-width: 980px\)[\s\S]*data-profile="business"[\s\S]*grid-column:\s*span 12/);
});

test('the skill teaches the exact-session visual loop without a second agent', () => {
  const skill = read('SKILL.md');
  const guide = read('visual-companion.md');

  assert.match(skill, /live visual interview/i);
  assert.match(guide, /screen\.json/);
  assert.match(guide, /technical.*product.*business/is);
  assert.match(guide, /visual-session\.cjs wait --timeout-ms 900000/i);
  assert.doesNotMatch(guide, /session-bridge\.cjs wait/);
  assert.match(guide, /data-brainstorm-id/);
  assert.match(guide, /React/i);
  assert.match(guide, /same active agent turn/i);
  assert.match(guide, /Do not use `codex exec resume`, `claude --resume`/i);
  assert.match(guide, /Codex.*must remain in foreground/i);
  assert.match(guide, /restart.*new `connection_url`/i);
  assert.match(guide, /zero agent polling/i);
  assert.match(guide, /target project.*working directory/i);
  assert.match(guide, /visual-session\.cjs scaffold/i);
  assert.match(guide, /never spend model turns repairing a guessed section shape/i);
  assert.doesNotMatch(`${skill}\n${guide}`, /visual ready/i);
});

test('the skill delegates only bounded evidence extraction to a lower-tier model', () => {
  const skill = read('SKILL.md');
  const guide = read('evidence-scout.md');

  assert.match(skill, /at most one main-model reconnaissance batch/i);
  assert.match(skill, /run one bounded scout/i);
  assert.match(skill, /coordinator owns the Core Anchor/i);
  assert.match(guide, /gpt-5\.4-mini/i);
  assert.match(guide, /Haiku/i);
  assert.match(guide, /brief is at most 4 KB/i);
  assert.match(guide, /evidence packet is at most 6 KB/i);
  assert.match(guide, /Do not retry with another model automatically/i);
  assert.match(guide, /architecture recommendations.*forbidden/i);
});
