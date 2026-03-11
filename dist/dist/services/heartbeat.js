import { EventEmitter } from 'events';
import { logger } from '../lib/logger.js';
export class HeartbeatService extends EventEmitter {
    nodeId;
    orchestratorUrl;
    monitor;
    limitManager;
    interval = null;
    heartbeatIntervalMs;
    isRunning = false;
    apiPort;
    accessToken;
    constructor(nodeId, orchestratorUrl, monitor, limitManager, intervalSeconds = 60, apiPort = 4002, accessToken = '') {
        super();
        this.nodeId = nodeId;
        this.orchestratorUrl = orchestratorUrl;
        this.monitor = monitor;
        this.limitManager = limitManager;
        this.heartbeatIntervalMs = intervalSeconds * 1000;
        this.apiPort = apiPort;
        this.accessToken = accessToken;
    }
    async start() {
        if (this.isRunning) {
            logger.warn('heartbeat service already running');
            return;
        }
        this.isRunning = true;
        // send initial heartbeat immediately
        await this.sendHeartbeat();
        // then send periodic heartbeats
        this.interval = setInterval(async () => {
            await this.sendHeartbeat();
        }, this.heartbeatIntervalMs);
        logger.info({ intervalSeconds: this.heartbeatIntervalMs / 1000 }, 'heartbeat service started');
    }
    async stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        this.isRunning = false;
        logger.info('heartbeat service stopped');
    }
    async sendHeartbeat() {
        if (!this.isRunning)
            return;
        try {
            // get system resources
            const systemResources = await this.monitor.getAvailableResources();
            const availableLimits = this.limitManager.getAvailableResources();
            // send provider limits, not system resources
            const resources = {
                cpu: {
                    cores: this.limitManager.getLimits().cpu,
                    available: availableLimits.cpu
                },
                memory: {
                    total: this.limitManager.getLimits().memory,
                    available: availableLimits.memory
                },
                disk: systemResources.disk,
                network: systemResources.network,
                gpu: systemResources.gpu || []
            };
            // send heartbeat to orchestrator
            const response = await fetch(`${this.orchestratorUrl}/api/v1/nodes/${this.nodeId}/heartbeat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    resources,
                    apiPort: this.apiPort,
                    accessToken: this.accessToken,
                }),
            });
            if (response.ok) {
                const data = await response.json();
                logger.debug({
                    nodeId: this.nodeId,
                    cpu: resources.cpu.available,
                    memory: resources.memory.available,
                }, 'heartbeat sent successfully');
                this.emit('heartbeat-success', { resources, timestamp: data.timestamp || Date.now() });
                // check if orchestrator sent pending jobs
                if (data.pendingJobs && data.pendingJobs.length > 0) {
                    logger.info({ count: data.pendingJobs.length }, 'received pending jobs from heartbeat');
                    this.emit('pending-jobs', data.pendingJobs);
                }
            }
            else {
                const error = await response.text();
                logger.warn({ status: response.status, error }, 'heartbeat request failed');
                this.emit('heartbeat-error', { status: response.status, error });
            }
        }
        catch (err) {
            logger.error({ err }, 'failed to send heartbeat');
            this.emit('heartbeat-error', { error: err });
        }
    }
    // manually trigger a heartbeat
    async triggerHeartbeat() {
        await this.sendHeartbeat();
    }
    isActive() {
        return this.isRunning;
    }
}
