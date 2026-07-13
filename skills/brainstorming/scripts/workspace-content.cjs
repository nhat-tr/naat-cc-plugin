'use strict';

const fs = require('node:fs');
const path = require('node:path');

const Ajv2020 = require('ajv/dist/2020').default;

const { normalizeOpaqueWorkspaceContent } = require('./workspace-document.cjs');

const SCHEMA_DIR = path.resolve(__dirname, '../schemas');
const validators = new Map();

function validatorFor(workspaceKind) {
  if (validators.has(workspaceKind)) return validators.get(workspaceKind);
  const schemaFile = path.join(SCHEMA_DIR, `${workspaceKind}-workspace.schema.json`);
  if (!fs.existsSync(schemaFile)) {
    validators.set(workspaceKind, null);
    return null;
  }
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(JSON.parse(fs.readFileSync(schemaFile, 'utf8')));
  const entry = { ajv, validate };
  validators.set(workspaceKind, entry);
  return entry;
}

function normalizeKnownWorkspaceContent(content, context) {
  const normalized = normalizeOpaqueWorkspaceContent(content);
  const entry = validatorFor(context.workspace_kind);
  if (!entry) return normalized;
  if (!entry.validate(normalized)) {
    throw new TypeError(`${context.workspace_kind} Workspace content is invalid: ${entry.ajv.errorsText(entry.validate.errors)}`);
  }
  return normalized;
}

module.exports = {
  normalizeKnownWorkspaceContent,
};
