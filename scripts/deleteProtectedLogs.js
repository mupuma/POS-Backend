const readline = require('readline');
const { loadRuntimeEnv } = require('../config/runtimeEnv');
const { deleteProtectedLogs } = require('../services/protectedLogDeletion');

loadRuntimeEnv();

function parseArgs(argv) {
  const options = {};

  for (const arg of argv) {
    if (arg === '--all') {
      options.all = true;
      continue;
    }

    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, value] = match;
    if (key === 'password') options.password = value;
    if (key === 'date') options.date = value;
    if (key === 'category') options.category = value;
    if (key === 'file') options.fileName = value;
  }

  return options;
}

function askHidden(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    const originalWrite = rl._writeToOutput;
    rl._writeToOutput = function writeHidden() {
      rl.output.write('*');
    };

    rl.question(query, (answer) => {
      rl._writeToOutput = originalWrite;
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.password) {
    options.password = await askHidden('Developer password: ');
  }

  const result = deleteProtectedLogs(options);
  console.log(JSON.stringify({
    success: true,
    deletedCount: result.deletedCount,
    deleted: result.deleted,
    logRoot: result.logRoot,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
