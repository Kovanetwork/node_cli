import { stateManager } from '../lib/state.js';

export async function earningsCommand() {
  const state = stateManager.getState();

  console.log('\n💰 kova earnings\n');
  console.log(`total earned: $${state.totalEarnings.toFixed(4)}`);
  console.log(`jobs completed: ${state.jobsCompleted}`);
  console.log(`jobs failed: ${state.jobsFailed}`);

  if (state.totalEarnings > 0) {
    const avgPerJob = state.totalEarnings / state.jobsCompleted;
    console.log(`average per job: $${avgPerJob.toFixed(4)}`);
  }

  console.log('\nnote: earnings are tracked in-memory and reset on restart');
  console.log('full accounting coming soon\n');
}