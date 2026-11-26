'use strict';

const { parseArgs } = require('node:util');
const { runProject, formatReport } = require('./ladder/project');

const usage = 'Usage: node server/test-project.js <suite.json> [--baseline <xml-dir>] [--format text|json|junit]';
const args = process.argv.slice(2);

if (args.length === 1 && args[0] === '--help') {
  console.log(usage);
} else {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: { format: { type: 'string', default: 'text' }, baseline: { type: 'string' } },
      tokens: true,
    });
    const { positionals, values, tokens } = parsed;
    const options = tokens.filter(token => token.kind === 'option');
    if (positionals.length !== 1 || !['text', 'json', 'junit'].includes(values.format) ||
        new Set(options.map(token => token.name)).size !== options.length) {
      throw new Error('Expected one suite file, one optional baseline and one optional format');
    }
  } catch (error) {
    console.error(error.message + '\n' + usage);
    process.exitCode = 2;
  }
  if (!process.exitCode) {
    try {
      const report = runProject(parsed.positionals[0], { baselineBlockDir: parsed.values.baseline });
      console.log(formatReport(report, parsed.values.format));
      process.exitCode = report.ok ? 0 : 1;
    } catch (error) {
      console.error('Could not run project: ' + error.message);
      process.exitCode = 2;
    }
  }
}
