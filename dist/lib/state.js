// persistent state management for the node
// saves to ~/.kova/node-state.json
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
class StateManager {
    state = {
        isRunning: false,
        totalEarnings: 0,
        jobsCompleted: 0,
        jobsFailed: 0,
        activeDeployments: []
    };
    statePath;
    saveTimeout = null;
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
    loadState() {
        try {
            if (existsSync(this.statePath)) {
                const data = JSON.parse(readFileSync(this.statePath, 'utf8'));
                // restore persistent fields only (not runtime state like isRunning/pid)
                this.state.totalEarnings = data.totalEarnings || 0;
                this.state.jobsCompleted = data.jobsCompleted || 0;
                this.state.jobsFailed = data.jobsFailed || 0;
                this.state.activeDeployments = data.activeDeployments || [];
            }
        }
        catch (err) {
            // ignore load errors, start fresh
        }
    }
    saveState() {
        // debounce saves to avoid excessive disk writes
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
        this.saveTimeout = setTimeout(() => {
            try {
                writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
            }
            catch (err) {
                // ignore save errors
            }
        }, 1000);
    }
    // force immediate save (for shutdown)
    saveNow() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }
        try {
            writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
        }
        catch (err) {
            // ignore
        }
    }
    setRunning(pid) {
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
    addEarnings(amount) {
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
    addDeployment(deploymentId) {
        if (!this.state.activeDeployments.includes(deploymentId)) {
            this.state.activeDeployments.push(deploymentId);
            this.saveState();
        }
    }
    removeDeployment(deploymentId) {
        this.state.activeDeployments = this.state.activeDeployments.filter(id => id !== deploymentId);
        this.saveState();
    }
    getActiveDeployments() {
        return [...this.state.activeDeployments];
    }
    getState() {
        return { ...this.state };
    }
    getUptime() {
        if (!this.state.startTime)
            return 0;
        return Date.now() - this.state.startTime;
    }
}
export const stateManager = new StateManager();
