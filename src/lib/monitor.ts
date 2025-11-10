import si from 'systeminformation';
import { logger } from './logger.js';

export class ResourceMonitor {
  private interval: NodeJS.Timeout | null = null;
  private lastStats: any = {};
  
  async start() {
    // check resources every 30 seconds
    this.interval = setInterval(() => {
      this.collectStats();
    }, 30000);
    
    // get initial stats
    await this.collectStats();
  }
  
  async stop() {
    if (this.interval) {
      clearInterval(this.interval);
    }
  }
  
  private async collectStats() {
    try {
      const [cpu, mem, disk, net] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.fsSize(),
        si.networkStats()
      ]);
      
      this.lastStats = {
        cpu: {
          usage: cpu.currentLoad,
          cores: cpu.cpus.length,
          perCore: cpu.cpus.map(c => c.load)
        },
        memory: {
          total: Math.round((mem.total / (1024 ** 3)) * 10) / 10, // gb with 1 decimal
          available: Math.round((mem.available / (1024 ** 3)) * 10) / 10,
          used: Math.round(((mem.total - mem.available) / (1024 ** 3)) * 10) / 10
        },
        disk: disk.map(d => ({
          fs: d.fs,
          total: Math.round((d.size / (1024 ** 3)) * 10) / 10, // gb with 1 decimal
          available: Math.round((d.available / (1024 ** 3)) * 10) / 10
        })),
        network: {
          rx: net[0]?.rx_sec || 0,
          tx: net[0]?.tx_sec || 0
        },
        timestamp: Date.now()
      };
      
      logger.debug(this.lastStats, 'collected system stats');
    } catch (err) {
      logger.error({ err }, 'failed to collect stats');
    }
  }
  
  async getAvailableResources() {
    // get fresh stats every time
    await this.collectStats();

    const stats = this.lastStats;

    // what can we actually offer based on CURRENT usage
    const reserved = {
      memory: 0.5,  // keep 0.5gb for system
      disk: 10      // keep 10gb free
    };

    // calculate available CPU based on ACTUAL current load
    const cpuUsagePercent = stats.cpu.usage || 0;
    const availableCpuPercent = Math.max(0, 100 - cpuUsagePercent);
    const availableCpuCores = (availableCpuPercent / 100) * stats.cpu.cores;

    return {
      cpu: {
        cores: stats.cpu.cores,
        // actual available CPU based on current load
        available: Math.max(0, Math.round(availableCpuCores * 10) / 10)
      },
      memory: {
        total: stats.memory.total,
        // actual available memory from system
        available: Math.max(0, stats.memory.available - reserved.memory)
      },
      disk: stats.disk.map((d: any) => ({
        path: d.fs,
        total: d.total,
        available: Math.max(0, d.available - reserved.disk)
      })),
      network: {
        // just report what we got
        bandwidth: Math.round((stats.network.rx + stats.network.tx) / 125000) // mbps
      }
    };
  }
  
  getStats() {
    return this.lastStats;
  }
}