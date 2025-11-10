import { logger } from '../lib/logger.js';
import { ResourceMonitor } from '../lib/monitor.js';
import { stateManager } from '../lib/state.js';

export async function statusCommand() {
  try {
    const state = stateManager.getState();

    const monitor = new ResourceMonitor();
    await monitor.start();

    const resources = await monitor.getAvailableResources();

    console.log('\n📊 kova node status\n');

    // node running status
    if (state.isRunning) {
      const uptime = stateManager.getUptime();
      const hours = Math.floor(uptime / 1000 / 60 / 60);
      const minutes = Math.floor((uptime / 1000 / 60) % 60);
      console.log(`node status: 🟢 online (${hours}h ${minutes}m uptime)`);
      console.log(`pid: ${state.pid}`);
    } else {
      console.log('node status: 🔴 offline');
    }

    console.log('');

    // resources
    console.log(`cpu: ${resources.cpu.available.toFixed(1)} / ${resources.cpu.cores} cores available`);
    console.log(`memory: ${resources.memory.available} / ${resources.memory.total} GB available`);
    console.log(`network: ~${resources.network.bandwidth} Mbps`);

    // check docker
    const Docker = (await import('dockerode')).default;
    const docker = new Docker();
    try {
      await docker.ping();
      console.log('docker: ✅ running');
    } catch {
      console.log('docker: ❌ not running');
    }

    // earnings summary
    if (state.isRunning) {
      console.log('');
      console.log(`jobs completed: ${state.jobsCompleted}`);
      console.log(`total earned: $${state.totalEarnings.toFixed(4)}`);
    }

    console.log('');

    await monitor.stop();
  } catch (err) {
    logger.error({ err }, 'status check failed');
    process.exit(1);
  }
}