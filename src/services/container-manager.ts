import { DockerManager } from '../lib/docker.js';
import { logger } from '../lib/logger.js';
import { JobSpec } from '../lib/types.js';
import { EventEmitter } from 'events';

interface HealthCheck {
  type: 'http' | 'tcp' | 'exec';
  port?: number;
  path?: string;
  command?: string;
  interval?: number; // seconds, default 30
  timeout?: number;  // seconds, default 5
  retries?: number;  // default 3
}

interface RunningContainer {
  jobId: string;
  containerId: string;
  startTime: number;
  resources: {
    cpu: number;
    memory: number;
    disk?: number;
  };
  status: 'starting' | 'running' | 'stopping' | 'stopped';
  healthCheck?: HealthCheck;
  healthStatus: 'unknown' | 'healthy' | 'unhealthy';
  healthFailures: number;
  lastHealthCheck?: number;
  timeout?: number; // max runtime in seconds, 0 = unlimited
  timeoutTimer?: NodeJS.Timeout;
}

export class ContainerManager extends EventEmitter {
  private docker: DockerManager;
  private containers: Map<string, RunningContainer> = new Map();
  private monitorInterval: NodeJS.Timeout | null = null;
  
  constructor() {
    super();
    this.docker = new DockerManager();
  }
  
  async start() {
    const ready = await this.docker.checkDocker();
    if (!ready) {
      throw new Error('docker not available');
    }
    
    // monitor containers every 10 seconds
    this.monitorInterval = setInterval(() => {
      this.monitorContainers();
    }, 10000);
  }
  
  async stop() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }
    
    // stop all running containers
    for (const [jobId, container] of this.containers) {
      await this.stopContainer(jobId);
    }
  }
  
  async runJob(job: JobSpec): Promise<string> {
    logger.info({ jobId: job.id }, 'starting container for job');
    
    try {
      // pull image if needed
      await this.docker.pullImage(job.image);
      
      // create container with security settings
      const container = await this.docker.createContainer({
        jobId: job.id,
        image: job.image,
        memory: job.resources.memory * 1024, // gb to mb
        cpus: job.resources.cpu,
        disk: job.resources.disk,
        env: job.env
      });
      
      const containerId = container.id;
      
      // track it with health check config from manifest
      const healthCheck = (job as any).healthCheck as HealthCheck | undefined;
      const containerInfo: RunningContainer = {
        jobId: job.id,
        containerId,
        startTime: Date.now(),
        resources: job.resources,
        status: 'running',
        healthCheck,
        healthStatus: 'unknown',
        healthFailures: 0,
        timeout: job.duration
      };

      // set up timeout if duration specified and > 0
      if (job.duration && job.duration > 0) {
        containerInfo.timeoutTimer = setTimeout(async () => {
          logger.warn({ jobId: job.id, duration: job.duration }, 'job timeout reached, stopping container');
          this.emit('container-timeout', { jobId: job.id, duration: job.duration });
          await this.stopContainer(job.id);
        }, job.duration * 1000);
      }

      this.containers.set(job.id, containerInfo);

      this.emit('container-started', { jobId: job.id, containerId });

      // wait for container to finish or timeout
      this.watchContainer(job.id, container);
      
      return containerId;
    } catch (err) {
      logger.error({ err, jobId: job.id }, 'failed to start container');
      this.emit('container-failed', { jobId: job.id, error: err });
      throw err;
    }
  }
  
  private async watchContainer(jobId: string, container: any) {
    try {
      // wait for container to exit
      const data = await container.wait();
      const exitCode = data.StatusCode;
      
      logger.info({ jobId, exitCode }, 'container exited');
      
      // SECURITY: Do NOT collect customer container logs
      // Node operators should not have access to customer data/secrets
      // Logs may contain API keys, passwords, sensitive data
      // If customers need logs, they should retrieve via encrypted channel

      this.emit('container-finished', {
        jobId,
        exitCode,
        // logs intentionally omitted for security/privacy
        logs: '[logs redacted for customer privacy - exit code: ' + exitCode + ']'
      });
      
      // cleanup
      await this.docker.cleanupContainer(container.id);
      this.containers.delete(jobId);
    } catch (err) {
      logger.error({ err, jobId }, 'error watching container');
      this.emit('container-failed', { jobId, error: err });
    }
  }
  
  async stopContainer(jobId: string) {
    const info = this.containers.get(jobId);
    if (!info) return;

    info.status = 'stopping';

    // clear timeout timer if set
    if (info.timeoutTimer) {
      clearTimeout(info.timeoutTimer);
      info.timeoutTimer = undefined;
    }

    try {
      await this.docker.cleanupContainer(info.containerId);
      this.containers.delete(jobId);

      this.emit('container-stopped', { jobId });
    } catch (err) {
      logger.error({ err, jobId }, 'failed to stop container');
    }
  }
  
  private async monitorContainers() {
    for (const [jobId, info] of this.containers) {
      if (info.status !== 'running') continue;

      try {
        const stats = await this.docker.getContainerStats(info.containerId);

        this.emit('container-stats', {
          jobId,
          stats,
          uptime: Date.now() - info.startTime,
          healthStatus: info.healthStatus
        });

        // check resource limits
        if (stats.memory > info.resources.memory * 1024 * 0.95) {
          logger.warn({ jobId, memory: stats.memory }, 'container near memory limit');
        }

        // run health check if configured
        if (info.healthCheck) {
          const interval = (info.healthCheck.interval || 30) * 1000;
          const lastCheck = info.lastHealthCheck || 0;

          if (Date.now() - lastCheck >= interval) {
            await this.runHealthCheck(jobId, info);
          }
        }
      } catch (err) {
        // container probably died
        logger.warn({ jobId, err }, 'failed to get container stats');
        info.status = 'stopped';
      }
    }
  }

  // run a health check on a container
  private async runHealthCheck(jobId: string, info: RunningContainer): Promise<void> {
    if (!info.healthCheck) return;

    const { type, port, path, command, timeout = 5, retries = 3 } = info.healthCheck;
    info.lastHealthCheck = Date.now();

    let healthy = false;

    try {
      if (type === 'exec' && command) {
        // run command inside container
        const result = await this.docker.execCommand(info.containerId, command);
        healthy = result.exitCode === 0;
        logger.debug({ jobId, exitCode: result.exitCode }, 'health check exec completed');
      } else if (type === 'http' && port) {
        // http health check - run curl inside container
        const checkPath = path || '/';
        const curlCmd = `curl -sf --max-time ${timeout} http://localhost:${port}${checkPath}`;
        const result = await this.docker.execCommand(info.containerId, curlCmd);
        healthy = result.exitCode === 0;
        logger.debug({ jobId, port, path: checkPath, exitCode: result.exitCode }, 'health check http completed');
      } else if (type === 'tcp' && port) {
        // tcp health check - use nc to check if port is open
        const ncCmd = `nc -z -w ${timeout} localhost ${port}`;
        const result = await this.docker.execCommand(info.containerId, ncCmd);
        healthy = result.exitCode === 0;
        logger.debug({ jobId, port, exitCode: result.exitCode }, 'health check tcp completed');
      }
    } catch (err) {
      logger.warn({ jobId, err }, 'health check error');
      healthy = false;
    }

    if (healthy) {
      // reset failures on success
      if (info.healthStatus !== 'healthy') {
        logger.info({ jobId }, 'container became healthy');
        this.emit('container-healthy', { jobId });
      }
      info.healthStatus = 'healthy';
      info.healthFailures = 0;
    } else {
      info.healthFailures++;

      if (info.healthFailures >= retries) {
        if (info.healthStatus !== 'unhealthy') {
          logger.warn({ jobId, failures: info.healthFailures }, 'container became unhealthy');
          this.emit('container-unhealthy', { jobId, failures: info.healthFailures });
        }
        info.healthStatus = 'unhealthy';
      }
    }
  }

  // get health status for a container
  getHealthStatus(jobId: string): { status: string; failures: number; lastCheck?: number } | undefined {
    const info = this.containers.get(jobId);
    if (!info) return undefined;

    return {
      status: info.healthStatus,
      failures: info.healthFailures,
      lastCheck: info.lastHealthCheck
    };
  }
  
  getRunningJobs(): string[] {
    return Array.from(this.containers.keys());
  }
  
  getContainerInfo(jobId: string): RunningContainer | undefined {
    return this.containers.get(jobId);
  }

  async execInContainer(jobId: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const container = this.containers.get(jobId);
    if (!container) {
      throw new Error('container not found');
    }

    if (container.status !== 'running') {
      throw new Error('container not running');
    }

    return await this.docker.execCommand(container.containerId, command);
  }

  async getContainerLogs(jobId: string, tail: number = 100): Promise<string> {
    const container = this.containers.get(jobId);
    if (!container) {
      throw new Error('container not found');
    }

    return await this.docker.getContainerLogs(container.containerId, tail);
  }

  // validate filepath to prevent path traversal attacks
  private validateFilepath(filepath: string): void {
    // block obvious traversal attempts
    if (filepath.includes('..') || filepath.includes('\0')) {
      throw new Error('invalid filepath - path traversal not allowed');
    }
    // must be absolute path inside container
    if (!filepath.startsWith('/')) {
      throw new Error('filepath must be absolute (start with /)');
    }
    // block access to sensitive paths
    const blockedPaths = ['/proc', '/sys', '/dev', '/etc/passwd', '/etc/shadow'];
    for (const blocked of blockedPaths) {
      if (filepath.startsWith(blocked)) {
        throw new Error('access to system paths not allowed');
      }
    }
  }

  async writeFile(jobId: string, filepath: string, content: string): Promise<void> {
    const container = this.containers.get(jobId);
    if (!container) {
      throw new Error('container not found');
    }

    this.validateFilepath(filepath);

    // write file using heredoc
    const command = `cat > ${filepath} << 'EOF'\n${content}\nEOF`;
    await this.docker.execCommand(container.containerId, command);
  }

  async readFile(jobId: string, filepath: string): Promise<string> {
    const container = this.containers.get(jobId);
    if (!container) {
      throw new Error('container not found');
    }

    this.validateFilepath(filepath);

    const result = await this.docker.execCommand(container.containerId, `cat ${filepath}`);
    return result.stdout;
  }
}