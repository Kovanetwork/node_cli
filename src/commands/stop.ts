import { logger } from '../lib/logger.js';
import { stateManager } from '../lib/state.js';

export async function stopCommand() {
  logger.info('stopping kova node...');

  const state = stateManager.getState();

  if (!state.isRunning || !state.pid) {
    console.log('node is not running');
    return;
  }

  try {
    // send sigterm for graceful shutdown
    process.kill(state.pid, 'SIGTERM');
    console.log(`sent stop signal to node (pid: ${state.pid})`);
    console.log('node will finish current work and shut down gracefully');

    // update state
    stateManager.setStopped();
  } catch (err: any) {
    if (err.code === 'ESRCH') {
      // process doesn't exist, clean up state
      console.log('node process not found, cleaning up state');
      stateManager.setStopped();
    } else {
      console.error(`failed to stop node: ${err.message}`);
    }
  }
}