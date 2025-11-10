import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ContainerManager } from '../services/container-manager.js';
import { logger } from '../lib/logger.js';

export class NodeAPIServer {
  private app: any;
  private containerManager: ContainerManager;
  private port: number;

  constructor(containerManager: ContainerManager, port: number = 4002) {
    this.containerManager = containerManager;
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

      // get container for this deployment
      const containerInfo = this.containerManager.getContainerInfo(deploymentId);
      if (!containerInfo) {
        return reply.code(404).send({ error: 'deployment not found' });
      }

      try {
        // forward to container via docker network
        // containers are accessible via their name on docker network
        const containerHost = `172.17.0.1`; // docker host from inside container
        const targetUrl = `http://${containerHost}:${targetPort}${request.url.replace(`/deployments/${deploymentId}/proxy`, '')}`;

        // simple proxy - just exec curl inside the container
        const curlCmd = `curl -X ${request.method} "${targetUrl}" ${
          request.body ? `-d '${JSON.stringify(request.body)}'` : ''
        }`;

        const result = await this.containerManager.execInContainer(deploymentId, curlCmd);

        reply.header('Content-Type', 'text/html');
        return reply.send(result.stdout);
      } catch (err: any) {
        logger.error({ err, deploymentId }, 'proxy failed');
        return reply.code(502).send({ error: 'proxy failed', message: err.message });
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
