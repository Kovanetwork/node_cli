// lease handler - monitors for won bids and executes deployments
// fetches manifests, starts containers, streams logs

import { logger } from '../lib/logger.js';
import { DeploymentExecutor } from './deployment-executor.js';

interface LeaseHandlerConfig {
  nodeId: string;
  providerId: string;
  orchestratorUrl: string;
}

interface Lease {
  id: string;
  deploymentId: string;
  nodeId: string;
  pricePerBlock: number;
  manifest: any;
  manifestVersion: string;
  state: string;
}

export class LeaseHandler {
  private config: LeaseHandlerConfig;
  private executor: DeploymentExecutor;
  private pollingInterval: NodeJS.Timeout | null = null;
  private activeLeases: Set<string> = new Set();

  constructor(config: LeaseHandlerConfig, executor: DeploymentExecutor) {
    this.config = config;
    this.executor = executor;

    // forward log events
    this.executor.on('log', async (logData) => {
      await this.sendLogToOrchestrator(logData);
    });
  }

  // start monitoring for new leases
  start(intervalMs: number = 10000): void {
    if (this.pollingInterval) {
      logger.warn('lease handler already running');
      return;
    }

    logger.info({ intervalMs }, 'starting lease handler');

    this.pollingInterval = setInterval(async () => {
      try {
        await this.pollLeases();
      } catch (err) {
        logger.error({ err }, 'lease polling failed');
      }
    }, intervalMs);

    // run immediately
    this.pollLeases();
  }

  stop(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logger.info('lease handler stopped');
    }
  }

  // poll for active leases assigned to this node
  private async pollLeases(): Promise<void> {
    try {
      const response = await fetch(`${this.config.orchestratorUrl}/api/v1/provider/leases`, {
        headers: {
          'Authorization': `Bearer ${await this.getToken()}`
        }
      });

      if (!response.ok) {
        logger.debug('failed to fetch leases');
        return;
      }

      const data: any = await response.json();
      const leases: Lease[] = data.leases || [];

      // filter for this node
      const myLeases = leases.filter(l => l.nodeId === this.config.nodeId);

      for (const lease of myLeases) {
        // check if we're already running this deployment
        if (this.activeLeases.has(lease.deploymentId)) {
          continue;
        }

        logger.info({ leaseId: lease.id, deploymentId: lease.deploymentId }, 'new lease assigned');

        // execute deployment
        await this.executeDeployment(lease);
      }
    } catch (err) {
      logger.debug({ err }, 'lease polling error');
    }
  }

  // execute deployment from lease
  private async executeDeployment(lease: Lease): Promise<void> {
    try {
      this.activeLeases.add(lease.deploymentId);

      logger.info({ deploymentId: lease.deploymentId, manifest: lease.manifest }, 'executing deployment');

      await this.executor.executeDeployment({
        deploymentId: lease.deploymentId,
        leaseId: lease.id,
        manifest: lease.manifest
      });

      logger.info({ deploymentId: lease.deploymentId }, 'deployment running');
    } catch (err) {
      logger.error({ err, deploymentId: lease.deploymentId }, 'deployment execution failed');
      this.activeLeases.delete(lease.deploymentId);
    }
  }

  // send log to orchestrator
  private async sendLogToOrchestrator(logData: {
    deploymentId: string;
    serviceName: string;
    logLine: string;
    stream: 'stdout' | 'stderr';
    timestamp: Date;
  }): Promise<void> {
    try {
      const response = await fetch(`${this.config.orchestratorUrl}/api/v1/deployments/${logData.deploymentId}/logs/append`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${await this.getToken()}`
        },
        body: JSON.stringify({
          serviceName: logData.serviceName,
          logLine: logData.logLine,
          stream: logData.stream
        })
      });

      if (!response.ok) {
        logger.debug({ deploymentId: logData.deploymentId }, 'failed to send log');
      }
    } catch (err) {
      logger.debug({ err }, 'failed to send log to orchestrator');
    }
  }

  // get auth token
  private async getToken(): Promise<string> {
    const response = await fetch(`${this.config.orchestratorUrl}/api/v1/auth/test-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: this.config.providerId,
        role: 'provider'
      })
    });

    const data: any = await response.json();
    return data.token;
  }
}
