import Decimal from 'decimal.js';

interface ResourceUsage {
  cpuSeconds: number;
  memoryGBSeconds: number;
  storageGBHours: number;
  networkGBTransferred: number;
}

interface UsageRecord {
  jobId: string;
  nodeId: string;
  userId: string;
  startTime: Date;
  endTime: Date;
  usage: ResourceUsage;
  cost: Decimal;
}

export class UsageMeter {
  private records: Map<string, UsageRecord> = new Map();

  // track usage for a running job
  startMeter(jobId: string, nodeId: string, userId: string) {
    this.records.set(jobId, {
      jobId,
      nodeId,
      userId,
      startTime: new Date(),
      endTime: new Date(), // will update
      usage: {
        cpuSeconds: 0,
        memoryGBSeconds: 0,
        storageGBHours: 0,
        networkGBTransferred: 0
      },
      cost: new Decimal(0)
    });
  }

  // update usage metrics
  updateUsage(jobId: string, metrics: {
    cpu: number;      // cores in use
    memory: number;   // gb in use
    storage?: number; // gb stored
    network?: {       // bytes transferred
      rx: number;
      tx: number;
    };
  }) {
    const record = this.records.get(jobId);
    if (!record) return;

    const now = new Date();
    const elapsed = (now.getTime() - record.endTime.getTime()) / 1000; // seconds

    // accumulate usage
    record.usage.cpuSeconds += metrics.cpu * elapsed;
    record.usage.memoryGBSeconds += metrics.memory * elapsed;

    if (metrics.storage) {
      record.usage.storageGBHours += metrics.storage * (elapsed / 3600);
    }

    if (metrics.network) {
      const transferred = (metrics.network.rx + metrics.network.tx) / (1024 ** 3); // to gb
      record.usage.networkGBTransferred += transferred;
    }

    record.endTime = now;
  }

  // finalize and calculate total cost
  finalizeMeter(jobId: string, pricing: {
    cpuPerHour: number;
    memoryPerGBHour: number;
    storagePerGBHour: number;
    networkPerGB: number;
  }): UsageRecord | null {
    const record = this.records.get(jobId);
    if (!record) return null;

    // convert to hours for pricing
    const cpuHours = record.usage.cpuSeconds / 3600;
    const memoryGBHours = record.usage.memoryGBSeconds / 3600;

    // calculate costs
    const cpuCost = new Decimal(cpuHours).times(pricing.cpuPerHour);
    const memoryCost = new Decimal(memoryGBHours).times(pricing.memoryPerGBHour);
    const storageCost = new Decimal(record.usage.storageGBHours).times(pricing.storagePerGBHour);
    const networkCost = new Decimal(record.usage.networkGBTransferred).times(pricing.networkPerGB);

    record.cost = cpuCost.plus(memoryCost).plus(storageCost).plus(networkCost);

    // minimum charge 1 cent
    if (record.cost.lessThan(0.01)) {
      record.cost = new Decimal(0.01);
    }

    return record;
  }

  getRecord(jobId: string): UsageRecord | undefined {
    return this.records.get(jobId);
  }
}
