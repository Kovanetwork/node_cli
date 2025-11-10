// simple in-memory state management for the node
// in production this would be redis or db

interface NodeState {
  isRunning: boolean;
  pid?: number;
  startTime?: number;
  totalEarnings: number;
  jobsCompleted: number;
  jobsFailed: number;
}

class StateManager {
  private state: NodeState = {
    isRunning: false,
    totalEarnings: 0,
    jobsCompleted: 0,
    jobsFailed: 0
  };

  setRunning(pid: number) {
    this.state.isRunning = true;
    this.state.pid = pid;
    this.state.startTime = Date.now();
  }

  setStopped() {
    this.state.isRunning = false;
    this.state.pid = undefined;
  }

  addEarnings(amount: number) {
    this.state.totalEarnings += amount;
  }

  incrementCompleted() {
    this.state.jobsCompleted++;
  }

  incrementFailed() {
    this.state.jobsFailed++;
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
