const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '../../../..');

function installedHookEnvironment(t, scratchRoot) {
  fs.mkdirSync(scratchRoot, { recursive: true });
  const runtimeRoot = fs.mkdtempSync(path.join(scratchRoot, 'runtime-hooks-'));
  const codexHome = path.join(runtimeRoot, 'codex');
  const claudeHome = path.join(runtimeRoot, 'claude');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(claudeHome, { recursive: true });
  const handoverGate = path.join(repositoryRoot, 'hooks', 'handover-gate.sh');
  const stopGate = path.join(repositoryRoot, 'hooks', 'stop-gate.sh');
  const configuration = runtime => ({
    hooks: {
      UserPromptSubmit: [{
        matcher: '',
        hooks: [{
          type: 'command',
          command: `PAIR_HOOK_RUNTIME=${runtime} bash ${JSON.stringify(handoverGate)}`,
        }],
      }],
      Stop: [{
        matcher: '',
        hooks: [{
          type: 'command',
          command: `PAIR_HOOK_RUNTIME=${runtime} bash ${JSON.stringify(stopGate)}`,
        }],
      }],
    },
  });
  fs.writeFileSync(path.join(codexHome, 'hooks.json'), `${JSON.stringify(configuration('codex'), null, 2)}\n`);
  fs.writeFileSync(path.join(claudeHome, 'settings.json'), `${JSON.stringify(configuration('claude'), null, 2)}\n`);
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  return { CODEX_HOME: codexHome, CLAUDE_HOME: claudeHome };
}

module.exports = { installedHookEnvironment };
