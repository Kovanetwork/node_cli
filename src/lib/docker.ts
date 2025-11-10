import Docker from 'dockerode';
import { logger } from './logger.js';
import { Readable } from 'stream';

export class DockerManager {
  private docker: Docker;
  
  constructor() {
    // use socket if on linux, named pipe on windows
    this.docker = new Docker({
      socketPath: process.platform === 'win32' 
        ? '//./pipe/docker_engine' 
        : '/var/run/docker.sock'
    });
  }
  
  async checkDocker(): Promise<boolean> {
    try {
      await this.docker.ping();
      const info = await this.docker.info();
      logger.debug({ 
        containers: info.Containers,
        images: info.Images,
        version: info.ServerVersion 
      }, 'docker is running');
      return true;
    } catch (err) {
      logger.error({ err }, 'docker not available');
      return false;
    }
  }
  
  async pullImage(image: string) {
    // check if we already have it
    try {
      await this.docker.getImage(image).inspect();
      logger.debug({ image }, 'image already exists');
      return;
    } catch (err) {
      // need to pull
    }
    
    logger.info({ image }, 'pulling docker image');
    
    const stream = await this.docker.pull(image);
    
    // wait for pull to complete
    return new Promise((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err: any, output: any) => {
        if (err) {
          logger.error({ err, image }, 'failed to pull image');
          reject(err);
        } else {
          logger.info({ image }, 'image pulled successfully');
          resolve(output);
        }
      });
    });
  }
  
  async createContainer(spec: any) {
    // Create isolated network for this container (prevents inter-container communication)
    const networkName = `kova-net-${spec.jobId}`;
    let network;
    try {
      network = await this.docker.createNetwork({
        Name: networkName,
        Driver: 'bridge',
        Internal: false, // needs internet access
        EnableIPv6: false,
        Labels: {
          'kova.job.id': spec.jobId,
          'kova.isolated': 'true'
        }
      });
      logger.debug({ networkName }, 'created isolated network for job');
    } catch (err) {
      logger.error({ err, jobId: spec.jobId }, 'failed to create isolated network');
    }

    // check if there's a startup script in env vars
    let containerCmd = spec.cmd;
    let envVars = spec.env || [];

    // handle both array and object formats for env
    if (typeof spec.env === 'object' && !Array.isArray(spec.env)) {
      // convert object to array of "KEY=VALUE" strings
      envVars = Object.entries(spec.env).map(([k, v]) => `${k}=${v}`);

      // check for startup script
      if (spec.env.KOVA_STARTUP_SCRIPT) {
        const script = Buffer.from(spec.env.KOVA_STARTUP_SCRIPT, 'base64').toString('utf-8');
        containerCmd = ['/bin/sh', '-c', script];
      }
    } else if (Array.isArray(spec.env)) {
      const startupScript = spec.env.find((e: string) => e.startsWith('KOVA_STARTUP_SCRIPT='));
      if (startupScript) {
        const scriptB64 = startupScript.split('=')[1];
        const script = Buffer.from(scriptB64, 'base64').toString('utf-8');
        containerCmd = ['/bin/sh', '-c', script];
      }
    }

    const container = await this.docker.createContainer({
      Image: spec.image || 'alpine:latest',
      name: `kova-${spec.jobId}`,
      // execute startup script or default command
      Cmd: containerCmd || ['/bin/sh', '-c', 'echo "no command provided" && sleep 60'],
      Tty: false,
      OpenStdin: false,
      HostConfig: {
        Memory: spec.memory * 1024 * 1024, // mb to bytes
        NanoCpus: spec.cpus * 1000000000,  // cpu cores to nanocpus
        ReadonlyRootfs: false, // allow writing for interactive use
        // mount tmpfs for /app to allow file creation
        Tmpfs: {
          '/app': 'rw,size=100m,mode=1777'
        },
        CapDrop: ['ALL'],
        CapAdd: [], // NO capabilities
        SecurityOpt: ['no-new-privileges'],
        // disk quota if supported
        StorageOpt: spec.disk ? { size: `${spec.disk}G` } : undefined,
        // NETWORK ISOLATION: Each container gets its own network
        NetworkMode: network ? networkName : 'none',
        // auto remove after exit
        AutoRemove: false,
        // Prevent container from accessing host services
        ExtraHosts: [],
        Dns: ['8.8.8.8', '1.1.1.1']
      },
      Env: envVars,
      WorkingDir: '/app',
      // labels for tracking
      Labels: {
        'kova.job.id': spec.jobId,
        'kova.job.user': spec.userId || 'unknown',
        'kova.version': '0.0.1'
      }
    });
    
    await container.start();
    return container;
  }
  
  async getContainerStats(containerId: string) {
    const container = this.docker.getContainer(containerId);

    // check if container exists first
    try {
      await container.inspect();
    } catch (err) {
      throw new Error('container not found or removed');
    }

    const stream = await container.stats({ stream: false });

    // calc actual usage with safe access
    const memUsage = stream.memory_stats?.usage ? stream.memory_stats.usage / (1024 * 1024) : 0; // mb

    let cpuPercent = 0;
    if (stream.cpu_stats?.cpu_usage && stream.precpu_stats?.cpu_usage) {
      const cpuDelta = stream.cpu_stats.cpu_usage.total_usage -
                       stream.precpu_stats.cpu_usage.total_usage;
      const systemDelta = stream.cpu_stats.system_cpu_usage -
                          stream.precpu_stats.system_cpu_usage;
      if (systemDelta > 0) {
        cpuPercent = (cpuDelta / systemDelta) *
                     (stream.cpu_stats.online_cpus || 1) * 100;
      }
    }

    return {
      memory: Math.round(memUsage),
      cpu: Math.round(cpuPercent * 100) / 100,
      network: {
        rx: stream.networks?.eth0?.rx_bytes || 0,
        tx: stream.networks?.eth0?.tx_bytes || 0
      }
    };
  }
  
  async cleanupContainer(containerId: string) {
    try {
      const container = this.docker.getContainer(containerId);

      // get container info to find its network
      const info = await container.inspect();
      const jobId = info.Config.Labels?.['kova.job.id'];

      // check if its still running
      if (info.State.Running) {
        await container.stop({ t: 10 }); // 10 sec grace
      }

      await container.remove();
      logger.debug({ containerId }, 'container cleaned up');

      // Clean up isolated network
      if (jobId) {
        const networkName = `kova-net-${jobId}`;
        try {
          const network = this.docker.getNetwork(networkName);
          await network.remove();
          logger.debug({ networkName }, 'isolated network cleaned up');
        } catch (err: any) {
          // network might not exist or already removed
          if (err.statusCode !== 404) {
            logger.debug({ err, networkName }, 'network cleanup failed');
          }
        }
      }
    } catch (err: any) {
      // probably already gone
      if (err.statusCode !== 404) {
        logger.debug({ err, containerId }, 'cleanup failed');
      }
    }
  }
  
  async listKovaContainers() {
    const containers = await this.docker.listContainers({
      all: true,
      filters: {
        label: ['kova.job.id']
      }
    });

    return containers.map(c => ({
      id: c.Id,
      jobId: c.Labels['kova.job.id'],
      state: c.State,
      status: c.Status,
      created: new Date(c.Created * 1000)
    }));
  }

  async execCommand(containerId: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const container = this.docker.getContainer(containerId);

    const exec = await container.exec({
      Cmd: ['/bin/sh', '-c', command],
      AttachStdout: true,
      AttachStderr: true
    });

    return new Promise((resolve, reject) => {
      exec.start({ hijack: true, stdin: false }, (err: any, stream: any) => {
        if (err) {
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';

        const { Transform } = require('stream');
        const demuxStream = new Transform({
          transform(chunk: any, encoding: any, callback: any) {
            // docker multiplexes stdout/stderr
            // first byte: 1=stdout, 2=stderr
            const type = chunk[0];
            const data = chunk.slice(8).toString();

            if (type === 1) {
              stdout += data;
            } else if (type === 2) {
              stderr += data;
            }
            callback();
          }
        });

        stream.pipe(demuxStream);

        stream.on('end', async () => {
          const result = await exec.inspect();
          resolve({
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exitCode: result.ExitCode || 0
          });
        });

        stream.on('error', reject);
      });
    });
  }

  async getContainerLogs(containerId: string, tail: number = 100): Promise<string> {
    const container = this.docker.getContainer(containerId);

    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: true
    });

    return logs.toString();
  }

  async streamContainerLogs(containerId: string, onData: (data: string) => void): Promise<() => void> {
    const container = this.docker.getContainer(containerId);

    const stream = await container.logs({
      stdout: true,
      stderr: true,
      follow: true,
      timestamps: true
    });

    stream.on('data', (chunk: Buffer) => {
      onData(chunk.toString());
    });

    return () => {
      if (stream && typeof (stream as any).destroy === 'function') {
        (stream as any).destroy();
      }
    };
  }
}