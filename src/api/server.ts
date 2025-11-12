import Fastify from 'fastify';
import cors from '@fastify/cors';
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

  constructor(containerManager: ContainerManager, deploymentExecutor?: DeploymentExecutor, port: number = 4002) {
    this.containerManager = containerManager;
    this.deploymentExecutor = deploymentExecutor;
    this.port = port;
  }

  async start() {
    this.app = Fastify({ logger: logger as any });

    await this.app.register(cors, {
      origin: true // allow all for now
    });

    // exec command in container
    this.app.post('/jobs/:jobId/exec', async (request: any, reply: any) => {
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

        const proxyReq = http.request(targetUrl, {
          method: request.method,
          headers: {
            ...request.headers,
            host: `${containerIP}:${targetPort}`
          }
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

    await this.app.listen({ port: this.port, host: '0.0.0.0' });
    logger.info({ port: this.port }, 'node api server started');
  }

  async stop() {
    if (this.app) {
      await this.app.close();
      logger.info('node api server stopped');
    }
  }
}
