// AC-9: spawned children boot without user MCP servers on both runtimes.
//
// Measured at ~28K tokens of boot context per spawn: a headless child connects every MCP server the human
// configured for their own interactive sessions — jetbrains among them — and addresses none of them.
// Across the 62 calls of a five-item Work that is pure overhead, paid every time.

const assert = require('node:assert/strict');
const test = require('node:test');

const { bootDietArguments, buildProviderCommand } = require('../scripts/lib/provider-runtime');

const COMMON = {
  root: '/repo/worktree',
  prompt: 'bounded prompt',
  schemaPath: '/schema.json',
  schema: { type: 'object' },
  outputPath: '/result.json',
  effort: 'medium',
  model: 'claude-opus-5',
};

test('claude children boot with only the MCP configuration Pair gives them, which is none', () => {
  for (const mode of ['implementation', 'review']) {
    const command = buildProviderCommand({ ...COMMON, runtime: 'claude', mode });
    assert.ok(command.args.includes('--strict-mcp-config'),
      `${mode} child still inherits the user's MCP servers`);
    assert.ok(!command.args.includes('--mcp-config'),
      'and Pair supplies no servers of its own, so strict means none at all');
  }
});

test('codex children override the servers its config file would otherwise load', () => {
  for (const mode of ['implementation', 'review']) {
    const command = buildProviderCommand({ ...COMMON, runtime: 'codex', mode });
    const index = command.args.indexOf('mcp_servers={}');
    assert.ok(index > 0, `${mode} child still loads [mcp_servers.*] from ~/.codex/config.toml`);
    assert.equal(command.args[index - 1], '-c', 'the override has to arrive as a config override');
  }
});

test('the diet applies to warm spawns exactly as it does to fresh ones', () => {
  const warm = buildProviderCommand({ ...COMMON, runtime: 'claude', mode: 'implementation', resumeSessionId: 'sess-1', persistSession: true });
  assert.ok(warm.args.includes('--strict-mcp-config'));
  const codexWarm = buildProviderCommand({ ...COMMON, runtime: 'codex', mode: 'implementation', resumeSessionId: 'sess-1', persistSession: true });
  assert.ok(codexWarm.args.includes('mcp_servers={}'));
  assert.deepEqual(bootDietArguments('claude'), ['--strict-mcp-config']);
  assert.deepEqual(bootDietArguments('codex'), ['-c', 'mcp_servers={}']);
});
