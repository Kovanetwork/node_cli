// lease handler - monitors for won bids and executes deployments
// fetches manifests, starts containers, streams logs

import { logger } from '../lib/logger.js';
import { DeploymentExecutor } from './deployment-executor.js';
import { P2PNode } from '../lib/p2p.js';
import { stateManager } from '../lib/state.js';
import Docker from 'dockerode';

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
  private docker: Docker;
  private pollingInterval: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private activeLeases: Set<string> = new Set();
  private filesVersions: Map<string, number> = new Map();
  private restartAttempts: Map<string, number> = new Map();

  constructor(config: LeaseHandlerConfig, executor: DeploymentExecutor, p2pNode?: P2PNode) {
    this.config = config;
    this.executor = executor;
    this.p2pNode = p2pNode;
    this.docker = new Docker();

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
        // use closeDeployment to permanently delete all resources including volumes
        await this.executor.closeDeployment(data.deploymentId);
        this.activeLeases.delete(data.deploymentId);
        this.filesVersions.delete(data.deploymentId);
        stateManager.removeDeployment(data.deploymentId);
        logger.info({ deploymentId: data.deploymentId }, 'deployment closed permanently via p2p notification');
      } catch (err) {
        logger.error({ err, deploymentId: data.deploymentId }, 'failed to close deployment from p2p');
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

    // start container health check (every 30 seconds)
    this.healthCheckInterval = setInterval(async () => {
      try {
        await this.checkAndRestartContainers();
      } catch (err) {
        logger.error({ err }, 'container health check failed');
      }
    }, 30000);

    // run immediately
    this.pollLeases();
  }

  // check container health and restart stopped containers
  private async checkAndRestartContainers(): Promise<void> {
    for (const deploymentId of this.activeLeases) {
      try {
        // find containers for this deployment
        const containers = await this.docker.listContainers({
          all: true,
          filters: { label: [`kova.deployment=${deploymentId}`] }
        });

        for (const containerInfo of containers) {
          const containerName = containerInfo.Names[0]?.replace('/', '') || '';
          const isRunning = containerInfo.State === 'running';

          if (!isRunning) {
            const attempts = this.restartAttempts.get(deploymentId) || 0;

            // limit restart attempts to prevent infinite loops
            if (attempts >= 5) {
              logger.error({
                deploymentId,
                containerName,
                attempts
              }, 'max restart attempts reached - container needs manual intervention');
              continue;
            }

            logger.warn({
              deploymentId,
              containerName,
              state: containerInfo.State,
              status: containerInfo.Status
            }, 'container stopped - attempting restart');

            try {
              const container = this.docker.getContainer(containerInfo.Id);
              await container.start();

              // reset attempts on successful restart
              this.restartAttempts.set(deploymentId, 0);

              logger.info({
                deploymentId,
                containerName
              }, 'container restarted successfully');
            } catch (err: any) {
              this.restartAttempts.set(deploymentId, attempts + 1);

              // if network error, try to recreate the container
              if (err.message?.includes('network') || err.message?.includes('not found')) {
                logger.warn({
                  deploymentId,
                  containerName,
                  error: err.message
                }, 'network error on restart - container may need recreation');
              } else {
                logger.error({
                  err,
                  deploymentId,
                  containerName
                }, 'failed to restart container');
              }
            }
          } else {
            // container is running, reset restart attempts
            this.restartAttempts.delete(deploymentId);
          }
        }
      } catch (err) {
        logger.debug({ err, deploymentId }, 'health check error for deployment');
      }
    }
  }

  stop(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    logger.info('lease handler stopped');
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
              // get service names from manifest
              const services = lease.manifest?.services || {};
              const serviceNames = Object.keys(services);

              // update files for each service (or use first service if only one)
              const serviceName = serviceNames[0] || 'web';

              await this.executor.updateDeploymentFiles(lease.deploymentId, serviceName);

              // update tracked version
              this.filesVersions.set(lease.deploymentId, currentVersion);

              logger.info({ deploymentId: lease.deploymentId, serviceName }, 'files synced successfully');
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
