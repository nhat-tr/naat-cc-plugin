const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '../../..');

const expectedInventory = [
  { name: '@axe-core/playwright', version: '4.12.1', license: 'MPL-2.0' },
  { name: '@modelcontextprotocol/sdk', version: '1.29.0', license: 'MIT' },
  { name: '@playwright/test', version: '1.61.1', license: 'Apache-2.0' },
  { name: '@types/react', version: '19.2.17', license: 'MIT' },
  { name: '@types/react-dom', version: '19.2.3', license: 'MIT' },
  { name: '@xyflow/react', version: '12.11.2', license: 'MIT' },
  { name: 'ajv', version: '8.20.0', license: 'MIT' },
  { name: 'elkjs', version: '0.11.1', license: 'EPL-2.0' },
  { name: 'esbuild', version: '0.28.1', license: 'MIT' },
  { name: 'lucide-react', version: '1.24.0', license: 'ISC' },
  { name: 'react', version: '19.2.7', license: 'MIT' },
  { name: 'react-dom', version: '19.2.7', license: 'MIT' },
  { name: 'typescript', version: '7.0.2', license: 'Apache-2.0' },
];

function packageManifest(name) {
  return JSON.parse(fs.readFileSync(
    path.join(repositoryRoot, 'node_modules', ...name.split('/'), 'package.json'),
    'utf8',
  ));
}

function noticeInventory(source) {
  return source
    .split(/\r?\n/u)
    .filter(line => /^\| `[^`]+` \|/u.test(line))
    .map(line => {
      const [packageName, version, license] = line
        .split('|')
        .slice(1, 4)
        .map(value => value.trim().replace(/^`|`$/gu, ''));
      return { name: packageName, version, license };
    });
}

test('third-party notices record every directly pinned dependency and its SPDX license', () => {
  const notices = fs.readFileSync(path.join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  const actual = noticeInventory(notices);
  const byName = (left, right) => left.name.localeCompare(right.name);

  assert.equal(new Set(actual.map(item => item.name)).size, actual.length, 'notice packages must be unique');
  assert.deepEqual(actual.toSorted(byName), expectedInventory.toSorted(byName));
});

test('notice versions and licenses agree with installed package and lockfile metadata', () => {
  const lockfile = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8'));

  for (const expected of expectedInventory) {
    const installed = packageManifest(expected.name);
    assert.equal(installed.version, expected.version, `${expected.name} installed version`);
    assert.equal(installed.license, expected.license, `${expected.name} installed license`);

    const locked = lockfile.packages[`node_modules/${expected.name}`];
    assert.ok(locked, `${expected.name} must have direct lockfile metadata`);
    assert.equal(locked.version, expected.version, `${expected.name} locked version`);
    assert.equal(locked.license, expected.license, `${expected.name} locked license`);
  }
});
