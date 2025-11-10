// deployment executor - runs deployments from sdl manifests
// handles multi-service deployments, persistent volumes, port exposure

import { EventEmitter } from 'events';
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
      const network = await this.docker.createNetwork({
        Name: networkName,
        Driver: 'bridge',
        Internal: false
      });

      execution.networks.push(network.id);
      logger.info({ deploymentId, networkName }, 'created deployment network');

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

    // setup port bindings
    const exposedPorts: any = {};
    const portBindings: any = {};

    if (service.expose) {
      for (const expose of service.expose) {
        const containerPort = expose.port;
        const hostPort = expose.as || expose.port;
        const isGlobal = expose.to?.some(t => t.global);

        exposedPorts[`${containerPort}/tcp`] = {};

        if (isGlobal) {
          // bind to host for global exposure
          portBindings[`${containerPort}/tcp`] = [{ HostPort: String(hostPort) }];
        }
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

    // cleanup any existing container with same name (from previous failed attempts)
    try {
      const existing = this.docker.getContainer(containerName);
      await existing.remove({ force: true });
      logger.info({ containerName }, 'removed existing container');
    } catch (err) {
      // container doesn't exist, that's fine
    }

    const container = await this.docker.createContainer({
      name: containerName,
      Image: service.image,
      Env: env,
      ExposedPorts: exposedPorts,
      HostConfig: {
        NetworkMode: networkName,
        Binds: binds,
        PortBindings: portBindings,
        ReadonlyRootfs: false, // allow writes to mounted volumes
        AutoRemove: false,
        RestartPolicy: { Name: 'no' }
      },
      Labels: {
        'kova.deployment': deploymentId,
        'kova.service': serviceName
      }
    });

    // start container
    await container.start();

    execution.containers.set(serviceName, container.id);

    logger.info({ deploymentId, serviceName, containerId: container.id }, 'service started');

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
      timestamps: true
    }, (err: any, stream: any) => {
      if (err) {
        logger.error({ err }, 'failed to attach to container logs');
        return;
      }

      stream.on('data', (chunk: Buffer) => {
        const logLine = chunk.toString().trim();
        if (logLine) {
          this.emitLog(deploymentId, serviceName, logLine, 'stdout');
        }
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
