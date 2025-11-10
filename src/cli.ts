import { Command } from 'commander';
import { startNode } from './commands/start.js';
import { statusCommand } from './commands/status.js';
import { stopCommand } from './commands/stop.js';
import { earningsCommand } from './commands/earnings.js';
import pino from 'pino';

// eh whatever logger setup
const logger = pino({
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: { colorize: true }
  } : undefined
});

const program = new Command();

program
  .name('kova-node')
  .description('decentralized compute node - earn by sharing resources')
  .version('0.0.1');

program
  .command('start')
  .description('start earning with your spare compute')
  .requiredOption('-w, --wallet <address>', 'your ethereum wallet address')
  .option('-p, --port <number>', 'p2p port', '4001')
  .option('-c, --config <path>', 'config file path')
  .option('--max-cpu <cores>', 'maximum CPU cores to allocate (default: all available)')
  .option('--max-memory <gb>', 'maximum memory in GB to allocate (default: 80% of total)')
  .option('--max-disk <gb>', 'maximum disk space in GB to allocate (default: 100GB)')
  .option('-v, --verbose', 'show me everything')
  .action(startNode);

program
  .command('status')
  .description('check how things are going')
  .action(statusCommand);

program
  .command('stop')
  .description('stop the node gracefully')
  .action(stopCommand);

program
  .command('earnings')
  .description('see how much youve made')
  .action(earningsCommand);

// lets gooo
program.parse(process.argv);