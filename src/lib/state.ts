// persistent state management for the node
// saves to ~/.kova/node-state.json

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

interface NodeState {
  isRunning: boolean;
  pid?: number;
  startTime?: number;
  totalEarnings: number;
  jobsCompleted: number;
  jobsFailed: number;
  activeDeployments: string[];
}

class StateManager {
  private state: NodeState = {
    isRunning: false,
    totalEarnings: 0,
    jobsCompleted: 0,
    jobsFailed: 0,
    activeDeployments: []
  };
  private statePath: string;
  private saveTimeout: NodeJS.Timeout | null = null;

  constructor() {
    const kovaDir = join(homedir(), '.kova');
    this.statePath = join(kovaDir, 'node-state.json');

    // ensure directory exists
    if (!existsSync(kovaDir)) {
      mkdirSync(kovaDir, { recursive: true });
    }

    // load persisted state
    this.loadState();
  }

  private loadState(): void {
    try {
      if (existsSync(this.statePath)) {
        const data = JSON.parse(readFileSync(this.statePath, 'utf8'));
        // restore persistent fields only (not runtime state like isRunning/pid)
        this.state.totalEarnings = data.totalEarnings || 0;
        this.state.jobsCompleted = data.jobsCompleted || 0;
        this.state.jobsFailed = data.jobsFailed || 0;
        this.state.activeDeployments = data.activeDeployments || [];
      }
    } catch (err) {
      // ignore load errors, start fresh
    }
  }

  private saveState(): void {
    // debounce saves to avoid excessive disk writes
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      try {
        writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
      } catch (err) {
        // ignore save errors
      }
    }, 1000);
  }

  // force immediate save (for shutdown)
  saveNow(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    try {
      writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      // ignore
    }
  }

  setRunning(pid: number) {
    this.state.isRunning = true;
    this.state.pid = pid;
    this.state.startTime = Date.now();
    this.saveState();
  }

  setStopped() {
    this.state.isRunning = false;
    this.state.pid = undefined;
    this.saveNow();
  }

  addEarnings(amount: number) {
    this.state.totalEarnings += amount;
    this.saveState();
  }

  incrementCompleted() {
    this.state.jobsCompleted++;
    this.saveState();
  }

  incrementFailed() {
    this.state.jobsFailed++;
    this.saveState();
  }

  addDeployment(deploymentId: string) {
    if (!this.state.activeDeployments.includes(deploymentId)) {
      this.state.activeDeployments.push(deploymentId);
      this.saveState();
    }
  }

  removeDeployment(deploymentId: string) {
    this.state.activeDeployments = this.state.activeDeployments.filter(id => id !== deploymentId);
    this.saveState();
  }

  getActiveDeployments(): string[] {
    return [...this.state.activeDeployments];
  }

  getState(): NodeState {
    return { ...this.state };
  }

  getUptime(): number {
    if (!this.state.startTime) return 0;
    return Date.now() - this.state.startTime;
  }
}

export const stateManager = new StateManager();
