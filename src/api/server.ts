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
