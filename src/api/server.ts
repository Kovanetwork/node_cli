import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { ContainerManager } from '../services/container-manager.js';
import { DeploymentExecutor } from '../services/deployment-executor.js';
import { logger } from '../lib/logger.js';
import Docker from 'dockerode';
import http from 'http';

export class NodeAPIServer {
  private app: any;
  private containerManager: ContainerManager;
  private deploymentExecutor?: DeploymentExecutor;
  private port: number;
  private authToken: string;

  constructor(containerManager: ContainerManager, deploymentExecutor?: DeploymentExecutor, port: number = 4002, accessToken?: string) {
    this.containerManager = containerManager;
    this.deploymentExecutor = deploymentExecutor;
    this.port = port;
    // token for authenticating requests from orchestrator
    this.authToken = accessToken || process.env.PROVIDER_TOKEN || '';
  }

  getAccessToken(): string {
    return this.authToken;
  }

  // verify request has valid auth token
  private verifyAuth(request: any, reply: any): boolean {
    // health check doesn't need auth
    if (request.url === '/health') {
      return true;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader) {
      reply.code(401).send({ error: 'authorization required' });
      return false;
    }

    const token = authHeader.replace('Bearer ', '');
    if (!this.authToken || token !== this.authToken) {
      logger.warn({ url: request.url }, 'invalid auth token');
      reply.code(401).send({ error: 'invalid token' });
      return false;
    }

    return true;
  }

  async start() {
    this.app = Fastify({ logger: logger as any });

    // cors config - restrict in production
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [];
    const isDev = process.env.NODE_ENV !== 'production';

    await this.app.register(cors, {
      origin: (origin: string, callback: any) => {
        if (!origin) {
          callback(null, true);
          return;
        }
        if (isDev && (origin.includes('localhost') || origin.includes('127.0.0.1'))) {
          callback(null, true);
          return;
        }
        if (allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('cors not allowed'), false);
        }
      }
    });

    // register websocket support for shell access
    await this.app.register(websocket);

    // exec command in container
    this.app.post('/jobs/:jobId/exec', async (request: any, reply: any) => {
      if (!this.verifyAuth(request, reply)) return;

      const { jobId } = request.params;
      const { command } = request.body;

      if (!command) {
        return reply.code(400).send({ error: 'command required' });
      }

      try {
        const result = await this.containerManager.execInContainer(jobId, command);
        return {
          success: true,
          ...result
        };
      } catch (err: any) {
        logger.error({ err, jobId, command }, 'exec failed');
        return reply.code(500).send({
          error: 'exec failed',
          message: err.message
        });
      }
    });

    // get container logs
    this.app.get('/jobs/:jobId/logs', async (request: any, reply: any) => {
      if (!this.verifyAuth(request, reply)) return;

      const { jobId } = request.params;
      const tail = parseInt(request.query.tail || '100');

      try {
        const logs = await this.containerManager.getContainerLogs(jobId, tail);
        return {
          success: true,
          logs
        };
      } catch (err: any) {
        logger.error({ err, jobId }, 'failed to get logs');
        return reply.code(500).send({
          error: 'failed to get logs',
          message: err.message
        });
      }
    });

    // write file to container
    this.app.post('/jobs/:jobId/files', async (request: any, reply: any) => {
      if (!this.verifyAuth(request, reply)) return;

      const { jobId } = request.params;
      const { filepath, content } = request.body;

      if (!filepath || content === undefined) {
        return reply.code(400).send({ error: 'filepath and content required' });
      }

      try {
        await this.containerManager.writeFile(jobId, filepath, content);
        return { success: true };
      } catch (err: any) {
        logger.error({ err, jobId, filepath }, 'failed to write file');
        return reply.code(500).send({
          error: 'failed to write file',
          message: err.message
        });
      }
    });

    // read file from container
    this.app.get('/jobs/:jobId/files/*', async (request: any, reply: any) => {
      if (!this.verifyAuth(request, reply)) return;

      const { jobId } = request.params;
      const filepath = (request.params as any)['*'];

      try {
        const content = await this.containerManager.readFile(jobId, filepath);
        return {
          success: true,
          filepath,
          content
        };
      } catch (err: any) {
        logger.error({ err, jobId, filepath }, 'failed to read file');
        return reply.code(500).send({
          error: 'failed to read file',
          message: err.message
        });
      }
    });

    // proxy http requests to deployment containers
    this.app.all('/deployments/:deploymentId/proxy', async (request: any, reply: any) => {
      if (!this.verifyAuth(request, reply)) return;

      const { deploymentId } = request.params;
      const targetPort = parseInt(request.headers['x-target-port'] || '80');

      try {
        // get container name from deployment id
        // containers are named: kova-{deploymentId}-{serviceName}
        // for now, assume first service (need to parse sdl for multi-service)
        const containerName = `kova-${deploymentId}`;

        // containers on same docker network can access each other by name
        // or we can get container IP
        const docker = new Docker();

        const containers = await docker.listContainers({
          filters: { label: [`kova.deployment=${deploymentId}`] }
        });

        if (containers.length === 0) {
          return reply.code(404).send({ error: 'deployment container not found or not running' });
        }

        // get container IP from docker network
        const containerData = await docker.getContainer(containers[0].Id).inspect();
        const networks = containerData.NetworkSettings.Networks;
        const networkName = Object.keys(networks)[0];
        const containerIP = networks[networkName]?.IPAddress;

        if (!containerIP) {
          return reply.code(502).send({ error: 'container has no network ip' });
        }

        // proxy to container
        const targetUrl = `http://${containerIP}:${targetPort}${request.url.replace(`/deployments/${deploymentId}/proxy`, '')}`;

        logger.info({ targetUrl, deploymentId }, 'proxying request');

        // strip sensitive headers before forwarding to customer container
        const forwardHeaders = { ...request.headers };
        delete forwardHeaders['authorization'];
        delete forwardHeaders['cookie'];
        delete forwardHeaders['x-target-port'];
        forwardHeaders.host = `${containerIP}:${targetPort}`;

        const proxyReq = http.request(targetUrl, {
          method: request.method,
          headers: forwardHeaders
        }, (proxyRes: any) => {
          reply.code(proxyRes.statusCode);

          // copy all headers from container response
          Object.keys(proxyRes.headers).forEach(key => {
            reply.header(key, proxyRes.headers[key]);
          });

          // stream response directly
          reply.send(proxyRes);
        });

        proxyReq.on('error', (err: any) => {
          logger.error({ err, targetUrl }, 'proxy request failed');
          reply.code(502).send({ error: 'proxy failed', message: err.message });
        });

        if (request.body) {
          proxyReq.write(JSON.stringify(request.body));
        }
        proxyReq.end();

        return reply;
      } catch (err: any) {
        logger.error({ err, deploymentId }, 'proxy setup failed');
        return reply.code(502).send({ error: 'proxy failed', message: err.message });
      }
    });

    // update deployment files
    this.app.post('/deployments/:deploymentId/services/:serviceName/update-files', async (request: any, reply: any) => {
      if (!this.verifyAuth(request, reply)) return;

      const { deploymentId, serviceName } = request.params;

      if (!this.deploymentExecutor) {
        return reply.code(503).send({ error: 'deployment executor not available' });
      }

      try {
        await this.deploymentExecutor.updateDeploymentFiles(deploymentId, serviceName);
        return {
          success: true,
          message: 'files updated and deployment restarted'
        };
      } catch (err: any) {
        logger.error({ err, deploymentId, serviceName }, 'failed to update deployment files');
        return reply.code(500).send({
          error: 'failed to update files',
          message: err.message
        });
      }
    });

    // health check
    this.app.get('/health', async () => {
      return {
        status: 'ok',
        runningJobs: this.containerManager.getRunningJobs().length
      };
    });

    // websocket shell endpoint for direct access (http fallback when p2p unavailable)
    this.app.get('/deployments/:deploymentId/shell', { websocket: true }, async (connection: any, req: any) => {
      // verify auth token from query param or header
      const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
      if (!this.authToken) {
        logger.warn({ deploymentId: req.params.deploymentId }, 'shell access denied - no auth token configured on provider');
        connection.socket.close(1008, 'provider auth not configured');
        return;
      }
      if (!token || token !== this.authToken) {
        logger.warn({ deploymentId: req.params.deploymentId, hasToken: !!token, tokenLen: token?.length }, 'shell access denied - token mismatch');
        connection.socket.close(1008, 'unauthorized - invalid access token');
        return;
      }

      const deploymentId = req.params.deploymentId;
      const serviceName = req.query.service || 'web';

      logger.info({ deploymentId, serviceName }, 'direct shell websocket connection');

      if (!this.deploymentExecutor) {
        connection.socket.close(1008, 'deployment executor not available');
        return;
      }

      let sessionId: string | null = null;

      connection.socket.on('message', async (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());

          if (message.type === 'init') {
            // generate session id and start shell
            sessionId = `shell-${deploymentId}-${Date.now()}`;

            const result = await this.deploymentExecutor!.startShellSession(
              sessionId,
              deploymentId,
              serviceName,
              (output: string) => {
                // send output back to client
                connection.socket.send(JSON.stringify({ type: 'output', data: output }));
              }
            );

            if (result.success) {
              connection.socket.send(JSON.stringify({ type: 'ready', sessionId }));
            } else {
              connection.socket.send(JSON.stringify({ type: 'error', message: result.error || 'failed to start shell session' }));
              connection.socket.close(1008, result.error || 'shell start failed');
            }
          } else if (message.type === 'input' && sessionId) {
            this.deploymentExecutor!.sendShellInput(sessionId, message.data);
          } else if (message.type === 'resize' && sessionId) {
            this.deploymentExecutor!.resizeShell(sessionId, message.cols, message.rows);
          }
        } catch (err) {
          logger.error({ err, deploymentId }, 'shell message error');
          connection.socket.send(JSON.stringify({ type: 'error', message: 'command failed' }));
        }
      });

      connection.socket.on('close', () => {
        if (sessionId && this.deploymentExecutor) {
          this.deploymentExecutor.closeShellSession(sessionId);
        }
        logger.info({ deploymentId }, 'direct shell websocket closed');
      });
    });

    // container stats (cpu, memory, network) for a deployment
    this.app.get('/deployments/:deploymentId/stats', async (request: any, reply: any) => {
      if (!this.verifyAuth(request, reply)) return;
      const { deploymentId } = request.params;

      try {
        const stats = await this.deploymentExecutor!.getDeploymentStats(deploymentId);
        return stats;
      } catch (err: any) {
        logger.error({ err, deploymentId }, 'failed to get deployment stats');
        return reply.code(500).send({ error: 'failed to get stats', message: err.message });
      }
    });

    // container status (running, exited, etc) for a deployment
    this.app.get('/deployments/:deploymentId/status', async (request: any, reply: any) => {
      if (!this.verifyAuth(request, reply)) return;
      const { deploymentId } = request.params;

      try {
        const status = await this.deploymentExecutor!.getDeploymentStatus(deploymentId);
        return status;
      } catch (err: any) {
        logger.error({ err, deploymentId }, 'failed to get deployment status');
        return reply.code(500).send({ error: 'failed to get status', message: err.message });
      }
    });

    // container events (create, start, stop, health) for a deployment
    this.app.get('/deployments/:deploymentId/events', async (request: any, reply: any) => {
      if (!this.verifyAuth(request, reply)) return;
      const { deploymentId } = request.params;

      if (!this.deploymentExecutor) {
        return reply.code(503).send({ error: 'deployment executor not available' });
      }

      try {
        const events = await this.deploymentExecutor.getContainerEvents(deploymentId);
        if (events.error) {
          return reply.code(404).send(events);
        }
        return events;
      } catch (err: any) {
        logger.error({ err, deploymentId }, 'failed to get container events');
        return reply.code(500).send({ error: 'failed to get events', message: err.message });
      }
    });

    // stream stats via websocket for live metrics
    this.app.get('/deployments/:deploymentId/stats/stream', { websocket: true }, async (connection: any, req: any) => {
      const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
      if (!this.authToken || !token || token !== this.authToken) {
        connection.socket.close(1008, 'unauthorized');
        return;
      }

      const { deploymentId } = req.params;
      const intervalMs = Math.max(parseInt(req.query.interval) || 3000, 2000); // min 2s
      let active = true;

      const sendStats = async () => {
        if (!active) return;
        try {
          const stats = await this.deploymentExecutor!.getDeploymentStats(deploymentId);
          if (active && connection.socket.readyState === 1) {
            connection.socket.send(JSON.stringify(stats));
          }
        } catch (err: any) {
          if (active && connection.socket.readyState === 1) {
            connection.socket.send(JSON.stringify({ error: err.message }));
          }
        }
      };

      // send initial stats immediately
      await sendStats();
      const interval = setInterval(sendStats, intervalMs);

      connection.socket.on('close', () => {
        active = false;
        clearInterval(interval);
      });

      connection.socket.on('error', () => {
        active = false;
        clearInterval(interval);
      });
    });

    // browse files inside a deployment container
    this.app.get('/deployments/:deploymentId/services/:serviceName/browse', async (request: any, reply: any) => {
      if (!this.verifyAuth(request, reply)) return;
      const { deploymentId, serviceName } = request.params;
      const dirPath = request.query.path || '/';

      if (!this.deploymentExecutor) {
        return reply.code(503).send({ error: 'deployment executor not available' });
      }

      try {
        const result = await this.deploymentExecutor.browseFiles(deploymentId, serviceName, dirPath);
        if (result.error) {
          return reply.code(404).send(result);
        }
        return result;
      } catch (err: any) {
        return reply.code(500).send({ error: 'failed to browse files', message: err.message });
      }
    });

    // read a file from inside a deployment container
    this.app.get('/deployments/:deploymentId/services/:serviceName/cat/*', async (request: any, reply: any) => {
      if (!this.verifyAuth(request, reply)) return;
      const { deploymentId, serviceName } = request.params;
      const filePath = '/' + ((request.params as any)['*'] || '');

      if (!this.deploymentExecutor) {
        return reply.code(503).send({ error: 'deployment executor not available' });
      }

      try {
        const result = await this.deploymentExecutor.readContainerFile(deploymentId, serviceName, filePath);
        if (result.error) {
          return reply.code(result.error === 'file not found' ? 404 : 500).send(result);
        }
        return result;
      } catch (err: any) {
        return reply.code(500).send({ error: 'failed to read file', message: err.message });
      }
    });

    // upload a file into a deployment container
    this.app.post('/deployments/:deploymentId/services/:serviceName/upload', async (request: any, reply: any) => {
      if (!this.verifyAuth(request, reply)) return;
      const { deploymentId, serviceName } = request.params;
      const { path: filePath, content, encoding } = request.body || {};

      if (!filePath || content === undefined) {
        return reply.code(400).send({ error: 'path and content required' });
      }

      if (!this.deploymentExecutor) {
        return reply.code(503).send({ error: 'deployment executor not available' });
      }

      try {
        const result = await this.deploymentExecutor.uploadFileToContainer(
          deploymentId, serviceName, filePath, content, encoding || 'utf8'
        );
        if (!result.success) {
          return reply.code(400).send(result);
        }
        return result;
      } catch (err: any) {
        return reply.code(500).send({ error: 'failed to upload file', message: err.message });
      }
    });

    // restart all containers in a deployment
    this.app.post('/deployments/:deploymentId/restart', async (request: any, reply: any) => {
      if (!this.verifyAuth(request, reply)) return;
      const { deploymentId } = request.params;

      if (!this.deploymentExecutor) {
        return reply.code(503).send({ error: 'deployment executor not available' });
      }

      try {
        const services = await this.deploymentExecutor.restartDeployment(deploymentId);
        return { restarted: true, services };
      } catch (err: any) {
        logger.error({ err, deploymentId }, 'failed to restart deployment');
        return reply.code(500).send({ error: 'restart failed', message: err.message });
      }
    });

    // create a volume snapshot for a service
    this.app.post('/deployments/:deploymentId/snapshots', async (request: any, reply: any) => {
      if (!this.verifyAuth(request, reply)) return;
      const { deploymentId } = request.params;
      const { serviceName, snapshotId } = request.body || {};

      if (!serviceName || !snapshotId) {
        return reply.code(400).send({ error: 'serviceName and snapshotId required' });
      }

      if (!this.deploymentExecutor) {
        return reply.code(503).send({ error: 'deployment executor not available' });
      }

      try {
        const result = await this.deploymentExecutor.createVolumeSnapshot(deploymentId, serviceName, snapshotId);
        return {
          snapshotId,
          volumeName: result.volumeName,
          sizeBytes: result.sizeBytes,
          snapshotKey: result.snapshotKey,
          state: 'ready'
        };
      } catch (err: any) {
        logger.error({ err, deploymentId, serviceName, snapshotId }, 'failed to create snapshot');
        return reply.code(500).send({ error: 'snapshot failed', message: err.message });
      }
    });

    // restore a volume snapshot
    this.app.post('/deployments/:deploymentId/snapshots/:snapshotId/restore', async (request: any, reply: any) => {
      if (!this.verifyAuth(request, reply)) return;
      const { deploymentId, snapshotId } = request.params;
      const { serviceName, snapshotKey } = request.body || {};

      if (!serviceName || !snapshotKey) {
        return reply.code(400).send({ error: 'serviceName and snapshotKey required' });
      }

      if (!this.deploymentExecutor) {
        return reply.code(503).send({ error: 'deployment executor not available' });
      }

      try {
        await this.deploymentExecutor.restoreVolumeSnapshot(deploymentId, serviceName, snapshotKey);
        return { restored: true };
      } catch (err: any) {
        logger.error({ err, deploymentId, snapshotId }, 'failed to restore snapshot');
        return reply.code(500).send({ error: 'restore failed', message: err.message });
      }
    });

    // scale container resources (stop, remove, recreate with new limits)
    this.app.put('/deployments/:deploymentId/scale', async (request: any, reply: any) => {
      if (!this.verifyAuth(request, reply)) return;
      const { deploymentId } = request.params;
      const { serviceName, cpu, memory } = request.body || {};

      if (!serviceName) {
        return reply.code(400).send({ error: 'serviceName required' });
      }

      if (!this.deploymentExecutor) {
        return reply.code(503).send({ error: 'deployment executor not available' });
      }

      const deployment = this.deploymentExecutor.getDeployment(deploymentId);
      if (!deployment) {
        return reply.code(404).send({ error: 'deployment not found' });
      }

      const containerId = deployment.containers.get(serviceName);
      if (!containerId) {
        return reply.code(404).send({ error: `service ${serviceName} not found in deployment` });
      }

      try {
        const docker = new Docker();
        const container = docker.getContainer(containerId);
        const info = await container.inspect();

        // stop and remove old container
        try { await container.stop({ t: 10 }); } catch { /* may already be stopped */ }
        await container.remove();

        // compute new resource limits
        const newMemory = memory
          ? this.parseMemoryString(memory)
          : (info.HostConfig.Memory || 4 * 1024 * 1024 * 1024);
        const newCpu = cpu || (info.HostConfig.CpuQuota ? info.HostConfig.CpuQuota / 100000 : 4);

        // recreate with same config but new resource limits
        const newConfig: any = {
          name: info.Name.startsWith('/') ? info.Name.slice(1) : info.Name,
          Image: info.Config.Image,
          Env: info.Config.Env || [],
          Cmd: info.Config.Cmd || undefined,
          Entrypoint: info.Config.Entrypoint || undefined,
          ExposedPorts: info.Config.ExposedPorts || {},
          Labels: info.Config.Labels || {},
          HostConfig: {
            ...info.HostConfig,
            Memory: newMemory,
            MemorySwap: newMemory,
            CpuPeriod: 100000,
            CpuQuota: Math.floor(newCpu * 100000),
          }
        };

        const newContainer = await docker.createContainer(newConfig);
        await newContainer.start();

        // update container id in executor
        deployment.containers.set(serviceName, newContainer.id);

        logger.info({ deploymentId, serviceName, cpu: newCpu, memory: newMemory }, 'container scaled');
        return { scaled: true, serviceName };
      } catch (err: any) {
        logger.error({ err, deploymentId, serviceName }, 'failed to scale container');
        return reply.code(500).send({ error: 'scale failed', message: err.message });
      }
    });

    await this.app.listen({ port: this.port, host: '0.0.0.0' });
    logger.info({ port: this.port }, 'node api server started');
  }

  // parse memory string like "512Mi", "2Gi" into bytes
  private parseMemoryString(size: string): number {
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

  async stop() {
    if (this.app) {
      await this.app.close();
      logger.info('node api server stopped');
    }
  }
}
