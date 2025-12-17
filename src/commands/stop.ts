// stop command - gracefully stops a running kova node

import { logger } from '../lib/logger.js';
import { stateManager } from '../lib/state.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// check if a process is running
function isProcessRunning(pid: number): boolean {
  try {
    // sending signal 0 doesn't actually send a signal, just checks if process exists
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // process doesn't exist or we don't have permission
    return err.code === 'EPERM';
  }
}

// wait for a process to terminate with timeout
async function waitForProcessExit(pid: number, timeoutMs: number = 30000): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return false;
}

export async function stopCommand() {
  logger.info('stopping kova node...');

  // check if node is running by reading state
  const state = stateManager.getState();

  if (!state.isRunning || !state.pid) {
    console.log('\nkova node is not running');
    return;
  }

  const pid = state.pid;

  // verify the process is actually running
  if (!isProcessRunning(pid)) {
    console.log('\nkova node is not running (stale state)');
    stateManager.setStopped();
    return;
  }

  console.log(`\nfound kova node running with pid ${pid}`);
  console.log('sending graceful shutdown signal...');

  try {
    // send SIGINT for graceful shutdown (same as ctrl+c)
    process.kill(pid, 'SIGINT');

    console.log('waiting for node to stop...');

    // wait up to 30 seconds for graceful shutdown
    const stopped = await waitForProcessExit(pid, 30000);

    if (stopped) {
      console.log('\n✓ kova node stopped successfully');

      // show final stats
      const finalState = stateManager.getState();
      console.log(`\nfinal stats:`);
      console.log(`  jobs completed: ${finalState.jobsCompleted}`);
      console.log(`  jobs failed: ${finalState.jobsFailed}`);
      console.log(`  total earnings: ${finalState.totalEarnings.toFixed(4)}`);
      console.log(`  active deployments: ${finalState.activeDeployments.length}`);

      if (finalState.activeDeployments.length > 0) {
        console.log('\nwarning: there were active deployments when node stopped');
        console.log('these will be picked up again when node restarts');
      }
    } else {
      // graceful shutdown timed out, try harder
      console.log('\ngraceful shutdown timed out, forcing termination...');

      try {
        process.kill(pid, 'SIGTERM');

        // wait another 10 seconds
        const forceStopped = await waitForProcessExit(pid, 10000);

        if (forceStopped) {
          console.log('✓ node terminated');
        } else {
          // last resort
          console.log('sending SIGKILL...');
          process.kill(pid, 'SIGKILL');
          await waitForProcessExit(pid, 5000);
          console.log('✓ node killed');
        }
      } catch (err) {
        console.error('failed to terminate process');
      }

      // update state regardless
      stateManager.setStopped();
    }

  } catch (err: any) {
    if (err.code === 'ESRCH') {
      console.log('\nkova node already stopped');
      stateManager.setStopped();
    } else if (err.code === 'EPERM') {
      console.error('\n❌ permission denied - try running with sudo');
    } else {
      console.error(`\n❌ failed to stop node: ${err.message}`);
    }
  }
}
