import { EventEmitter } from 'events';
import { ContainerManager } from './container-manager.js';
import { P2PNode } from '../lib/p2p.js';
import { logger } from '../lib/logger.js';
import { JobSpec } from '@kova/shared';
import { UsageMeter } from '@kova/payments';
import { ResourceLimitManager } from '../lib/resource-limits.js';

interface JobExecution {
  jobId: string;
  spec: JobSpec;
  status: 'received' | 'starting' | 'running' | 'completed' | 'failed';
  containerId?: string;
  startTime: number;
  endTime?: number;
  result?: any;
  error?: any;
  earnings?: number;
}

export class JobHandler extends EventEmitter {
  private containerManager: ContainerManager;
  private p2pNode: P2PNode;
  private activeJobs: Map<string, JobExecution> = new Map();
  private maxConcurrentJobs: number = 3;
  private usageMeter: UsageMeter;
  private limitManager: ResourceLimitManager;

  constructor(p2pNode: P2PNode, containerManager: ContainerManager, limitManager: ResourceLimitManager) {
    super();
    this.p2pNode = p2pNode;
    this.containerManager = containerManager;
    this.limitManager = limitManager;
    this.usageMeter = new UsageMeter();

    this.setupContainerListeners();
    this.setupP2PListeners();
  }

  private setupP2PListeners() {
    this.p2pNode.on('job-cancel', ({ jobId }) => {
      logger.info({ jobId }, 'received cancellation request');
      this.cancelJob(jobId);
    });
  }

  private setupContainerListeners() {
    this.containerManager.on('container-started', ({ jobId, containerId }) => {
      const job = this.activeJobs.get(jobId);
      if (job) {
        job.status = 'running';
        job.containerId = containerId;

        // start tracking usage
        this.usageMeter.startMeter(jobId, this.p2pNode.getPeerId(), job.spec.userId);

        this.emit('job-started', { jobId });
      }
    });

    // track resource usage as container runs
    this.containerManager.on('container-stats', ({ jobId, stats }) => {
      this.usageMeter.updateUsage(jobId, {
        cpu: stats.cpu / 100, // percentage to cores
        memory: stats.memory / 1024, // mb to gb
        network: stats.network
      });
    });

    this.containerManager.on('container-finished', ({ jobId, exitCode, logs }) => {
      const job = this.activeJobs.get(jobId);
      if (job) {
        job.status = exitCode === 0 ? 'completed' : 'failed';
        job.endTime = Date.now();
        job.result = { exitCode, logs };

        // release allocated resources
        this.limitManager.releaseResources(jobId, job.spec.resources);

        // finalize usage tracking and calculate actual cost
        const pricing = {
          cpuPerHour: 0.05,
          memoryPerGBHour: 0.02,
          storagePerGBHour: 0.001,
          networkPerGB: 0.01
        };

        const usageRecord = this.usageMeter.finalizeMeter(jobId, pricing);
        if (usageRecord) {
          job.earnings = usageRecord.cost.toNumber();
          logger.info({ jobId, usage: usageRecord.usage, cost: job.earnings }, 'usage calculated');
        } else {
          // fallback to simple time-based calc
          const runtime = (job.endTime - job.startTime) / 1000 / 60 / 60;
          const hourlyRate = job.spec.price || this.calculatePrice(job.spec);
          job.earnings = runtime * hourlyRate;
        }

        this.emit('job-completed', { jobId, earnings: job.earnings });

        // report back to orchestrator
        this.reportJobCompletion(jobId, job);
      }
    });

    this.containerManager.on('container-failed', ({ jobId, error }) => {
      const job = this.activeJobs.get(jobId);
      if (job) {
        job.status = 'failed';
        job.endTime = Date.now();
        job.error = error;

        // release resources
        this.limitManager.releaseResources(jobId, job.spec.resources);

        this.emit('job-failed', { jobId, error });
        this.reportJobCompletion(jobId, job);
      }
    });
  }
  
  async handleJob(jobSpec: JobSpec): Promise<boolean> {
    const runningJobs = Array.from(this.activeJobs.values())
      .filter(j => j.status === 'running').length;

    if (runningJobs >= this.maxConcurrentJobs) {
      logger.warn({ jobId: jobSpec.id }, 'at max capacity');
      return false;
    }

    // check against provider-configured limits
    if (!this.limitManager.canAcceptJob(jobSpec.resources)) {
      logger.warn({ jobId: jobSpec.id, required: jobSpec.resources }, 'exceeds provider limits');
      return false;
    }

    // allocate the resources
    if (!this.limitManager.allocateResources(jobSpec.id, jobSpec.resources)) {
      logger.warn({ jobId: jobSpec.id }, 'failed to allocate resources');
      return false;
    }

    const job: JobExecution = {
      jobId: jobSpec.id,
      spec: jobSpec,
      status: 'received',
      startTime: Date.now()
    };

    this.activeJobs.set(jobSpec.id, job);
    logger.info({ jobId: jobSpec.id }, 'accepted job');

    try {
      job.status = 'starting';
      await this.containerManager.runJob(jobSpec);
      return true;
    } catch (err) {
      logger.error({ err, jobId: jobSpec.id }, 'failed to start job');
      job.status = 'failed';
      job.error = err;
      job.endTime = Date.now();

      // release resources on failure
      this.limitManager.releaseResources(jobSpec.id, jobSpec.resources);
      return false;
    }
  }

  
  private calculatePrice(spec: JobSpec): number {
    // basic pricing if not specified
    return spec.resources.cpu * 0.05 + spec.resources.memory * 0.02;
  }
  
  private async reportJobCompletion(jobId: string, job: JobExecution) {
    const completionMessage = {
      type: 'job-completed',
      data: {
        jobId,
        success: job.status === 'completed',
        result: job.result,
        usage: {
          runtime: job.endTime ? (job.endTime - job.startTime) / 1000 : 0,
          cost: job.earnings || 0
        },
        nodeId: this.p2pNode.getPeerId()
      }
    };

    await this.p2pNode.sendToOrchestrator(completionMessage);

    logger.info({
      jobId,
      status: job.status,
      runtime: job.endTime ? (job.endTime - job.startTime) / 1000 : 0,
      earnings: job.earnings
    }, 'reported job completion to orchestrator');

    setTimeout(() => {
      this.activeJobs.delete(jobId);
    }, 60000);
  }
  
  getActiveJobs(): JobExecution[] {
    return Array.from(this.activeJobs.values());
  }
  
  getTotalEarnings(): number {
    let total = 0;
    for (const job of this.activeJobs.values()) {
      if (job.earnings) {
        total += job.earnings;
      }
    }
    return total;
  }

  async cancelJob(jobId: string): Promise<boolean> {
    const job = this.activeJobs.get(jobId);
    if (!job) {
      logger.warn({ jobId }, 'job not found for cancellation');
      return false;
    }

    if (job.status === 'completed' || job.status === 'failed') {
      logger.warn({ jobId }, 'job already finished, cannot cancel');
      return false;
    }

    try {
      // stop the container if running
      if (job.containerId) {
        await this.containerManager.stopContainer(job.containerId);
      }

      job.status = 'failed';
      job.endTime = Date.now();
      job.error = { message: 'cancelled by orchestrator' };

      logger.info({ jobId }, 'job cancelled successfully');

      // report cancellation
      await this.reportJobCompletion(jobId, job);

      return true;
    } catch (err) {
      logger.error({ err, jobId }, 'failed to cancel job');
      return false;
    }
  }
}