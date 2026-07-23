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
  const appSource = read('ui/app/VisualCompanionApp.tsx');
  const feedbackSource = read('ui/shared/FeedbackPanel.tsx');
  const hostSource = read('ui/app/WorkspaceHost.tsx');
  const styleSource = read('ui/styles/shell.css');

  assert.match(shell, /visual-shell-root/);
  assert.match(hostSource, /data-brainstorm-id/);
  assert.match(feedbackSource, /annotation/i);
  assert.match(styles, /thread-state/);
  assert.match(feedbackSource, /feedback batch/i);
  assert.match(appSource, /api\/feedback/);
  assert.doesNotMatch(`${app}\n${appSource}\n${feedbackSource}`, /visual ready/i);
  assert.match(appSource, /submitting/);
  assert.match(appSource, /groupAnnotationsByComponent/);
  assert.match(appSource, /annotationSummary/);
  assert.match(appSource, /data-annotation-badge/);
  assert.match(styleSource, /\.annotation-badge/);
  assert.match(styleSource, /\.has-pending-annotations/);
  assert.match(styleSource, /\.has-committed-annotations/);
  assert.match(appSource, /history\.replaceState/);
  assert.match(styleSource, /data-profile="technical"/);
  assert.match(styleSource, /data-profile="product"/);
  assert.match(styleSource, /data-profile="business"/);
  assert.match(styleSource, /@media \(max-width: 980px\)[\s\S]*data-profile="business"[\s\S]*grid-column:\s*span 12/);
});

test('targeted note typing is isolated from Feedback Threads and Session history rendering', () => {
  const composerPath = path.join(root, 'ui/shared/AnnotationComposer.tsx');
  assert.ok(fs.existsSync(composerPath), 'Annotation Composer must own its high-frequency input state');
  const composerSource = fs.readFileSync(composerPath, 'utf8');
  const feedbackSource = read('ui/shared/FeedbackPanel.tsx');

  assert.match(composerSource, /useState\(""\)/);
  assert.match(composerSource, /setAnnotationText/);
  assert.match(feedbackSource, /<AnnotationComposer/);
  assert.doesNotMatch(feedbackSource, /setAnnotationText/);
  assert.match(feedbackSource, /memo\(function FeedbackThreads/);
  assert.match(feedbackSource, /memo\(function SessionHistory/);
});

test('the skill teaches the exact-session visual loop without a second agent', () => {
  const skill = read('SKILL.md');
  const guide = read('visual-companion.md');
  const architectureGuide = read('references/architecture-visual.md');

  assert.match(skill, /live visual interview/i);
  assert.match(skill, /Product Concept Studio.*Architecture Canvas.*Research Evidence Board.*Business Reasoning Canvas.*Feature Review Workbench/is);
  assert.match(skill, /references\/architecture-visual\.md/i);
  assert.match(skill, /workspace\.json.*screen\.json.*v1 compatibility/is);
  assert.doesNotMatch(skill, /Every visual[\s\S]{0,200}validated `screen\.json` grammar/i);
  assert.match(guide, /screen\.json/);
  assert.match(guide, /technical.*product.*business/is);
  assert.match(guide, /\| Product Concept Studio \| `product`/);
  assert.match(guide, /\| Architecture Canvas \| `architecture`/);
  assert.match(guide, /\| Research Evidence Board \| `research`/);
  assert.match(guide, /\| Business Reasoning Canvas \| `business`/);
  assert.match(guide, /\| Feature Review Workbench \| `review`/);
  assert.match(guide, /\| UML Diagram \| `uml`/);
  assert.match(guide, /references\/uml-visual\.md/i);
  for (const workspaceKind of ['product', 'architecture', 'research', 'business', 'review']) {
    assert.match(guide, new RegExp(`--workspace-kind ${workspaceKind}`, 'u'));
  }
  assert.match(guide, /visual-session\.cjs migrate[\s\S]*--work-id[\s\S]*--workspace-kind/i);
  assert.match(guide, /visual-session\.cjs backout/i);
  assert.match(guide, /visual-session\.cjs wait --timeout-ms 900000/i);
  assert.doesNotMatch(guide, /session-bridge\.cjs wait/);
  assert.match(guide, /data-brainstorm-id/);
  assert.match(guide, /React/i);
  assert.match(guide, /background wait/i);
  assert.match(guide, /automatically re-invoke/i);
  assert.match(guide, /server.*in foreground/i);
  assert.match(guide, /restart.*new `connection_url`/i);
  assert.match(guide, /never watch the session/i);
  assert.match(guide, /target project.*working directory/i);
  assert.match(skill, /routine Visual Session commands.*active sandbox/i);
  assert.match(skill, /do not.*require_escalated.*proactively/i);
  assert.match(skill, /one scoped approval.*visual-session\.cjs/i);
  assert.match(skill, /never request approval separately.*publish.*wait.*reply/is);
  assert.match(skill, /normal visual path.*at most five model-visible command boundaries/i);
  assert.match(skill, /do not call.*--help/i);
  assert.match(skill, /do not reread.*scaffold/i);
  assert.match(skill, /either direct reconnaissance or one Evidence Scout.*never both/i);
  assert.match(skill, /do not poll.*server.*execution handle/i);
  assert.match(skill, /one background feedback wait/i);
  assert.match(guide, /visual-session\.cjs scaffold/i);
  assert.match(guide, /never spend model turns repairing a guessed section shape/i);
  assert.match(architectureGuide, /visual-session\.cjs present --draft/i);
  assert.match(architectureGuide, /visual-session\.cjs publish --draft/i);
  assert.match(architectureGuide, /does not require.*migrat/i);
  assert.match(architectureGuide, /data-layout-status.*ready/i);
  assert.match(architectureGuide, /Decision Options/i);
  assert.match(architectureGuide, /adapter.*artifact.*data_store.*external_system.*interface.*service.*worker/is);
  assert.match(architectureGuide, /command.*control.*data.*event.*evidence/is);
  assert.match(architectureGuide, /parent_id.*modes.*change.*multiselect/is);
  assert.match(architectureGuide, /wait[\s\S]{0,60}background task/i);
  assert.ok(Buffer.byteLength(architectureGuide, 'utf8') <= 6_000, 'Architecture runbook must stay bounded');
  assert.doesNotMatch(`${skill}\n${guide}`, /visual ready/i);
});

test('the skill delegates only bounded evidence extraction to a lower-tier model', () => {
  const skill = read('SKILL.md');
  const guide = read('evidence-scout.md');

  assert.match(skill, /at most one main-model reconnaissance batch/i);
  assert.match(skill, /run one bounded scout/i);
  assert.match(skill, /generic `Agent\/Explore`.*forbidden/i);
  assert.match(skill, /coordinator owns the Core Anchor/i);
  assert.match(guide, /gpt-5\.4-mini/i);
  assert.match(guide, /Haiku/i);
  assert.match(guide, /brief is at most 4 KB/i);
  assert.match(guide, /evidence packet is at most 6 KB/i);
  assert.match(guide, /Do not retry with another model automatically/i);
  assert.match(guide, /architecture recommendations.*forbidden/i);
});

test('the skill bounds coordinator output, web research, wait resumptions, and Revision churn', () => {
  const skill = read('SKILL.md');

  assert.match(skill, /each reconnaissance cell.*2,000 output tokens/i);
  assert.match(skill, /combined reconnaissance output.*12 KB/i);
  assert.match(skill, /web research.*response_length.*short/i);
  assert.match(skill, /never request.*response_length.*long/i);
  assert.match(skill, /Publish only for a material Revision/i);
  assert.match(skill, /never Publish an unchanged Revision/i);
});
