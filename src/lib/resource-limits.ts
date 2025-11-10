import si from 'systeminformation';
import { logger } from './logger.js';

export interface ResourceLimits {
  cpu: number;
  memory: number;
  disk: number;
}

export interface ResourceUsage {
  cpu: number;
  memory: number;
  disk: number;
}

export class ResourceLimitManager {
  private limits: ResourceLimits;
  private currentUsage: ResourceUsage = { cpu: 0, memory: 0, disk: 0 };

  constructor(limits: ResourceLimits) {
    this.limits = limits;
  }

  static async createFromOptions(options: { maxCpu?: string; maxMemory?: string; maxDisk?: string }): Promise<ResourceLimitManager> {
    const [cpu, mem] = await Promise.all([
      si.cpu(),
      si.mem()
    ]);

    const totalCpu = cpu.cores;
    const totalMemoryGB = mem.total / (1024 ** 3);

    // use defaults if not specified
    const limits: ResourceLimits = {
      cpu: options.maxCpu ? parseFloat(options.maxCpu) : totalCpu,
      memory: options.maxMemory ? parseFloat(options.maxMemory) : Math.floor(totalMemoryGB * 0.8),
      disk: options.maxDisk ? parseFloat(options.maxDisk) : 100
    };

    // don't let them set more than they have
    if (limits.cpu > totalCpu) {
      logger.warn({ requested: limits.cpu, available: totalCpu }, 'capping cpu to system max');
      limits.cpu = totalCpu;
    }

    if (limits.memory > totalMemoryGB) {
      logger.warn({ requested: limits.memory, available: totalMemoryGB }, 'capping memory to system max');
      limits.memory = Math.floor(totalMemoryGB);
    }

    logger.info({ limits }, 'resource limits set');
    return new ResourceLimitManager(limits);
  }

  getLimits(): ResourceLimits {
    return { ...this.limits };
  }

  getAvailableResources(): ResourceLimits {
    return {
      cpu: Math.max(0, this.limits.cpu - this.currentUsage.cpu),
      memory: Math.max(0, this.limits.memory - this.currentUsage.memory),
      disk: Math.max(0, this.limits.disk - this.currentUsage.disk)
    };
  }

  canAcceptJob(required: { cpu: number; memory: number; disk?: number }): boolean {
    const available = this.getAvailableResources();

    const canAccept =
      required.cpu <= available.cpu &&
      required.memory <= available.memory &&
      (!required.disk || required.disk <= available.disk);

    if (!canAccept) {
      logger.warn({ required, available }, 'not enough resources');
    }

    return canAccept;
  }

  allocateResources(jobId: string, resources: { cpu: number; memory: number; disk?: number }): boolean {
    if (!this.canAcceptJob(resources)) {
      return false;
    }

    this.currentUsage.cpu += resources.cpu;
    this.currentUsage.memory += resources.memory;
    if (resources.disk) {
      this.currentUsage.disk += resources.disk;
    }

    logger.info({ jobId, resources }, 'allocated resources');
    return true;
  }

  releaseResources(jobId: string, resources: { cpu: number; memory: number; disk?: number }): void {
    this.currentUsage.cpu = Math.max(0, this.currentUsage.cpu - resources.cpu);
    this.currentUsage.memory = Math.max(0, this.currentUsage.memory - resources.memory);
    if (resources.disk) {
      this.currentUsage.disk = Math.max(0, this.currentUsage.disk - resources.disk);
    }

    logger.info({ jobId }, 'released resources');
  }

  getCurrentUsage(): ResourceUsage {
    return { ...this.currentUsage };
  }

  getUsagePercentage(): { cpu: number; memory: number; disk: number } {
    return {
      cpu: (this.currentUsage.cpu / this.limits.cpu) * 100,
      memory: (this.currentUsage.memory / this.limits.memory) * 100,
      disk: (this.currentUsage.disk / this.limits.disk) * 100
    };
  }
}
