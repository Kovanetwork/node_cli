// deployment executor - runs deployments from sdl manifests
// handles multi-service deployments, persistent volumes, port exposure

import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { logger } from '../lib/logger.js';
import Docker from 'dockerode';
import { randomBytes } from 'crypto';

interface Service {
  image: string;
  env?: string[] | Record<string, string>;
  expose?: Array<{
    port: number;
    as?: number;
    to?: Array<{ global?: boolean; service?: string }>;
    proto?: string;
  }>;
  params?: {
    storage?: Record<string, {
      mount: string;
      readOnly?: boolean;
    }>;
  };
}

interface SDL {
  version: string;
  services: Record<string, Service>;
  profiles: any;
  deployment: any;
}

interface DeploymentExecution {
  deploymentId: string;
  leaseId: string;
  manifest: SDL;
  containers: Map<string, string>; // serviceName -> containerId
  networks: string[];
  volumes: string[];
}

export class DeploymentExecutor extends EventEmitter {
  private docker: Docker;
  private executions: Map<string, DeploymentExecution> = new Map();

  constructor() {
    super();
    this.docker = new Docker();
  }

  // execute deployment from manifest
  async executeDeployment(options: {
    deploymentId: string;
    leaseId: string;
    manifest: SDL;
  }): Promise<void> {
    const { deploymentId, leaseId, manifest } = options;

    logger.info({ deploymentId, leaseId }, 'executing deployment');

    const execution: DeploymentExecution = {
      deploymentId,
      leaseId,
      manifest,
      containers: new Map(),
      networks: [],
      volumes: []
    };

    this.executions.set(deploymentId, execution);

    try {
      // create isolated network for this deployment
      const networkName = `kova-deploy-${deploymentId.slice(-8)}`;
      let network;

      try {
        network = await this.docker.createNetwork({
          Name: networkName,
          Driver: 'bridge',
          Internal: false
        });
        logger.info({ deploymentId, networkName }, 'created deployment network');
      } catch (err: any) {
        if (err.statusCode === 409 || err.message?.includes('already exists')) {
          // network already exists, get it
          const networks = await this.docker.listNetworks({
            filters: { name: [networkName] }
          });
          network = networks[0] ? this.docker.getNetwork(networks[0].Id) : null;
          if (network) {
            logger.info({ deploymentId, networkName }, 'using existing network');
          } else {
            throw new Error(`network ${networkName} exists but could not be retrieved`);
          }
        } else {
          throw err;
        }
      }

      execution.networks.push(network.id);

      // create persistent volumes if needed
      for (const [serviceName, service] of Object.entries(manifest.services)) {
        if (service.params?.storage) {
          for (const [volumeName, volumeConfig] of Object.entries(service.params.storage)) {
            const volumeFullName = `kova-${deploymentId}-${serviceName}-${volumeName}`;

            const volume = await this.docker.createVolume({
              Name: volumeFullName,
              Driver: 'local'
            });

            execution.volumes.push(volume.Name);
            logger.info({ deploymentId, volumeName: volumeFullName }, 'created persistent volume');
          }
        }
      }

      // start each service
      for (const [serviceName, service] of Object.entries(manifest.services)) {
        await this.startService(deploymentId, serviceName, service, execution, networkName);
      }

      this.emit('deployment-started', { deploymentId, leaseId });
      logger.info({ deploymentId, services: execution.containers.size }, 'deployment running');
    } catch (err) {
      logger.error({ err, deploymentId }, 'deployment execution failed');
      await this.cleanupDeployment(deploymentId);
      throw err;
    }
  }

  // start a single service
  private async startService(
    deploymentId: string,
    serviceName: string,
    service: Service,
    execution: DeploymentExecution,
    networkName: string
  ): Promise<void> {
    logger.info({ deploymentId, serviceName, image: service.image }, 'starting service');

    // convert env to docker format
    let env: string[] = [];
    if (service.env) {
      if (Array.isArray(service.env)) {
        env = service.env;
      } else {
        env = Object.entries(service.env).map(([k, v]) => `${k}=${v}`);
      }
    }

    // setup volume binds
    const binds: string[] = [];
    if (service.params?.storage) {
      for (const [volumeName, volumeConfig] of Object.entries(service.params.storage)) {
        const volumeFullName = `kova-${deploymentId}-${serviceName}-${volumeName}`;
        const mountPath = volumeConfig.mount;
        const mode = volumeConfig.readOnly ? 'ro' : 'rw';
        binds.push(`${volumeFullName}:${mountPath}:${mode}`);
      }
    }

    // setup port exposure (internal only, no host binding)
    // ingress controller will proxy to these ports via docker network
    const exposedPorts: any = {};

    if (service.expose) {
      for (const expose of service.expose) {
        const containerPort = expose.port;
        exposedPorts[`${containerPort}/tcp`] = {};
      }
    }

    // pull image first
    try {
      await this.pullImage(service.image, deploymentId, serviceName);
    } catch (err) {
      logger.error({ err, image: service.image }, 'failed to pull image');
      throw err;
    }

    // create container
    const containerName = `kova-${deploymentId}-${serviceName}`;
    let container;
    let isExisting = false;

    // check if container already exists
    try {
      const existing = this.docker.getContainer(containerName);
      const info = await existing.inspect();

      if (info.State.Running) {
        // container is already running, reuse it
        container = existing;
        isExisting = true;
        logger.info({ containerName, containerId: info.Id }, 'reusing existing running container');
      } else {
        // container exists but not running, remove and recreate
        await existing.remove({ force: true });
        logger.info({ containerName }, 'removed stopped container');
      }
    } catch (err) {
      // container doesn't exist, will create new one
    }

    if (!isExisting) {
      container = await this.docker.createContainer({
        name: containerName,
        Image: service.image,
        Env: env,
        ExposedPorts: exposedPorts,
        HostConfig: {
          NetworkMode: networkName,
          Binds: binds,
          // no port bindings - containers only accessible via docker network
          ReadonlyRootfs: false, // allow writes to mounted volumes
          AutoRemove: false,
          RestartPolicy: { Name: 'no' }
        },
        Labels: {
          'kova.deployment': deploymentId,
          'kova.service': serviceName,
          'kova.lease': execution.leaseId
        }
      });

      // start container
      await container.start();
      logger.info({ deploymentId, serviceName, containerId: container.id }, 'service started');
    }

    execution.containers.set(serviceName, container.id);

    // start streaming logs
    this.streamLogs(container, deploymentId, serviceName);
  }

  // pull docker image with progress
  private async pullImage(image: string, deploymentId: string, serviceName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.docker.pull(image, (err: any, stream: any) => {
        if (err) {
          return reject(err);
        }

        this.docker.modem.followProgress(
          stream,
          (err: any) => {
            if (err) {
              this.emitLog(deploymentId, serviceName, `failed to pull ${image}: ${err.message}`, 'stderr');
              return reject(err);
            }

            this.emitLog(deploymentId, serviceName, `pulled ${image}`, 'stdout');
            resolve();
          },
          (event: any) => {
            if (event.status) {
              this.emitLog(deploymentId, serviceName, `[pull] ${event.status}`, 'stdout');
            }
          }
        );
      });
    });
  }

  // stream container logs
  private streamLogs(container: any, deploymentId: string, serviceName: string): void {
    container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      timestamps: false
    }, (err: any, stream: any) => {
      if (err) {
        logger.error({ err }, 'failed to attach to container logs');
        return;
      }

      // docker multiplexes stdout/stderr streams, need to demux
      const stdout = new PassThrough();
      const stderr = new PassThrough();

      container.modem.demuxStream(stream, stdout, stderr);

      stdout.on('data', (chunk: Buffer) => {
        const logLine = chunk.toString('utf8').trim();
        if (logLine) {
          this.emitLog(deploymentId, serviceName, logLine, 'stdout');
        }
      });

      stderr.on('data', (chunk: Buffer) => {
        const logLine = chunk.toString('utf8').trim();
        if (logLine) {
          this.emitLog(deploymentId, serviceName, logLine, 'stderr');
        }
      });

      stream.on('end', () => {
        logger.info({ deploymentId, serviceName }, 'log stream ended');
      });

      stream.on('error', (err: any) => {
        logger.error({ err, deploymentId, serviceName }, 'log stream error');
      });
    });
  }

  // emit log entry
  private emitLog(deploymentId: string, serviceName: string, logLine: string, stream: 'stdout' | 'stderr'): void {
    this.emit('log', {
      deploymentId,
      serviceName,
      logLine,
      stream,
      timestamp: new Date()
    });
  }

  // stop deployment
  async stopDeployment(deploymentId: string): Promise<void> {
    const execution = this.executions.get(deploymentId);
    if (!execution) {
      logger.warn({ deploymentId }, 'deployment not found');
      return;
    }

    await this.cleanupDeployment(deploymentId);

    logger.info({ deploymentId }, 'deployment stopped');
  }

  // cleanup deployment resources
  private async cleanupDeployment(deploymentId: string): Promise<void> {
    const execution = this.executions.get(deploymentId);
    if (!execution) return;

    // stop and remove containers
    for (const [serviceName, containerId] of execution.containers.entries()) {
      try {
        const container = this.docker.getContainer(containerId);
        await container.stop({ t: 10 });
        await container.remove();
        logger.info({ deploymentId, serviceName }, 'container removed');
      } catch (err) {
        logger.debug({ err, containerId }, 'failed to remove container');
      }
    }

    // remove networks
    for (const networkId of execution.networks) {
      try {
        const network = this.docker.getNetwork(networkId);
        await network.remove();
        logger.info({ deploymentId, networkId }, 'network removed');
      } catch (err) {
        logger.debug({ err, networkId }, 'failed to remove network');
      }
    }

    // note: don't remove volumes automatically (persistent data)
    // user can manually clean up or we can add a flag

    this.executions.delete(deploymentId);
  }

  // get running deployments
  getRunningDeployments(): string[] {
    return Array.from(this.executions.keys());
  }

  // get deployment info
  getDeployment(deploymentId: string): DeploymentExecution | undefined {
    return this.executions.get(deploymentId);
  }
}
