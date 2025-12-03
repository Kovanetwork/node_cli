import { EventEmitter } from 'events';
import { logger } from '../lib/logger.js';
import { ResourceMonitor } from '../lib/monitor.js';
import { ResourceLimitManager } from '../lib/resource-limits.js';

export class HeartbeatService extends EventEmitter {
  private nodeId: string;
  private orchestratorUrl: string;
  private monitor: ResourceMonitor;
  private limitManager: ResourceLimitManager;
  private interval: NodeJS.Timeout | null = null;
  private heartbeatIntervalMs: number;
  private isRunning: boolean = false;

  constructor(
    nodeId: string,
    orchestratorUrl: string,
    monitor: ResourceMonitor,
    limitManager: ResourceLimitManager,
    intervalSeconds: number = 60
  ) {
    super();
    this.nodeId = nodeId;
    this.orchestratorUrl = orchestratorUrl;
    this.monitor = monitor;
    this.limitManager = limitManager;
    this.heartbeatIntervalMs = intervalSeconds * 1000;
  }

  async start(): Promise<void> {
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

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    this.isRunning = false;
    logger.info('heartbeat service stopped');
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.isRunning) return;

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
      const response = await fetch(
        `${this.orchestratorUrl}/api/v1/nodes/${this.nodeId}/heartbeat`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ resources }),
        }
      );

      if (response.ok) {
        const data: any = await response.json();
        logger.debug(
          {
            nodeId: this.nodeId,
            cpu: resources.cpu.available,
            memory: resources.memory.available,
          },
          'heartbeat sent successfully'
        );
        this.emit('heartbeat-success', { resources, timestamp: data.timestamp || Date.now() });

        // check if orchestrator sent pending jobs
        if (data.pendingJobs && data.pendingJobs.length > 0) {
          logger.info({ count: data.pendingJobs.length }, 'received pending jobs from heartbeat');
          this.emit('pending-jobs', data.pendingJobs);
        }
      } else {
        const error = await response.text();
        logger.warn(
          { status: response.status, error },
          'heartbeat request failed'
        );
        this.emit('heartbeat-error', { status: response.status, error });
      }
    } catch (err) {
      logger.error({ err }, 'failed to send heartbeat');
      this.emit('heartbeat-error', { error: err });
    }
  }

  // manually trigger a heartbeat
  async triggerHeartbeat(): Promise<void> {
    await this.sendHeartbeat();
  }

  isActive(): boolean {
    return this.isRunning;
  }
}
