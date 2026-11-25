'use strict';

const { runProject, formatReport } = require('./ladder/project');
const args = process.argv.slice(2);
const [manifest, flag, format = 'text'] = args;
const usage = 'Usage: node server/test-project.js <suite.json> [--format text|json|junit]';

if (manifest === '--help') {
  console.log(usage);
} else if (!manifest || !(args.length === 1 || (args.length === 3 && flag === '--format')) || !['text', 'json', 'junit'].includes(format)) {
  console.error(usage);
  process.exitCode = 2;
} else {
  try {
    const report = runProject(manifest);
    console.log(formatReport(report, format));
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.error('Could not run project: ' + error.message);
    process.exitCode = 2;
  }
}
