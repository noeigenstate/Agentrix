const echoStartup = require('./stand-in-echo.cjs');

const argv = process.argv.slice(2);
echoStartup(argv);
if (argv.includes('--version')) process.stdout.write('Terminal Example 1.2.3\n');
else if (argv.includes('--interactive')) process.stdout.write('example> \n');
