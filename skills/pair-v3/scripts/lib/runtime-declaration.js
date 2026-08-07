// How a repository starts its program, declared once. A Review Slice's `probe` says what to ask the
// running program; this file says how to get one running, because that answer belongs to the repository
// and changes almost never while the question changes every slice.
//
// The declaration owns detachment. `up` must return once the program is starting — `docker compose up -d`,
// a launcher that backgrounds the host — because the engine runs it with spawnSync and never holds a
// process handle. That is deliberate: `pair-loop run` returns to the shell between slices, so a handle
// held in memory could not survive to the next slice anyway, and a recorded PID would make the engine the
// owner of a process it has no teardown for yet. `ready` is the whole truth about whether the program is up.
const fs = require('node:fs');
const path = require('node:path');

const RUNTIME_DECLARATION_KEYS = new Set(['up', 'ready', 'down', 'env']);
const RUNTIME_COMMAND_FIELDS = ['up', 'ready', 'down'];
const MAX_COMMAND_LENGTH = 1000;

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Every rejection names the field. A declaration is hand-written and read back under time pressure, so
// "runtime declaration is invalid" costs the author a bisect they should not have to run.
function validateCommand(value, field) {
  if (typeof value !== 'string') throw new Error(`runtime declaration field ${field} must be a string command`);
  const command = value.trim();
  if (!command || command.length > MAX_COMMAND_LENGTH || /[\r\n\0]/u.test(command)) {
    throw new Error(`runtime declaration field ${field} must be one command using 1-${MAX_COMMAND_LENGTH} characters`);
  }
  return command;
}

function validateRuntimeDeclaration(value) {
  if (!plainObject(value)) throw new Error('runtime declaration must be one JSON object');
  const unknown = Object.keys(value).filter(key => !RUNTIME_DECLARATION_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`runtime declaration has unsupported fields: ${unknown.join(', ')}`);
  const declaration = {};
  for (const field of RUNTIME_COMMAND_FIELDS) declaration[field] = validateCommand(value[field], field);
  if (!plainObject(value.env)) throw new Error('runtime declaration field env must be an object of environment names to string values');
  // Names where credentials come from; never the credentials themselves. Nothing here is ever persisted or
  // narrated — the engine passes the map straight into the child environment and keeps no copy.
  for (const [name, entry] of Object.entries(value.env)) {
    if (typeof entry !== 'string') throw new Error(`runtime declaration field env.${name} must be a string`);
  }
  declaration.env = { ...value.env };
  return declaration;
}

function runtimeDeclarationPath(root) {
  return path.join(root, '.pair', 'runtime.json');
}

// Absent is a valid answer, and the common one: a repository with no declaration runs exactly as it did
// before runtime observation existed.
function loadRuntimeDeclaration(root) {
  const file = runtimeDeclarationPath(root);
  if (!fs.existsSync(file)) return null;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`${file} is not valid JSON`); }
  return validateRuntimeDeclaration(parsed);
}

module.exports = {
  loadRuntimeDeclaration,
  runtimeDeclarationPath,
  validateRuntimeDeclaration,
};
