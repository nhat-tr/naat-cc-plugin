import { loadConfig } from './src/config.js';
import { scanFiles } from './src/scanner.js';
import { extractAll } from './src/extractor.js';

const config = loadConfig('/Users/nhat.tran/Work/worktrees/Calibration/Core');
const files = await scanFiles('/Users/nhat.tran/Work/worktrees/Calibration/Core', config, false);
const rawMatches = await extractAll('/Users/nhat.tran/Work/worktrees/Calibration/Core', files, config, false);

// Look for GraphQL matches
const graphqlMatches = rawMatches.filter((m) => m.pattern.name === 'RunGraphQLRequestInActivity');
console.log('RunGraphQLRequestInActivity matches:', graphqlMatches.length);

// Test the pattern manually against a known line
const testLine = '            .RunGraphQLRequestInActivity(';
const pattern = config.patterns.find(p => p.name === 'RunGraphQLRequestInActivity');
console.log('Pattern:', pattern?.regex);
const re = new RegExp(pattern!.regex);
const m = re.exec(testLine);
console.log('Test match:', m ? m[0].substring(0, 80) : 'no match');

// Try against the full line
const testLine2 = '        await _activitySourceProvider.GetActivitySource().RunGraphQLRequestInActivity(fullOperationName, request, async () => ...)';
const m2 = re.exec(testLine2);
console.log('Test match 2:', m2 ? m2[0].substring(0, 80) : 'no match');
