import { stateManager } from '../lib/state.js';
import { NodeConfig } from '../lib/config.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

interface BackendEarnings {
  providerId: string;
  walletAddress?: string;
  totalEarned: number;
  totalStreamed: number;
  withdrawableBalance: number;
  activeLeases: number;
  totalLeases: number;
}

// try to fetch earnings from orchestrator api
async function fetchBackendEarnings(): Promise<BackendEarnings | null> {
  try {
    // get api key from credentials file
    const credPath = join(homedir(), '.kova', 'credentials.json');
    if (!existsSync(credPath)) {
      return null;
    }

    const creds = JSON.parse(readFileSync(credPath, 'utf8'));
    if (!creds.apiKey) {
      return null;
    }

    // load config
    await NodeConfig.load();
    const orchestratorUrl = NodeConfig.get('orchestratorUrl') || 'http://localhost:3000';

    // fetch earnings from orchestrator
    const response = await fetch(`${orchestratorUrl}/api/v1/provider/earnings`, {
      headers: {
        'Authorization': `Bearer ${creds.apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      return null;
    }

    return await response.json() as BackendEarnings;
  } catch (err) {
    // silently fail if can't reach backend
    return null;
  }
}

export async function earningsCommand() {
  const state = stateManager.getState();

  console.log('\n kova earnings\n');

  // try to fetch backend earnings
  const backendEarnings = await fetchBackendEarnings();

  if (backendEarnings) {
    console.log('--- backend (authoritative) ---');
    console.log(`total earned: $${backendEarnings.totalEarned.toFixed(4)}`);
    console.log(`total streamed: $${backendEarnings.totalStreamed.toFixed(4)}`);
    console.log(`withdrawable balance: $${backendEarnings.withdrawableBalance.toFixed(4)}`);
    console.log(`active leases: ${backendEarnings.activeLeases}`);
    console.log(`total leases: ${backendEarnings.totalLeases}`);
    if (backendEarnings.walletAddress) {
      console.log(`wallet: ${backendEarnings.walletAddress}`);
    }
    console.log('');
  }

  console.log('--- local stats ---');
  console.log(`jobs completed: ${state.jobsCompleted}`);
  console.log(`jobs failed: ${state.jobsFailed}`);
  console.log(`local earnings cache: $${state.totalEarnings.toFixed(4)}`);

  if (state.jobsCompleted > 0) {
    const avgPerJob = state.totalEarnings / state.jobsCompleted;
    console.log(`average per job: $${avgPerJob.toFixed(4)}`);
  }

  if (!backendEarnings) {
    console.log('\nnote: could not reach orchestrator. showing local stats only.');
    console.log('connect with an api key to see full earnings from backend.\n');
  } else {
    console.log('\nwithdraw earnings via dashboard or "kova withdraw"\n');
  }
}