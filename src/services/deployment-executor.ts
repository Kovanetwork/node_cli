// deployment executor - runs deployments from sdl manifests
// handles multi-service deployments, persistent volumes, port exposure

import { EventEmitter } from 'events';
import { PassThrough, Readable, Writable } from 'stream';
import { logger } from '../lib/logger.js';
import Docker from 'dockerode';
import { randomBytes, createHash } from 'crypto';

interface RegistryCredentials {
  host: string;
  username: string;
  password: string;
  email?: string;
}

interface Service {
  image: string;
  command?: string[];  // docker cmd override
  args?: string[];     // docker entrypoint args
  env?: string[] | Record<string, string>;
  expose?: Array<{
    port: number;
    as?: number;
    to?: Array<{ global?: boolean; service?: string }>;
    proto?: string;
  }>;
  depends_on?: string[];
  credentials?: RegistryCredentials;
  params?: {
    storage?: Record<string, {
      mount: string;
      readOnly?: boolean;
      source?: 'uploads' | 'empty';  // uploads = fetch from orchestrator
    }>;
  };
}

interface GpuConfig {
  units: number;
  attributes?: {
    vendor?: Record<string, any>;
    ram?: string;
    interface?: string;
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
  restartPolicy?: 'no' | 'always' | 'on-failure' | 'unless-stopped';
  restartMaxRetries?: number;
}

export class DeploymentExecutor extends EventEmitter {
  private docker: Docker;
  private executions: Map<string, DeploymentExecution> = new Map();
  private orchestratorUrl: string;
  private apiKey: string;

  constructor(config?: { orchestratorUrl?: string; apiKey?: string }) {
    super();
    this.docker = new Docker();
    this.orchestratorUrl = config?.orchestratorUrl || process.env.KOVA_ORCHESTRATOR_URL || 'http://localhost:3000';
    this.apiKey = config?.apiKey || '';
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

            // if source is "uploads", download and populate volume
            if (volumeConfig.source === 'uploads') {
              await this.populateVolumeFromUploads(
                deploymentId,
                serviceName,
                volumeFullName
              );
            }
          }
        }
      }

      // sort services by depends_on so dependencies start first (topological order)
      const serviceEntries = Object.entries(manifest.services);
      const sorted = this.topologicalSort(serviceEntries);

      // start each service in dependency order, respecting replica count
      for (const [serviceName, service] of sorted) {
        // extract gpu config from profiles if available
        let gpu: GpuConfig | undefined;
        let replicaCount = 1;

        if (manifest.profiles?.compute) {
          // find matching compute profile for this service
          for (const [profileName, profile] of Object.entries<any>(manifest.profiles.compute)) {
            if (profile.resources?.gpu) {
              gpu = profile.resources.gpu;
              break;
            }
          }
        }

        // get replica count from deployment section
        const serviceDeployment = manifest.deployment?.[serviceName];
        if (serviceDeployment) {
          for (const [, config] of Object.entries<any>(serviceDeployment)) {
            if (config?.count && config.count > 1) {
              replicaCount = Math.min(config.count, 20); // cap at 20 replicas
              break;
            }
          }
        }

        if (replicaCount > 1) {
          logger.info({ deploymentId, serviceName, replicaCount }, 'starting service replicas');
          for (let i = 0; i < replicaCount; i++) {
            const replicaName = `${serviceName}-${i}`;
            await this.startService(deploymentId, replicaName, service, execution, networkName, gpu);
          }
        } else {
          await this.startService(deploymentId, serviceName, service, execution, networkName, gpu);
        }
      }

      this.emit('deployment-started', { deploymentId, leaseId });
      logger.info({ deploymentId, services: execution.containers.size }, 'deployment running');
    } catch (err) {
      logger.error({ err, deploymentId }, 'deployment execution failed');
      await this.cleanupDeployment(deploymentId, true); // cleanup all resources on failure
      throw err;
    }
  }

  // parse memory string like "512Mi", "2Gi" into bytes
  private parseMemoryToBytes(size: string): number {
    const units: Record<string, number> = {
      'K': 1000, 'M': 1000 ** 2, 'G': 1000 ** 3, 'T': 1000 ** 4,
      'Ki': 1024, 'Mi': 1024 ** 2, 'Gi': 1024 ** 3, 'Ti': 1024 ** 4,
    };

    const match = size.match(/^(\d+(?:\.\d+)?)\s*([A-Za-z]+)$/);
    if (!match) return 4 * 1024 * 1024 * 1024; // 4gb fallback

    const value = parseFloat(match[1]);
    const unit = match[2];
    return Math.floor(value * (units[unit] || 1));
  }

  // start a single service
  private async startService(
    deploymentId: string,
    serviceName: string,
    service: Service,
    execution: DeploymentExecution,
    networkName: string,
    gpu?: GpuConfig
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

    // setup volume binds and tmpfs mounts for ram class storage
    const binds: string[] = [];
    const tmpfs: Record<string, string> = {};

    if (service.params?.storage) {
      // look up storage resources from the compute profile to check classes
      const serviceDeployment = execution?.manifest?.deployment?.[serviceName];
      let storageResources: any[] = [];
      if (serviceDeployment) {
        for (const [, config] of Object.entries<any>(serviceDeployment)) {
          if (config?.profile) {
            const profile = execution?.manifest?.profiles?.compute?.[config.profile];
            if (profile?.resources?.storage) {
              storageResources = Array.isArray(profile.resources.storage)
                ? profile.resources.storage : [profile.resources.storage];
            }
            break;
          }
        }
      }

      for (const [volumeName, volumeConfig] of Object.entries(service.params.storage)) {
        const mountPath = volumeConfig.mount;

        // check if this volume's storage class is 'ram' (shared memory / tmpfs)
        const matchingStorage = storageResources.find((s: any) => s.name === volumeName);
        if (matchingStorage?.attributes?.class === 'ram') {
          // create tmpfs mount instead of docker volume
          const sizeBytes = this.parseMemoryToBytes(matchingStorage.size || '64Mi');
          tmpfs[mountPath] = `size=${sizeBytes}`;
          logger.info({ deploymentId, serviceName, volumeName, mountPath, size: matchingStorage.size },
            'using tmpfs for ram class storage');
        } else {
          const volumeFullName = `kova-${deploymentId}-${serviceName}-${volumeName}`;
          const mode = volumeConfig.readOnly ? 'ro' : 'rw';
          binds.push(`${volumeFullName}:${mountPath}:${mode}`);
        }
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

    // pull image first (pass credentials for private registries)
    try {
      await this.pullImage(service.image, deploymentId, serviceName, service.credentials);
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
      // figure out resource limits from the service's compute profile
      let memoryLimit = 4 * 1024 * 1024 * 1024; // 4gb default
      let cpuCores = 4; // 4 cores default

      // look up the compute profile mapped to this specific service
      const serviceDeployment = execution.manifest.deployment?.[serviceName];
      let profileName: string | null = null;
      if (serviceDeployment) {
        // deployment section: { serviceName: { placementName: { profile: "profileName", count: N } } }
        for (const [, config] of Object.entries<any>(serviceDeployment)) {
          if (config?.profile) {
            profileName = config.profile;
            break;
          }
        }
      }

      const profiles = execution.manifest.profiles?.compute;
      if (profiles) {
        // use the mapped profile for this service, or fall back to first available
        const profile = profileName && profiles[profileName]
          ? profiles[profileName]
          : Object.values<any>(profiles)[0];

        if (profile?.resources) {
          const res = profile.resources;
          if (res.memory?.size) {
            memoryLimit = this.parseMemoryToBytes(res.memory.size);
          }
          if (res.cpu?.units) {
            cpuCores = parseFloat(res.cpu.units) || 4;
          }
        }
      }

      // clamp to sane limits
      const maxMemory = 32 * 1024 * 1024 * 1024; // 32gb hard ceiling
      memoryLimit = Math.min(memoryLimit, maxMemory);
      cpuCores = Math.min(cpuCores, 32);

      const containerConfig: any = {
        name: containerName,
        Image: service.image,
        Env: env,
        ExposedPorts: exposedPorts,
        HostConfig: {
          NetworkMode: networkName,
          Binds: binds,
          ReadonlyRootfs: false,
          AutoRemove: false,
          RestartPolicy: {
            Name: execution.restartPolicy || 'on-failure',
            MaximumRetryCount: (execution.restartPolicy || 'on-failure') === 'on-failure'
              ? (execution.restartMaxRetries || 3)
              : 0
          },
          // resource limits based on what was ordered
          Memory: memoryLimit,
          MemorySwap: memoryLimit,
          CpuPeriod: 100000,
          CpuQuota: Math.floor(cpuCores * 100000),
          Privileged: false,
          PidsLimit: 256,
          CapDrop: ['ALL'],
          CapAdd: ['CHOWN', 'NET_BIND_SERVICE', 'SETUID', 'SETGID', 'DAC_OVERRIDE'],
          // tmpfs mounts for ram class storage (shared memory)
          ...(Object.keys(tmpfs).length > 0 ? { Tmpfs: tmpfs } : {})
        },
        Labels: {
          'kova.deployment': deploymentId,
          'kova.service': serviceName,
          'kova.lease': execution.leaseId
        }
      };

      // add gpu device request if specified
      if (gpu && gpu.units > 0) {
        containerConfig.HostConfig.DeviceRequests = [{
          Driver: '',
          Count: gpu.units,
          DeviceIDs: [],
          Capabilities: [['gpu']],
          Options: {}
        }];
        logger.info({ deploymentId, serviceName, gpuUnits: gpu.units }, 'requesting gpu access');
      }

      // add command override if specified (docker CMD)
      if (service.command && service.command.length > 0) {
        containerConfig.Cmd = service.command;
        logger.info({ deploymentId, serviceName, command: service.command }, 'using custom command');
      }

      // add entrypoint args if specified
      if (service.args && service.args.length > 0) {
        containerConfig.Entrypoint = service.args;
        logger.info({ deploymentId, serviceName, args: service.args }, 'using custom entrypoint');
      }

      container = await this.docker.createContainer(containerConfig);

      // start container
      await container.start();
      logger.info({ deploymentId, serviceName, containerId: container.id }, 'service started');
    }

    execution.containers.set(serviceName, container.id);

    // start streaming logs
    this.streamLogs(container, deploymentId, serviceName);
  }

  // pull docker image with progress, optionally using private registry credentials
  private async pullImage(image: string, deploymentId: string, serviceName: string, credentials?: RegistryCredentials): Promise<void> {
    const pullOptions: any = {};

    if (credentials) {
      pullOptions.authconfig = {
        username: credentials.username,
        password: credentials.password,
        serveraddress: credentials.host,
        ...(credentials.email ? { email: credentials.email } : {})
      };
      logger.info({ deploymentId, serviceName, registry: credentials.host }, 'using private registry credentials');
    }

    return new Promise((resolve, reject) => {
      this.docker.pull(image, pullOptions, (err: any, stream: any) => {
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

  // stop deployment (preserves persistent volumes for restart)
  async stopDeployment(deploymentId: string): Promise<void> {
    const execution = this.executions.get(deploymentId);
    if (!execution) {
      logger.warn({ deploymentId }, 'deployment not found');
      return;
    }

    await this.cleanupDeployment(deploymentId, false);

    logger.info({ deploymentId }, 'deployment stopped');
  }

  // close deployment permanently (deletes all resources including persistent volumes)
  async closeDeployment(deploymentId: string): Promise<void> {
    const execution = this.executions.get(deploymentId);
    if (!execution) {
      // try to find and clean up volumes anyway
      await this.cleanupVolumes(deploymentId);
      logger.warn({ deploymentId }, 'deployment not in memory, cleaned up volumes');
      return;
    }

    await this.cleanupDeployment(deploymentId, true);

    logger.info({ deploymentId }, 'deployment closed permanently');
  }

  // cleanup deployment resources
  private async cleanupDeployment(deploymentId: string, deleteVolumes: boolean): Promise<void> {
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

    // remove volumes if requested (deployment closed permanently)
    if (deleteVolumes) {
      await this.cleanupVolumes(deploymentId);
    } else {
      logger.info({ deploymentId, volumeCount: execution.volumes.length }, 'preserving persistent volumes');
    }

    this.executions.delete(deploymentId);
  }

  // cleanup volumes for a deployment
  private async cleanupVolumes(deploymentId: string): Promise<void> {
    try {
      const volumes = await this.docker.listVolumes({
        filters: {
          name: [`kova-${deploymentId}`]
        }
      });

      for (const vol of volumes.Volumes || []) {
        try {
          const volume = this.docker.getVolume(vol.Name);
          await volume.remove();
          logger.info({ volumeName: vol.Name }, 'volume removed');
        } catch (err) {
          logger.debug({ err, volumeName: vol.Name }, 'failed to remove volume');
        }
      }
    } catch (err) {
      logger.error({ err, deploymentId }, 'failed to cleanup volumes');
    }
  }

  // topological sort of services by depends_on (dependencies start first)
  private topologicalSort(services: [string, Service][]): [string, Service][] {
    const serviceMap = new Map(services);
    const sorted: [string, Service][] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>(); // cycle detection

    const visit = (name: string) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        logger.warn({ service: name }, 'circular dependency detected, breaking cycle');
        return;
      }

      visiting.add(name);

      const service = serviceMap.get(name);
      if (service?.depends_on) {
        for (const dep of service.depends_on) {
          if (serviceMap.has(dep)) {
            visit(dep);
          } else {
            logger.warn({ service: name, dependency: dep }, 'depends_on references unknown service, ignoring');
          }
        }
      }

      visiting.delete(name);
      visited.add(name);
      if (service) {
        sorted.push([name, service]);
      }
    };

    for (const [name] of services) {
      visit(name);
    }

    return sorted;
  }

  // get docker events for containers in a deployment
  async getContainerEvents(deploymentId: string): Promise<any> {
    const execution = this.executions.get(deploymentId);
    if (!execution) {
      return { error: 'deployment not found', events: [] };
    }

    const containerIds = Array.from(execution.containers.values());
    if (containerIds.length === 0) {
      return { deploymentId, events: [] };
    }

    const events: any[] = [];

    for (const [serviceName, containerId] of execution.containers.entries()) {
      try {
        const container = this.docker.getContainer(containerId);
        const info = await container.inspect();

        // synthesize events from container state
        events.push({
          type: 'container',
          action: 'create',
          service: serviceName,
          containerId: containerId.slice(0, 12),
          image: info.Config.Image,
          time: new Date(info.Created).toISOString()
        });

        if (info.State.StartedAt && info.State.StartedAt !== '0001-01-01T00:00:00Z') {
          events.push({
            type: 'container',
            action: 'start',
            service: serviceName,
            containerId: containerId.slice(0, 12),
            image: info.Config.Image,
            time: info.State.StartedAt
          });
        }

        if (info.State.FinishedAt && info.State.FinishedAt !== '0001-01-01T00:00:00Z' && !info.State.Running) {
          events.push({
            type: 'container',
            action: 'stop',
            service: serviceName,
            containerId: containerId.slice(0, 12),
            exitCode: info.State.ExitCode,
            time: info.State.FinishedAt
          });
        }

        // check health status if configured
        if (info.State.Health) {
          const health = info.State.Health;
          events.push({
            type: 'health',
            action: health.Status, // healthy, unhealthy, starting
            service: serviceName,
            containerId: containerId.slice(0, 12),
            failingStreak: health.FailingStreak,
            time: health.Log?.length > 0
              ? health.Log[health.Log.length - 1].End
              : new Date().toISOString()
          });
        }
      } catch (err: any) {
        events.push({
          type: 'error',
          action: 'inspect_failed',
          service: serviceName,
          containerId: containerId.slice(0, 12),
          error: err.message,
          time: new Date().toISOString()
        });
      }
    }

    // sort events by time
    events.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

    return { deploymentId, timestamp: Date.now(), events };
  }

  // get running deployments
  getRunningDeployments(): string[] {
    return Array.from(this.executions.keys());
  }

  // get deployment info
  getDeployment(deploymentId: string): DeploymentExecution | undefined {
    return this.executions.get(deploymentId);
  }

  // get real-time docker stats for all containers in a deployment
  async getDeploymentStats(deploymentId: string): Promise<any> {
    const execution = this.executions.get(deploymentId);
    if (!execution) {
      return { error: 'deployment not found', services: {} };
    }

    const services: Record<string, any> = {};

    for (const [serviceName, containerId] of execution.containers.entries()) {
      try {
        const container = this.docker.getContainer(containerId);
        // one-shot stats (stream: false) to avoid hanging
        const stats = await container.stats({ stream: false });

        // calculate cpu usage percentage
        const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats?.cpu_usage?.total_usage || 0);
        const systemDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats?.system_cpu_usage || 0);
        const numCpus = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage?.percpu_usage?.length || 1;
        const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;

        // memory
        const memUsage = stats.memory_stats.usage || 0;
        const memLimit = stats.memory_stats.limit || 0;
        const memCache = stats.memory_stats.stats?.cache || 0;
        const memActual = memUsage - memCache;
        const memPercent = memLimit > 0 ? (memActual / memLimit) * 100 : 0;

        // network i/o
        let netRx = 0, netTx = 0;
        if (stats.networks) {
          for (const iface of Object.values(stats.networks) as any[]) {
            netRx += iface.rx_bytes || 0;
            netTx += iface.tx_bytes || 0;
          }
        }

        // block i/o
        let blockRead = 0, blockWrite = 0;
        if (stats.blkio_stats?.io_service_bytes_recursive) {
          for (const entry of stats.blkio_stats.io_service_bytes_recursive) {
            if (entry.op === 'read' || entry.op === 'Read') blockRead += entry.value;
            if (entry.op === 'write' || entry.op === 'Write') blockWrite += entry.value;
          }
        }

        services[serviceName] = {
          containerId: containerId.slice(0, 12),
          cpu: { percent: Math.round(cpuPercent * 100) / 100, cores: numCpus },
          memory: {
            used: memActual,
            limit: memLimit,
            percent: Math.round(memPercent * 100) / 100,
            usedFormatted: this.formatBytes(memActual),
            limitFormatted: this.formatBytes(memLimit)
          },
          network: {
            rx: netRx,
            tx: netTx,
            rxFormatted: this.formatBytes(netRx),
            txFormatted: this.formatBytes(netTx)
          },
          blockIo: {
            read: blockRead,
            write: blockWrite,
            readFormatted: this.formatBytes(blockRead),
            writeFormatted: this.formatBytes(blockWrite)
          },
          pids: stats.pids_stats?.current || 0
        };
      } catch (err: any) {
        services[serviceName] = { error: err.message, containerId: containerId.slice(0, 12) };
      }
    }

    return { deploymentId, timestamp: Date.now(), services };
  }

  // format bytes to human readable
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  }

  // get container running status for all services in a deployment
  async getDeploymentStatus(deploymentId: string): Promise<any> {
    const execution = this.executions.get(deploymentId);
    if (!execution) {
      return { error: 'deployment not found', services: {} };
    }

    const services: Record<string, any> = {};

    for (const [serviceName, containerId] of execution.containers.entries()) {
      try {
        const container = this.docker.getContainer(containerId);
        const info = await container.inspect();
        services[serviceName] = {
          containerId: containerId.slice(0, 12),
          running: info.State.Running,
          status: info.State.Status, // running, exited, paused, restarting, dead
          startedAt: info.State.StartedAt,
          finishedAt: info.State.FinishedAt,
          exitCode: info.State.ExitCode,
          restartCount: info.RestartCount,
          image: info.Config.Image,
          ports: Object.keys(info.Config.ExposedPorts || {}).map(p => {
            const [port, proto] = p.split('/');
            return { port: parseInt(port), protocol: proto || 'tcp' };
          })
        };
      } catch (err: any) {
        services[serviceName] = { error: err.message, containerId: containerId.slice(0, 12) };
      }
    }

    return { deploymentId, timestamp: Date.now(), services };
  }

  // discover existing deployments on startup
  async discoverExistingDeployments(): Promise<void> {
    logger.info('discovering existing kova deployments...');

    try {
      // find all containers with kova.deployment label
      const containers = await this.docker.listContainers({
        filters: { label: ['kova.deployment'] }
      });

      for (const containerInfo of containers) {
        const deploymentId = containerInfo.Labels['kova.deployment'];
        const serviceName = containerInfo.Labels['kova.service'] || 'web';

        if (!deploymentId) continue;

        // skip if already tracked
        if (this.executions.has(deploymentId)) continue;

        logger.info({ deploymentId, serviceName, containerId: containerInfo.Id }, 'discovered existing deployment');

        // get full container details
        const container = this.docker.getContainer(containerInfo.Id);
        const inspect = await container.inspect();

        // extract volumes from mounts
        const volumes: string[] = [];
        for (const mount of inspect.Mounts || []) {
          if (mount.Type === 'volume' && mount.Name) {
            volumes.push(mount.Name);
          }
        }

        // extract network
        const networks = Object.keys(inspect.NetworkSettings.Networks || {});
        const networkId = networks.length > 0 ? inspect.NetworkSettings.Networks[networks[0]].NetworkID : '';

        // create execution record
        const execution: DeploymentExecution = {
          deploymentId,
          leaseId: containerInfo.Labels['kova.lease'] || '',
          manifest: {
            version: '2.0',
            services: {},
            profiles: {},
            deployment: {}
          },
          containers: new Map([[serviceName, containerInfo.Id]]),
          volumes,
          networks: networkId ? [networkId] : []
        };

        this.executions.set(deploymentId, execution);

        // start streaming logs from discovered container
        try {
          const container = this.docker.getContainer(containerInfo.Id);
          this.streamLogs(container, deploymentId, serviceName);
          logger.info({ deploymentId, serviceName }, 'log streaming attached to discovered container');
        } catch (err) {
          logger.warn({ err, deploymentId }, 'failed to attach log streaming to discovered container');
        }

        logger.info({ deploymentId, volumes: volumes.length }, 'deployment state restored');
      }

      logger.info({ count: this.executions.size }, 'deployment discovery complete');
    } catch (err) {
      logger.error({ err }, 'failed to discover existing deployments');
    }
  }

  // download and populate volume with uploaded files from orchestrator
  private async populateVolumeFromUploads(
    deploymentId: string,
    serviceName: string,
    volumeName: string
  ): Promise<void> {
    const https = await import('https');
    const http = await import('http');
    const fs = await import('fs');
    const tar = await import('tar');
    const path = await import('path');
    const os = await import('os');

    logger.info({ deploymentId, serviceName, volumeName }, 'downloading files from orchestrator');

    const orchestratorUrl = this.orchestratorUrl;
    const downloadUrl = `${orchestratorUrl}/api/v1/deployments/${deploymentId}/services/${serviceName}/files/download`;

    // use api key for auth
    const authToken = this.apiKey || process.env.PROVIDER_TOKEN || '';

    // max download size (100mb to prevent disk exhaustion)
    const maxDownloadSize = 100 * 1024 * 1024;

    try {
      // download tarball to temp file
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kova-download-'));
      const tarballPath = path.join(tempDir, 'files.tar.gz');

      const downloadResult = await new Promise<{ checksum?: string }>((resolve, reject) => {
        const proto = orchestratorUrl.startsWith('https') ? https : http;
        const hash = createHash('sha256');
        let downloadedSize = 0;

        const req = proto.get(downloadUrl, {
          headers: {
            'Authorization': `Bearer ${authToken}`
          }
        }, (res: any) => {
          if (res.statusCode === 404) {
            logger.info({ deploymentId, serviceName }, 'no uploaded files found, skipping');
            resolve({});
            return;
          }

          if (res.statusCode !== 200) {
            reject(new Error(`failed to download files: ${res.statusCode} ${res.statusMessage}`));
            return;
          }

          // get expected checksum from header if provided
          const expectedChecksum = res.headers['x-checksum'];

          const fileStream = fs.createWriteStream(tarballPath);

          res.on('data', (chunk: Buffer) => {
            downloadedSize += chunk.length;
            // check size limit
            if (downloadedSize > maxDownloadSize) {
              req.destroy();
              fileStream.destroy();
              fs.rmSync(tempDir, { recursive: true, force: true });
              reject(new Error(`download exceeds size limit of ${maxDownloadSize} bytes`));
              return;
            }
            hash.update(chunk);
          });

          res.pipe(fileStream);
          fileStream.on('finish', () => {
            fileStream.close();
            const actualChecksum = hash.digest('hex');

            // verify checksum if provided
            if (expectedChecksum && actualChecksum !== expectedChecksum) {
              fs.rmSync(tempDir, { recursive: true, force: true });
              reject(new Error(`checksum mismatch: expected ${expectedChecksum}, got ${actualChecksum}`));
              return;
            }

            logger.info({ deploymentId, size: downloadedSize, checksum: actualChecksum }, 'file download verified');
            resolve({ checksum: actualChecksum });
          });
          fileStream.on('error', reject);
        });

        req.on('error', reject);
        req.end();
      });

      // check if tarball was downloaded
      if (!fs.existsSync(tarballPath)) {
        logger.info({ deploymentId, serviceName }, 'no files to populate volume');
        fs.rmSync(tempDir, { recursive: true, force: true });
        return;
      }

      // extract tarball to temp directory
      const extractDir = path.join(tempDir, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });

      await tar.extract({
        file: tarballPath,
        cwd: extractDir,
        // prevent zip-slip: strip leading slashes and block path traversal
        strip: 0,
        filter: (path: string) => {
          if (path.includes('..')) {
            logger.warn({ path }, 'blocked path traversal attempt in tar');
            return false;
          }
          return true;
        }
      });

      // copy files to volume using a temporary container
      // mount volume and copy files from temp directory
      const containerName = `kova-temp-copy-${Date.now()}`;

      await this.docker.run(
        'alpine:latest',
        ['sh', '-c', `cp -r /source/. /dest/`],
        process.stdout,
        {
          name: containerName,
          HostConfig: {
            Binds: [
              `${volumeName}:/dest`,
              `${extractDir}:/source:ro`
            ],
            AutoRemove: true
          }
        }
      );

      logger.info({ deploymentId, serviceName, volumeName }, 'files populated to volume');

      // cleanup temp directory
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      logger.error({ err, deploymentId, serviceName }, 'failed to populate volume from uploads');
      throw err;
    }
  }

  // update files in existing deployment volume and restart containers
  async updateDeploymentFiles(deploymentId: string, serviceName: string): Promise<void> {
    const execution = this.executions.get(deploymentId);
    if (!execution) {
      throw new Error('deployment not found');
    }

    logger.info({ deploymentId, serviceName }, 'updating deployment files');

    // find volume for this service
    const volumePrefix = `kova-${deploymentId}-${serviceName}-`;

    let volumeName = execution.volumes.find(v => v && v.startsWith(volumePrefix));

    // check docker if not in memory
    if (!volumeName) {
      logger.info({ deploymentId, serviceName, volumePrefix }, 'volume not in memory, querying docker');

      try {
        const volumes = await this.docker.listVolumes();
        const matchingVolume = volumes.Volumes?.find(v => v.Name?.startsWith(volumePrefix));

        if (matchingVolume) {
          volumeName = matchingVolume.Name;
          execution.volumes.push(volumeName);
          logger.info({ deploymentId, serviceName, volumeName }, 'found existing volume in docker');
        }
      } catch (err) {
        logger.error({ err, deploymentId, serviceName }, 'failed to query docker volumes');
      }
    }

    if (!volumeName) {
      throw new Error(`no volume found for service ${serviceName} (expected prefix: ${volumePrefix})`);
    }

    logger.info({ deploymentId, serviceName, volumeName }, 'found volume for update');

    // stop containers for this service
    const containerId = execution.containers.get(serviceName);
    if (containerId) {
      try {
        const container = this.docker.getContainer(containerId);
        await container.stop({ t: 10 });
        logger.info({ deploymentId, serviceName, containerId }, 'container stopped for file update');
      } catch (err) {
        logger.warn({ err, containerId }, 'failed to stop container');
      }
    }

    // backup volume to temp before clearing, so we can restore on failure
    const backupVolumeName = `${volumeName}-backup-${Date.now()}`;
    try {
      await this.docker.createVolume({ Name: backupVolumeName });
      await this.docker.run(
        'alpine:latest',
        ['sh', '-c', 'cp -a /source/. /backup/'],
        process.stdout,
        {
          HostConfig: {
            Binds: [`${volumeName}:/source:ro`, `${backupVolumeName}:/backup`],
            AutoRemove: true
          }
        }
      );
      logger.info({ deploymentId, serviceName, backupVolumeName }, 'volume backed up');
    } catch (err) {
      logger.warn({ err, deploymentId }, 'volume backup failed, proceeding without safety net');
    }

    try {
      // clear volume contents
      await this.docker.run(
        'alpine:latest',
        ['sh', '-c', 'rm -rf /dest/*'],
        process.stdout,
        {
          HostConfig: {
            Binds: [`${volumeName}:/dest`],
            AutoRemove: true
          }
        }
      );

      logger.info({ deploymentId, serviceName, volumeName }, 'volume contents cleared');

      // re-download and populate volume
      await this.populateVolumeFromUploads(deploymentId, serviceName, volumeName);

      // restart container
      if (containerId) {
        try {
          const container = this.docker.getContainer(containerId);
          await container.start();
          logger.info({ deploymentId, serviceName, containerId }, 'container restarted after file update');
        } catch (err) {
          logger.error({ err, containerId }, 'failed to restart container after file update');
          throw err;
        }
      }

      logger.info({ deploymentId, serviceName }, 'deployment files updated successfully');
    } catch (err) {
      // restore from backup if download failed
      try {
        await this.docker.run(
          'alpine:latest',
          ['sh', '-c', 'cp -a /backup/. /dest/'],
          process.stdout,
          {
            HostConfig: {
              Binds: [`${backupVolumeName}:/backup:ro`, `${volumeName}:/dest`],
              AutoRemove: true
            }
          }
        );
        logger.info({ deploymentId, serviceName }, 'restored volume from backup after failed update');
      } catch (restoreErr) {
        logger.error({ err: restoreErr }, 'failed to restore volume from backup');
      }

      // restart container even if update failed
      if (containerId) {
        try {
          const container = this.docker.getContainer(containerId);
          await container.start();
        } catch (restartErr) {
          logger.error({ err: restartErr }, 'failed to restart container after failed update');
        }
      }
      throw err;
    } finally {
      // clean up backup volume
      try {
        const backup = this.docker.getVolume(backupVolumeName);
        await backup.remove();
      } catch {
        // ignore cleanup errors
      }
    }
  }

  // browse files inside a running container
  async browseFiles(deploymentId: string, serviceName: string, dirPath: string = '/'): Promise<any> {
    const execution = this.executions.get(deploymentId);
    if (!execution) {
      return { error: 'deployment not found', files: [] };
    }

    let containerId = execution.containers.get(serviceName);
    if (!containerId && execution.containers.size > 0) {
      containerId = execution.containers.entries().next().value![1];
    }
    if (!containerId) {
      return { error: 'no containers found', files: [] };
    }

    try {
      const container = this.docker.getContainer(containerId);

      // try gnu ls first, fall back to plain ls -la for busybox
      let lsCmd = ['ls', '-laF', dirPath];
      const exec = await container.exec({
        Cmd: lsCmd,
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      const output = await this.collectExecOutput(stream);

      const files: any[] = [];
      const lines = output.stdout.split('\n').filter((l: string) => l.trim() && !l.startsWith('total'));

      for (const line of lines) {
        // try iso format first: -rw-r--r-- 1 root root 123 2026-02-11 09:54 file.txt
        let match = line.match(/^([drwxlstSTrw\-\.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/);
        let dateStr = '';

        if (match) {
          dateStr = `${match[6]} ${match[7]}`;
        } else {
          // busybox format: -rw-r--r-- 1 root root 123 Feb 11 09:54 file.txt
          match = line.match(/^([drwxlstSTrw\-\.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\w{3}\s+\d{1,2}\s+[\d:]+)\s+(.+)$/);
          if (match) {
            dateStr = match[6];
            // shift: busybox match has 7 groups (date is one field, name is match[7])
            match = [match[0], match[1], match[2], match[3], match[4], match[5], match[6], '', match[7]];
          }
        }

        if (!match) continue;

        const permissions = match[1];
        const owner = match[3];
        const group = match[4];
        const size = match[5];
        const rawName = match[8];
        const isDir = permissions.startsWith('d');
        const isLink = permissions.startsWith('l');
        let name = rawName;
        let linkTarget = '';

        // remove trailing / or @ or * from name (added by -F flag)
        if (isDir && name.endsWith('/')) name = name.slice(0, -1);
        if (name.endsWith('*')) name = name.slice(0, -1);
        if (name.endsWith('@')) name = name.slice(0, -1);

        // handle symlinks: name -> target
        if (isLink && name.includes(' -> ')) {
          const parts = name.split(' -> ');
          name = parts[0];
          linkTarget = parts[1];
        }

        // skip . and ..
        if (name === '.' || name === '..') continue;

        files.push({
          name,
          path: dirPath === '/' ? `/${name}` : `${dirPath}/${name}`,
          type: isDir ? 'directory' : isLink ? 'link' : 'file',
          size: parseInt(size),
          permissions,
          owner,
          group,
          modified: dateStr,
          linkTarget: linkTarget || undefined
        });
      }

      // sort: directories first, then alphabetical
      files.sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name);
      });

      return { path: dirPath, files };
    } catch (err: any) {
      logger.error({ err, deploymentId, dirPath }, 'failed to browse files');
      return { error: err.message, files: [] };
    }
  }

  // read a file from inside a container
  async readContainerFile(deploymentId: string, serviceName: string, filePath: string): Promise<any> {
    const execution = this.executions.get(deploymentId);
    if (!execution) {
      return { error: 'deployment not found' };
    }

    let containerId = execution.containers.get(serviceName);
    if (!containerId && execution.containers.size > 0) {
      containerId = execution.containers.entries().next().value![1];
    }
    if (!containerId) {
      return { error: 'no containers found' };
    }

    try {
      const container = this.docker.getContainer(containerId);

      // check file size first (reject files > 5MB)
      const statExec = await container.exec({
        Cmd: ['stat', '-c', '%s', filePath],
        AttachStdout: true,
        AttachStderr: true,
      });
      const statStream = await statExec.start({ hijack: true, stdin: false });
      const statOutput = await this.collectExecOutput(statStream);

      if (statOutput.stderr.includes('No such file')) {
        return { error: 'file not found' };
      }

      const fileSize = parseInt(statOutput.stdout.trim());
      if (fileSize > 5 * 1024 * 1024) {
        return { error: 'file too large (max 5MB)', size: fileSize };
      }

      // read the file content using base64 to handle binary safely
      const exec = await container.exec({
        Cmd: ['base64', filePath],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      const output = await this.collectExecOutput(stream);

      if (output.stderr && output.stderr.includes('No such file')) {
        return { error: 'file not found' };
      }

      const content = Buffer.from(output.stdout.replace(/\s/g, ''), 'base64').toString('utf8');

      // detect if binary (has null bytes or high ratio of non-printable chars)
      const nonPrintable = content.split('').filter(c => {
        const code = c.charCodeAt(0);
        return code < 32 && code !== 9 && code !== 10 && code !== 13;
      }).length;
      const isBinary = nonPrintable > content.length * 0.1;

      return {
        path: filePath,
        size: fileSize,
        content: isBinary ? undefined : content,
        binary: isBinary,
        encoding: isBinary ? 'base64' : 'utf8',
        rawBase64: isBinary ? output.stdout.replace(/\s/g, '') : undefined
      };
    } catch (err: any) {
      logger.error({ err, deploymentId, filePath }, 'failed to read container file');
      return { error: err.message };
    }
  }

  // upload a file into a running container
  async uploadFileToContainer(deploymentId: string, serviceName: string, filePath: string, content: string, encoding: 'utf8' | 'base64' = 'utf8'): Promise<any> {
    const execution = this.executions.get(deploymentId);
    if (!execution) {
      return { success: false, error: 'deployment not found' };
    }

    let containerId = execution.containers.get(serviceName);
    if (!containerId && execution.containers.size > 0) {
      containerId = execution.containers.entries().next().value![1];
    }
    if (!containerId) {
      return { success: false, error: 'no containers found' };
    }

    // validate path (prevent path traversal)
    if (filePath.includes('..') || !filePath.startsWith('/')) {
      return { success: false, error: 'invalid file path' };
    }

    try {
      const container = this.docker.getContainer(containerId);

      // ensure parent directory exists
      const parentDir = filePath.substring(0, filePath.lastIndexOf('/')) || '/';
      const mkdirExec = await container.exec({
        Cmd: ['mkdir', '-p', parentDir],
        AttachStdout: true,
        AttachStderr: true,
      });
      const mkdirStream = await mkdirExec.start({ hijack: true, stdin: false });
      await this.collectExecOutput(mkdirStream);

      // write file using base64 decode via shell
      const b64Content = encoding === 'base64' ? content : Buffer.from(content, 'utf8').toString('base64');
      const exec = await container.exec({
        Cmd: ['sh', '-c', `echo '${b64Content}' | base64 -d > ${filePath}`],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      const output = await this.collectExecOutput(stream);

      if (output.stderr && !output.stderr.includes('warning')) {
        return { success: false, error: output.stderr.trim() };
      }

      logger.info({ deploymentId, filePath }, 'file uploaded to container');
      return { success: true, path: filePath };
    } catch (err: any) {
      logger.error({ err, deploymentId, filePath }, 'failed to upload file to container');
      return { success: false, error: err.message };
    }
  }

  // collect output from a docker exec stream
  private collectExecOutput(stream: any): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        resolve({ stdout, stderr: stderr || 'command timed out' });
      }, 10000);

      stream.on('data', (chunk: Buffer) => {
        // docker multiplexes: first 8 bytes are header
        // byte 0: stream type (1=stdout, 2=stderr)
        // bytes 4-7: payload size
        const data = chunk.toString('utf8');
        stdout += data;
      });

      stream.on('end', () => {
        clearTimeout(timeout);
        // strip docker header bytes if present
        const clean = stdout.replace(/[\x00-\x08]/g, '');
        resolve({ stdout: clean, stderr });
      });

      stream.on('error', (err: any) => {
        clearTimeout(timeout);
        resolve({ stdout, stderr: err.message });
      });
    });
  }

  // shell session tracking
  private shellSessions: Map<string, {
    exec: any;
    stream: any;
    deploymentId: string;
    serviceName: string;
    debugContainer?: any; // temp container created for shell when original exits immediately
    debugImageTag?: string; // committed snapshot image to clean up
  }> = new Map();

  // start interactive shell session in container
  // returns { success: true } or { success: false, error: string }
  async startShellSession(
    sessionId: string,
    deploymentId: string,
    serviceName: string,
    onOutput: (data: string) => void
  ): Promise<{ success: boolean; error?: string }> {
    const execution = this.executions.get(deploymentId);
    if (!execution) {
      logger.warn({ deploymentId, sessionId }, 'shell: deployment not found');
      return { success: false, error: 'deployment not found on this provider' };
    }

    // try requested service first, then fall back to first available service
    let containerId = execution.containers.get(serviceName);
    let actualServiceName = serviceName;

    if (!containerId && execution.containers.size > 0) {
      // fall back to first available service
      const firstEntry = execution.containers.entries().next().value;
      if (firstEntry) {
        actualServiceName = firstEntry[0];
        containerId = firstEntry[1];
        logger.info({ deploymentId, requestedService: serviceName, actualService: actualServiceName },
          'shell: using fallback service');
      }
    }

    if (!containerId) {
      logger.warn({ deploymentId, serviceName, sessionId, availableServices: Array.from(execution.containers.keys()) },
        'shell: no services found');
      return { success: false, error: 'no containers found for this service' };
    }

    try {
      const container = this.docker.getContainer(containerId);
      const info = await container.inspect();
      let execContainer = container;
      let debugContainer: any = null;

      if (info.State.Running) {
        // container is running, exec directly into it
        logger.info({ deploymentId, containerId }, 'shell: container running, attaching');
      } else {
        // container is stopped - try to start it
        logger.info({ deploymentId, containerId, state: info.State.Status }, 'shell: container not running, starting it');
        try {
          await container.start();
        } catch (startErr: any) {
          // ignore "already started" race
          if (!startErr.message?.includes('already started')) {
            logger.warn({ err: startErr, containerId }, 'shell: failed to start container');
          }
        }
        await new Promise(r => setTimeout(r, 1500));

        // check if it actually stayed running
        const recheck = await container.inspect();
        if (!recheck.State.Running) {
          // container exits immediately (e.g. node:20-alpine with no long-running process)
          // commit the stopped container to preserve its filesystem, then run with sleep
          logger.info({ deploymentId, containerId, image: info.Config.Image },
            'shell: container exits immediately, creating debug container from snapshot');

          const debugTag = `kova-debug:${containerId.slice(0, 12)}`;
          const debugName = `kova-debug-${sessionId.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 60)}`;

          // snapshot the stopped container's filesystem
          const commitResult = await container.commit({
            repo: 'kova-debug',
            tag: containerId.slice(0, 12),
            comment: 'debug shell snapshot'
          });
          logger.info({ debugTag, imageId: commitResult.Id }, 'shell: committed container snapshot');

          debugContainer = await this.docker.createContainer({
            name: debugName,
            Image: debugTag,
            Cmd: ['sh', '-c', 'trap "exit 0" TERM INT; while true; do sleep 1; done'],
            Tty: true,
            OpenStdin: true,
            WorkingDir: info.Config.WorkingDir || '/',
            Env: info.Config.Env || [],
            HostConfig: {
              NetworkMode: info.HostConfig.NetworkMode || 'bridge',
              Binds: info.HostConfig.Binds || [],
              AutoRemove: true
            },
            Labels: {
              'kova.deployment': deploymentId,
              'kova.service': serviceName,
              'kova.debug-shell': 'true'
            }
          });
          await debugContainer.start();
          execContainer = debugContainer;
          logger.info({ deploymentId, debugName }, 'shell: debug container started');
        }
      }

      // create exec instance for interactive shell
      const exec = await execContainer.exec({
        Cmd: ['/bin/sh'],
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true
      });

      // start the exec and get stream
      const stream = await exec.start({
        hijack: true,
        stdin: true,
        Tty: true
      });

      // store session (including debug container + image ref for cleanup)
      this.shellSessions.set(sessionId, {
        exec,
        stream,
        deploymentId,
        serviceName,
        debugContainer,
        debugImageTag: debugContainer ? `kova-debug:${containerId.slice(0, 12)}` : undefined
      });

      // forward output to callback
      stream.on('data', (chunk: Buffer) => {
        const output = chunk.toString('utf8');
        onOutput(output);
      });

      stream.on('end', () => {
        logger.info({ sessionId }, 'shell session stream ended');
        this.cleanupShellSession(sessionId);
        this.emit('shell-closed', { sessionId });
      });

      stream.on('error', (err: any) => {
        logger.error({ err, sessionId }, 'shell session stream error');
        this.cleanupShellSession(sessionId);
      });

      logger.info({ sessionId, deploymentId, serviceName, containerId, debug: !!debugContainer }, 'shell session started');
      return { success: true };
    } catch (err: any) {
      logger.error({ err, sessionId, deploymentId }, 'failed to start shell session');
      const msg = err.message || 'failed to start shell';
      if (msg.includes('is not running')) {
        return { success: false, error: 'container is not running - it may have crashed' };
      }
      if (msg.includes('No such image')) {
        return { success: false, error: 'container image not available locally' };
      }
      return { success: false, error: msg };
    }
  }

  // send input to shell session
  sendShellInput(sessionId: string, input: string): boolean {
    const session = this.shellSessions.get(sessionId);
    if (!session) {
      logger.warn({ sessionId }, 'shell input: session not found');
      return false;
    }

    try {
      session.stream.write(input);
      return true;
    } catch (err) {
      logger.error({ err, sessionId }, 'failed to send shell input');
      return false;
    }
  }

  // resize shell terminal
  resizeShell(sessionId: string, cols: number, rows: number): boolean {
    const session = this.shellSessions.get(sessionId);
    if (!session) {
      return false;
    }

    try {
      // resize the tty
      session.exec.resize({ h: rows, w: cols });
      return true;
    } catch (err) {
      logger.debug({ err, sessionId }, 'failed to resize shell');
      return false;
    }
  }

  // clean up a shell session and its debug container/image if any
  private cleanupShellSession(sessionId: string): void {
    const session = this.shellSessions.get(sessionId);
    if (!session) return;

    // stop debug container (AutoRemove will delete it)
    if (session.debugContainer) {
      session.debugContainer.stop({ t: 2 }).catch(() => {
        // ignore - may already be stopped
      });
    }

    // remove the committed snapshot image
    if (session.debugImageTag) {
      const img = this.docker.getImage(session.debugImageTag);
      img.remove({ force: true }).catch(() => {
        // ignore - best effort cleanup
      });
    }

    this.shellSessions.delete(sessionId);
  }

  // restart all containers in a deployment (stop then start)
  async restartDeployment(deploymentId: string): Promise<string[]> {
    const execution = this.executions.get(deploymentId);
    if (!execution) {
      throw new Error('deployment not found');
    }

    const restarted: string[] = [];

    for (const [serviceName, containerId] of execution.containers.entries()) {
      try {
        const container = this.docker.getContainer(containerId);
        await container.stop({ t: 10 });
        await container.start();
        restarted.push(serviceName);
        logger.info({ deploymentId, serviceName, containerId }, 'container restarted');
      } catch (err: any) {
        logger.error({ err, deploymentId, serviceName, containerId }, 'failed to restart container');
      }
    }

    return restarted;
  }

  // create a snapshot of a service's volume
  async createVolumeSnapshot(
    deploymentId: string,
    serviceName: string,
    snapshotId: string
  ): Promise<{ volumeName: string; sizeBytes: number; snapshotKey: string }> {
    const execution = this.executions.get(deploymentId);
    if (!execution) {
      throw new Error('deployment not found');
    }

    // find the volume for this service
    const volumePrefix = `kova-${deploymentId}-${serviceName}-`;
    let volumeName = execution.volumes.find(v => v.startsWith(volumePrefix));

    if (!volumeName) {
      // check docker directly
      const volumes = await this.docker.listVolumes();
      const match = volumes.Volumes?.find(v => v.Name?.startsWith(volumePrefix));
      if (match) {
        volumeName = match.Name;
      }
    }

    if (!volumeName) {
      throw new Error(`no volume found for service ${serviceName}`);
    }

    const snapshotDir = '/var/kova/snapshots';
    const snapshotKey = `${snapshotId}.tar.gz`;

    // ensure snapshot directory exists on host
    const fs = await import('fs');
    if (!fs.existsSync(snapshotDir)) {
      fs.mkdirSync(snapshotDir, { recursive: true });
    }

    // create snapshot using a temporary alpine container
    await this.docker.run(
      'alpine:latest',
      ['tar', 'czf', `/snapshots/${snapshotKey}`, '-C', '/data', '.'],
      process.stdout,
      {
        HostConfig: {
          Binds: [
            `${volumeName}:/data:ro`,
            `${snapshotDir}:/snapshots`
          ],
          AutoRemove: true
        }
      }
    );

    // get snapshot file size
    const snapshotPath = `${snapshotDir}/${snapshotKey}`;
    const stat = fs.statSync(snapshotPath);

    logger.info({ deploymentId, serviceName, volumeName, snapshotId, sizeBytes: stat.size }, 'volume snapshot created');

    return {
      volumeName,
      sizeBytes: stat.size,
      snapshotKey
    };
  }

  // restore a service's volume from a snapshot
  async restoreVolumeSnapshot(
    deploymentId: string,
    serviceName: string,
    snapshotKey: string
  ): Promise<void> {
    const execution = this.executions.get(deploymentId);
    if (!execution) {
      throw new Error('deployment not found');
    }

    // find the volume for this service
    const volumePrefix = `kova-${deploymentId}-${serviceName}-`;
    let volumeName = execution.volumes.find(v => v.startsWith(volumePrefix));

    if (!volumeName) {
      const volumes = await this.docker.listVolumes();
      const match = volumes.Volumes?.find(v => v.Name?.startsWith(volumePrefix));
      if (match) {
        volumeName = match.Name;
      }
    }

    if (!volumeName) {
      throw new Error(`no volume found for service ${serviceName}`);
    }

    const snapshotDir = '/var/kova/snapshots';

    // clear existing volume data
    await this.docker.run(
      'alpine:latest',
      ['sh', '-c', 'rm -rf /data/*'],
      process.stdout,
      {
        HostConfig: {
          Binds: [`${volumeName}:/data`],
          AutoRemove: true
        }
      }
    );

    // restore from snapshot
    await this.docker.run(
      'alpine:latest',
      ['tar', 'xzf', `/snapshots/${snapshotKey}`, '-C', '/data'],
      process.stdout,
      {
        HostConfig: {
          Binds: [
            `${volumeName}:/data`,
            `${snapshotDir}:/snapshots:ro`
          ],
          AutoRemove: true
        }
      }
    );

    logger.info({ deploymentId, serviceName, volumeName, snapshotKey }, 'volume snapshot restored');
  }

  // close shell session
  closeShellSession(sessionId: string): void {
    const session = this.shellSessions.get(sessionId);
    if (!session) {
      return;
    }

    try {
      session.stream.end();
    } catch (err) {
      // ignore
    }

    this.cleanupShellSession(sessionId);
    logger.info({ sessionId }, 'shell session closed');
  }
}
