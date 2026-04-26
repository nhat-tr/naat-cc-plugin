#!/usr/bin/env tsx
/**
 * Fetches all comment threads from an Azure DevOps PR.
 * Outputs JSON to stdout (default) or formatted text with --format text.
 *
 * Sonar/bot threads (author matching /sonar/i on displayName or uniqueName) are
 * hidden by default and reported only as a count. Use --include-sonar to merge
 * them in, or --only-sonar to fetch just those threads.
 *
 * Usage:
 *   tsx fetch-pr-comments.ts <PR_ID>
 *   tsx fetch-pr-comments.ts <PR_ID> --format text
 *   tsx fetch-pr-comments.ts --detect              # auto-detect PR from current branch
 *   tsx fetch-pr-comments.ts --detect --include-sonar
 *   tsx fetch-pr-comments.ts --detect --only-sonar
 */

import { execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AzurePrMetadata {
  codeReviewId: number;
  title: string;
  sourceRefName: string;
  repository: {
    id: string;
    name: string;
    project: { name: string };
    remoteUrl: string;
  };
}

interface ThreadComment {
  id: number;
  content: string;
  commentType: string;
  publishedDate: string;
  author: { displayName: string; uniqueName: string };
}

interface PrThread {
  id: number;
  status: string;
  threadContext: {
    filePath?: string;
    rightFileStart?: { line: number; offset: number };
  } | null;
  comments: ThreadComment[];
}

interface ReviewThread {
  threadId: number;
  status: string;
  filePath: string | null;
  line: number | null;
  isBot: boolean;
  comments: Array<{ author: string; content: string; date: string }>;
}

type FilterMode = 'default' | 'include-sonar' | 'only-sonar';

interface FetchResult {
  prId: number;
  title: string;
  branch: string;
  org: string;
  project: string;
  repoId: string;
  repoName: string;
  mode: FilterMode;
  activeThreads: ReviewThread[];
  resolvedThreads: ReviewThread[];
  hidden: { sonarActive: number; sonarResolved: number };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function isSonarAuthor(a: { displayName?: string; uniqueName?: string }): boolean {
  return /sonar/i.test(a.displayName ?? '') || /sonar/i.test(a.uniqueName ?? '');
}

function detectPrFromBranch(): number {
  const branch = run('git branch --show-current');
  const raw = run(`az repos pr list --source-branch "${branch}" --status active --output json`);
  const prs = JSON.parse(raw) as Array<{ codeReviewId: number }>;
  if (!prs.length) throw new Error(`No active PR found for branch: ${branch}`);
  return prs[0].codeReviewId;
}

function extractOrg(meta: AzurePrMetadata): string {
  const remoteUrl = meta.repository.remoteUrl ?? '';
  const devAzureMatch = remoteUrl.match(/dev\.azure\.com\/([^/]+)/);
  if (devAzureMatch) return devAzureMatch[1];

  try {
    const config = run('az devops configure --list');
    const orgMatch = config.match(/organization\s*=\s*https?:\/\/dev\.azure\.com\/([^/\s]+)/);
    if (orgMatch) return orgMatch[1];
  } catch {}

  const gitRemote = run('git remote get-url origin 2>/dev/null || echo ""');
  const gitMatch = gitRemote.match(/dev\.azure\.com\/([^/]+)/);
  if (gitMatch) return gitMatch[1];

  // Fallback: known org for this project
  return 'dev-hoffmann-group-digital';
}

function getToken(): string {
  return run(
    'az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv'
  );
}

async function fetchThreads(
  org: string,
  project: string,
  repoId: string,
  prId: number,
  token: string
): Promise<PrThread[]> {
  const url = `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/pullRequests/${prId}/threads?api-version=7.1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Azure DevOps API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json() as { value: PrThread[] };
  return data.value ?? [];
}

function mapThread(thread: PrThread): ReviewThread {
  const userComments = thread.comments.filter(
    c => c.commentType !== 'system' && c.content?.trim()
  );
  const firstAuthor = userComments[0]?.author;
  const isBot = firstAuthor ? isSonarAuthor(firstAuthor) : false;
  return {
    threadId: thread.id,
    status: thread.status,
    filePath: thread.threadContext?.filePath ?? null,
    line: thread.threadContext?.rightFileStart?.line ?? null,
    isBot,
    comments: userComments.map(c => ({
      author: c.author.displayName,
      content: c.content.trim(),
      date: c.publishedDate.slice(0, 10),
    })),
  };
}

function activeHeader(result: FetchResult): string {
  const n = result.activeThreads.length;
  if (result.mode === 'only-sonar') return `=== SONAR ACTIVE THREADS (${n}) ===`;
  if (result.mode === 'include-sonar') {
    const sonar = result.activeThreads.filter(t => t.isBot).length;
    return `=== ACTIVE THREADS (${n} — incl. ${sonar} Sonar) ===`;
  }
  const suffix = result.hidden.sonarActive
    ? ` — ${result.hidden.sonarActive} Sonar hidden (pass --include-sonar or --only-sonar)`
    : '';
  return `=== ACTIVE THREADS (${n}${suffix}) ===`;
}

function resolvedHeader(result: FetchResult): string {
  const n = result.resolvedThreads.length;
  if (result.mode === 'only-sonar') return `=== SONAR RESOLVED THREADS (${n}) — skipped ===`;
  const suffix = result.mode === 'default' && result.hidden.sonarResolved
    ? ` — ${result.hidden.sonarResolved} Sonar hidden`
    : '';
  return `=== RESOLVED THREADS (${n}${suffix}) — skipped ===`;
}

function formatText(result: FetchResult): string {
  const lines: string[] = [
    `PR #${result.prId} — ${result.title}`,
    `Branch: ${result.branch}`,
    `Repo: ${result.repoName} | Project: ${result.project}`,
    `Mode: ${result.mode}`,
    '',
    activeHeader(result),
    '',
  ];
  for (const t of result.activeThreads) {
    const loc = t.filePath ? `${t.filePath}${t.line ? `:${t.line}` : ''}` : 'General';
    const botTag = t.isBot && result.mode !== 'only-sonar' ? ' [SONAR]' : '';
    lines.push(`--- Thread #${t.threadId} [${loc}]${botTag} ---`);
    for (const c of t.comments) {
      lines.push(`  [${c.date}] ${c.author}:`);
      lines.push(`    ${c.content.replace(/\n/g, '\n    ')}`);
      lines.push('');
    }
  }
  if (result.resolvedThreads.length || (result.mode === 'default' && result.hidden.sonarResolved)) {
    lines.push(resolvedHeader(result));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const detectMode = args.includes('--detect');
const format = args.includes('--format') ? args[args.indexOf('--format') + 1] : 'json';
const includeSonar = args.includes('--include-sonar');
const onlySonar = args.includes('--only-sonar');
if (includeSonar && onlySonar) {
  console.error('--include-sonar and --only-sonar are mutually exclusive');
  process.exit(1);
}
const mode: FilterMode = onlySonar ? 'only-sonar' : includeSonar ? 'include-sonar' : 'default';
const rawPrId = args.find(a => /^\d+$/.test(a));

let prId: number;
if (detectMode) {
  prId = detectPrFromBranch();
} else if (rawPrId) {
  prId = parseInt(rawPrId, 10);
} else {
  console.error('Usage: tsx fetch-pr-comments.ts <PR_ID> [--format json|text] [--include-sonar | --only-sonar]');
  console.error('       tsx fetch-pr-comments.ts --detect [--format json|text] [--include-sonar | --only-sonar]');
  process.exit(1);
}

const metaRaw = run(`az repos pr show --id ${prId} --output json`);
const meta = JSON.parse(metaRaw) as AzurePrMetadata;

const org = extractOrg(meta);
const project = meta.repository.project.name;
const repoId = meta.repository.id;
const token = getToken();

const threads = await fetchThreads(org, project, repoId, prId, token);
const mapped = threads.map(mapThread).filter(t => t.comments.length > 0);

const allActive = mapped.filter(t => t.status === 'active');
const allResolved = mapped.filter(t => t.status !== 'active');

let activeThreads: ReviewThread[];
let resolvedThreads: ReviewThread[];
const hidden = { sonarActive: 0, sonarResolved: 0 };

if (mode === 'only-sonar') {
  activeThreads = allActive.filter(t => t.isBot);
  resolvedThreads = allResolved.filter(t => t.isBot);
} else if (mode === 'include-sonar') {
  activeThreads = allActive;
  resolvedThreads = allResolved;
} else {
  activeThreads = allActive.filter(t => !t.isBot);
  resolvedThreads = allResolved.filter(t => !t.isBot);
  hidden.sonarActive = allActive.filter(t => t.isBot).length;
  hidden.sonarResolved = allResolved.filter(t => t.isBot).length;
}

const result: FetchResult = {
  prId,
  title: meta.title,
  branch: meta.sourceRefName.replace('refs/heads/', ''),
  org,
  project,
  repoId,
  repoName: meta.repository.name,
  mode,
  activeThreads,
  resolvedThreads,
  hidden,
};

if (format === 'text') {
  console.log(formatText(result));
} else {
  console.log(JSON.stringify(result, null, 2));
}
