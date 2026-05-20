#!/usr/bin/env tsx
/**
 * Post a reply to an Azure DevOps PR thread.
 * Reply text is read from stdin.
 *
 * Usage:
 *   echo "My reply" | tsx reply-pr-comment.ts --pr <prId> --thread <threadId>
 */

import { execSync } from 'child_process';

function run(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function getArg(args: string[], flag: string): string {
  const idx = args.indexOf(flag);
  if (idx === -1 || !args[idx + 1]) throw new Error(`Missing ${flag}`);
  return args[idx + 1];
}

function getToken(): string {
  return run(
    'az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv'
  );
}

function extractOrg(remoteUrl: string): string {
  const devAzureMatch = remoteUrl.match(/dev\.azure\.com\/([^/]+)/);
  if (devAzureMatch) return devAzureMatch[1];
  try {
    const config = run('az devops configure --list');
    const orgMatch = config.match(/organization\s*=\s*https?:\/\/dev\.azure\.com\/([^/\s]+)/);
    if (orgMatch) return orgMatch[1];
  } catch {}
  return 'dev-hoffmann-group-digital';
}

const args = process.argv.slice(2);
const prId = parseInt(getArg(args, '--pr'), 10);
const threadId = parseInt(getArg(args, '--thread'), 10);

// Read reply text from stdin
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) {
  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
}
const replyText = Buffer.concat(chunks).toString('utf8').trim();
if (!replyText) {
  console.error('reply text is empty (pass via stdin)');
  process.exit(1);
}

const metaRaw = run(`az repos pr show --id ${prId} --output json`);
const meta = JSON.parse(metaRaw) as {
  repository: { id: string; project: { name: string }; remoteUrl: string };
};

const org = extractOrg(meta.repository.remoteUrl ?? '');
const project = meta.repository.project.name;
const repoId = meta.repository.id;
const token = getToken();

const url = `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/pullRequests/${prId}/threads/${threadId}/comments?api-version=7.1`;

const res = await fetch(url, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ content: replyText, commentType: 1 }),
});

if (!res.ok) {
  const body = await res.text();
  console.error(`Azure DevOps API ${res.status}: ${body.slice(0, 300)}`);
  process.exit(1);
}

const data = await res.json() as { id: number };
console.log(JSON.stringify({ success: true, commentId: data.id }));
