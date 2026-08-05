const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { withVerificationLease, workPaths } = require('../scripts/lib/pair-store');

// The verification lease is keyed per Work, so two different Works could verify at the same moment. Their
// suites are not independent: they share this machine's Testcontainers Postgres, its ports and its
// databases, so each run fails somewhere unrelated to its own change. Those failures cannot honestly be
// baselined and cannot be told apart from real ones — this is the mechanism that fabricated the disjoint
// 1/71/2 failures on S-01. The per-Work lease cannot see it, because the collision is not per Work.
function fixture(t) {
  const scratch = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const parent = path.join(scratch, 'my-claude-code', 'pair-machine-lease-tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'machine-'));
  for (const args of [['init', '-q'], ['config', 'user.email', 'pair@test'], ['config', 'user.name', 'Pair Test']]) {
    childProcess.execFileSync('git', args, { cwd: root });
  }
  fs.writeFileSync(path.join(root, 'value.js'), 'module.exports = 1;\n');
  childProcess.execFileSync('git', ['add', '.'], { cwd: root });
  childProcess.execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  // Machine scope is a real path outside every repository, so the tests must own their own rather than
  // touch the developer's.
  const machine = path.join(root, 'machine-lease');
  const previous = process.env.PAIR_MACHINE_LEASE_DIR;
  process.env.PAIR_MACHINE_LEASE_DIR = machine;
  t.after(() => {
    if (previous === undefined) delete process.env.PAIR_MACHINE_LEASE_DIR;
    else process.env.PAIR_MACHINE_LEASE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, machine };
}

test('a second Work cannot verify while another Work holds the machine', t => {
  const { root } = fixture(t);
  let inner = null;

  withVerificationLease(root, 'work-one', { review_slice_id: 'S1' }, () => {
    inner = (() => {
      try {
        withVerificationLease(root, 'work-two', { review_slice_id: 'S1' }, () => 'ran');
        return null;
      } catch (error) {
        return error.message;
      }
    })();
    return 'ran';
  });

  assert.ok(inner, 'the second Work is refused rather than allowed to collide');
  assert.match(inner, /work-one/u, 'the holder is named, since the human has to decide which run to wait for');
  assert.match(inner, /container|port|database/iu, 'and why sharing is not safe');
});

test('the same Work still verifies twice in sequence, because the lease is released', t => {
  const { root } = fixture(t);

  const first = withVerificationLease(root, 'work-one', {}, () => 'first');
  const second = withVerificationLease(root, 'work-one', {}, () => 'second');

  assert.equal(first, 'first');
  assert.equal(second, 'second', 'a lease that outlives its holder would wedge every later run');
});

// Both refusals would be correct for a second run of the SAME Work, but only one of them tells the human
// which run to go look at. The machine lease therefore defers to the per-Work lease rather than shadowing
// it with a message about sharing containers.
test('a second run of the same Work is refused by the per-Work lease, not the machine one', t => {
  const { root, machine } = fixture(t);
  let inner = null;

  withVerificationLease(root, 'work-one', {}, () => {
    try {
      withVerificationLease(root, 'work-one', {}, () => 'ran');
      inner = 'concurrent verification was allowed';
    } catch (error) { inner = error.message; }
    return 'ran';
  });

  assert.match(inner, /a verification of work-one has been running/u, 'the precise refusal wins');
  assert.doesNotMatch(inner, /on this machine/u, 'the machine-scope wording would answer a question nobody asked');
  assert.equal(fs.existsSync(machine), false, 'and deferring never releases a lease it did not take');
});

test('a machine lease abandoned by a killed process is reclaimed, not honoured forever', t => {
  const { root, machine } = fixture(t);
  const dead = childProcess.spawnSync('true', [], { encoding: 'utf8' }).pid;
  fs.mkdirSync(machine, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(machine, 'owner.json'), `${JSON.stringify({ pid: dead, nonce: 'stale', work_id: 'work-gone', at: new Date().toISOString() })}\n`);

  const result = withVerificationLease(root, 'work-one', {}, () => 'ran');

  assert.equal(result, 'ran', 'a crashed verification must not stop the machine permanently');
  assert.equal(fs.existsSync(machine), false, 'and the reclaimed lease is released on the way out');
});

test('both leases are released even when the verification throws', t => {
  const { root, machine } = fixture(t);

  assert.throws(() => withVerificationLease(root, 'work-one', {}, () => { throw new Error('suite failed'); }), /suite failed/u);

  assert.equal(fs.existsSync(machine), false, 'the machine lease does not survive a failed suite');
  assert.equal(fs.existsSync(workPaths(root, 'work-one').verificationLease), false, 'nor does the per-Work one');
});
