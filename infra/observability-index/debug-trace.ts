import { loadConfig } from './src/config.js';
import { scanFiles } from './src/scanner.js';
import { extractAll } from './src/extractor.js';

const config = loadConfig('/Users/nhat.tran/Work/worktrees/Calibration/Core');
const files = await scanFiles('/Users/nhat.tran/Work/worktrees/Calibration/Core', config, false);
const rawMatches = await extractAll('/Users/nhat.tran/Work/worktrees/Calibration/Core', files, config, false);
const traceMatches = rawMatches.filter((m) => m.pattern.category === 'trace');
console.log('Total trace matches:', traceMatches.length);
const byPattern = traceMatches.reduce((acc: Record<string, number>, m) => {
  acc[m.pattern.name] = (acc[m.pattern.name] ?? 0) + 1;
  return acc;
}, {});
console.log('By pattern:', JSON.stringify(byPattern, null, 2));
const ria = traceMatches.filter((m) => m.pattern.name === 'RunInEventPublishingSpan');
console.log('RunInEventPublishingSpan samples:', JSON.stringify(ria.slice(0, 3).map((m) => ({file: m.file, line: m.line, rawMatch: m.rawMatch.substring(0, 80)})), null, 2));
