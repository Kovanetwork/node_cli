// lease handler - monitors for won bids and executes deployments
// fetches manifests, starts containers, streams logs

import { logger } from '../lib/logger.js';
import { DeploymentExecutor } from './deployment-executor.js';
import { P2PNode } from '../lib/p2p.js';
import { stateManager } from '../lib/state.js';

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
  filesVersion: number;
  state: string;
}

export class LeaseHandler {
  private config: LeaseHandlerConfig;
  private executor: DeploymentExecutor;
  private p2pNode?: P2PNode;
  private pollingInterval: NodeJS.Timeout | null = null;
  private activeLeases: Set<string> = new Set();
  private filesVersions: Map<string, number> = new Map();

  constructor(config: LeaseHandlerConfig, executor: DeploymentExecutor, p2pNode?: P2PNode) {
    this.config = config;
    this.executor = executor;
    this.p2pNode = p2pNode;

    this.executor.on('log', async (logData) => {
      await this.sendLogToOrchestrator(logData);
    });

    // setup p2p event listeners for real-time notifications
    if (this.p2pNode) {
      this.setupP2PListeners();
    }
  }

  private setupP2PListeners(): void {
    if (!this.p2pNode) return;

    // handle manifest delivery via p2p
    this.p2pNode.on('deployment-manifest', async (data: any) => {
      if (data.nodeId !== this.config.nodeId) return;

      logger.info({ deploymentId: data.deploymentId }, 'received manifest via p2p');

      try {
        await this.executor.executeDeployment({
          deploymentId: data.deploymentId,
          leaseId: data.leaseId || '',
          manifest: data.manifest
        });

        this.activeLeases.add(data.deploymentId);
        this.filesVersions.set(data.deploymentId, 0);
        stateManager.addDeployment(data.deploymentId);
        logger.info({ deploymentId: data.deploymentId }, 'deployment started from p2p manifest');
      } catch (err) {
        logger.error({ err, deploymentId: data.deploymentId }, 'failed to execute deployment from p2p');
      }
    });

    // handle deployment closure notification
    this.p2pNode.on('deployment-close', async (data: any) => {
      if (data.nodeId !== this.config.nodeId) return;

      logger.info({ deploymentId: data.deploymentId }, 'received closure notification via p2p');

      try {
        await this.executor.stopDeployment(data.deploymentId);
        this.activeLeases.delete(data.deploymentId);
        this.filesVersions.delete(data.deploymentId);
        stateManager.removeDeployment(data.deploymentId);
        logger.info({ deploymentId: data.deploymentId }, 'deployment stopped via p2p notification');
      } catch (err) {
        logger.error({ err, deploymentId: data.deploymentId }, 'failed to stop deployment from p2p');
      }
    });

    // handle insufficient funds pause notification
    this.p2pNode.on('deployment-paused', async (data: any) => {
      if (data.nodeId !== this.config.nodeId) return;

      logger.warn({
        deploymentId: data.deploymentId,
        reason: data.reason
      }, 'received pause notification - insufficient funds');

      // container will keep running but user is warned
      // orchestrator will close deployment if funds not added
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
        const deploymentRunning = this.executor.getDeployment(lease.deploymentId);

        // check if deployment is already running (either we started it or discovered it)
        if (deploymentRunning) {
          // track this as active
          this.activeLeases.add(lease.deploymentId);

          // check if files_version changed (files updated)
          const lastKnownVersion = this.filesVersions.get(lease.deploymentId);
          const currentVersion = lease.filesVersion || 0;

          // if we don't have a tracked version yet (discovered deployment), initialize it
          if (lastKnownVersion === undefined) {
            this.filesVersions.set(lease.deploymentId, currentVersion);
            logger.info({ deploymentId: lease.deploymentId, filesVersion: currentVersion }, 'initialized files_version for existing deployment');
            continue;
          }

          // check for updates
          if (currentVersion > lastKnownVersion) {
            logger.info({
              deploymentId: lease.deploymentId,
              oldVersion: lastKnownVersion,
              newVersion: currentVersion
            }, 'files updated - syncing changes');

            try {
              // update files for this deployment
              // assume 'web' service for now (could parse manifest for service names)
              await this.executor.updateDeploymentFiles(lease.deploymentId, 'web');

              // update tracked version
              this.filesVersions.set(lease.deploymentId, currentVersion);

              logger.info({ deploymentId: lease.deploymentId }, 'files synced successfully');
            } catch (err) {
              logger.error({ err, deploymentId: lease.deploymentId }, 'failed to sync files');
            }
          }

          continue;
        }

        logger.info({ leaseId: lease.id, deploymentId: lease.deploymentId }, 'new lease assigned');

        // execute deployment (will download files at current version)
        await this.executeDeployment(lease);

        // track files_version only AFTER successful deployment
        // this ensures we don't miss updates that happened before we started
        this.filesVersions.set(lease.deploymentId, lease.filesVersion || 0);
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

      stateManager.addDeployment(lease.deploymentId);
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
