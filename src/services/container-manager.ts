import { DockerManager } from '../lib/docker.js';
import { logger } from '../lib/logger.js';
import { JobSpec } from '../lib/types.js';
import { EventEmitter } from 'events';

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
      
      // track it
      this.containers.set(job.id, {
        jobId: job.id,
        containerId,
        startTime: Date.now(),
        resources: job.resources,
        status: 'running'
      });
      
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
          uptime: Date.now() - info.startTime
        });
        
        // check resource limits
        if (stats.memory > info.resources.memory * 1024 * 0.95) {
          logger.warn({ jobId, memory: stats.memory }, 'container near memory limit');
        }
      } catch (err) {
        // container probably died
        logger.warn({ jobId, err }, 'failed to get container stats');
        info.status = 'stopped';
      }
    }
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

  async writeFile(jobId: string, filepath: string, content: string): Promise<void> {
    const container = this.containers.get(jobId);
    if (!container) {
      throw new Error('container not found');
    }

    // write file by executing echo command
    const escapedContent = content.replace(/'/g, "'\\''");
    const command = `cat > ${filepath} << 'EOF'\n${content}\nEOF`;

    await this.docker.execCommand(container.containerId, command);
  }

  async readFile(jobId: string, filepath: string): Promise<string> {
    const container = this.containers.get(jobId);
    if (!container) {
      throw new Error('container not found');
    }

    const result = await this.docker.execCommand(container.containerId, `cat ${filepath}`);
    return result.stdout;
  }
}