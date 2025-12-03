// auto bidder - evaluates orders and submits competitive bids
// pricing strategy, resource matching, bid submission

import { logger } from '../lib/logger.js';
import { ResourceMonitor } from '../lib/monitor.js';

interface Order {
  id: string;
  deploymentId: string;
  resources: {
    cpu: number;
    memory: string;
    storage?: any[];
    gpu?: any;
  };
  placement: {
    attributes?: Record<string, string>;
    pricing: Record<string, { amount: number }>;
  };
  maxPricePerBlock: number;
}

interface AutoBidderConfig {
  nodeId: string;
  providerId: string;
  orchestratorUrl: string;
  apiKey: string;  // provider api key for authentication
  pricingStrategy: {
    cpuPricePerCore: number;  // per core per block
    memoryPricePerGb: number; // per gb per block
    gpuPricePerUnit: number;  // per gpu per block
    margin: number;            // profit margin multiplier
  };
}

export class AutoBidder {
  private config: AutoBidderConfig;
  private monitor: ResourceMonitor;
  private pollingInterval: NodeJS.Timeout | null = null;
  private submittedBids: Set<string> = new Set();  // track orders we've already bid on

  constructor(config: AutoBidderConfig, monitor: ResourceMonitor) {
    this.config = config;
    this.monitor = monitor;
  }

  // start polling for orders
  start(intervalMs: number = 15000): void {
    if (this.pollingInterval) {
      logger.warn('auto-bidder already running');
      return;
    }

    logger.info({ intervalMs }, 'starting auto-bidder');

    this.pollingInterval = setInterval(async () => {
      try {
        await this.pollAndBid();
      } catch (err) {
        logger.error({ err }, 'auto-bidder error');
      }
    }, intervalMs);

    // run immediately on start
    this.pollAndBid();
  }

  stop(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logger.info('auto-bidder stopped');
    }
  }

  // poll for orders and submit bids
  private async pollAndBid(): Promise<void> {
    try {
      // fetch open orders from orchestrator
      const response = await fetch(`${this.config.orchestratorUrl}/api/v1/provider/orders`, {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`
        }
      });

      if (!response.ok) {
        const error = await response.text();
        logger.error({ status: response.status, error }, 'failed to fetch orders from orchestrator');
        return;
      }

      const data: any = await response.json();
      const orders: Order[] = data.orders || [];

      if (orders.length === 0) {
        logger.debug('no open orders available');
        return;
      }

      logger.info({ count: orders.length }, 'found open orders - evaluating for bidding');

      // log the order ids and timestamps for debugging
      for (const order of orders) {
        // order id format: userId-timestamp-serviceIndex
        // e.g. 9d4a6656-02c8-4e16-a4c3-910efe92e7e2-1763050326342-1
        const parts = order.id.split('-');
        const orderTimestamp = parseInt(parts[parts.length - 2] || '0');
        const age = Date.now() - orderTimestamp;
        const ageInHours = Math.floor(age / (1000 * 60 * 60));
        logger.debug({
          orderId: order.id,
          timestamp: orderTimestamp,
          ageInHours,
          alreadyBid: this.submittedBids.has(order.id)
        }, 'order details');
      }

      // evaluate each order
      for (const order of orders) {
        await this.evaluateAndBid(order);
      }
    } catch (err) {
      logger.debug({ err }, 'failed to poll orders');
    }
  }

  // evaluate order and submit bid if suitable
  private async evaluateAndBid(order: Order): Promise<void> {
    // skip if we already bid on this order
    if (this.submittedBids.has(order.id)) {
      logger.info({ orderId: order.id }, 'skipping - already bid in this session');
      return;
    }

    // skip old orders (more than 7 days)
    // order id format: userId-timestamp-serviceIndex
    const parts = order.id.split('-');
    const orderTimestamp = parseInt(parts[parts.length - 2] || '0');
    const now = Date.now();
    const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
    if (orderTimestamp < sevenDaysAgo) {
      logger.info({ orderId: order.id, ageInDays: Math.floor((now - orderTimestamp) / (1000 * 60 * 60 * 24)) }, 'skipping - order too old');
      return;
    }

    logger.info({ orderId: order.id }, 'evaluating order');

    // check if we can handle this order
    const canHandle = await this.canHandleOrder(order);
    if (!canHandle) {
      logger.info({ orderId: order.id, required: order.resources }, 'cannot handle order - insufficient resources');
      return;
    }

    // calculate our bid price
    const ourPrice = this.calculateBidPrice(order);

    // validate price is a valid number
    if (isNaN(ourPrice) || !isFinite(ourPrice) || ourPrice <= 0) {
      logger.error({ orderId: order.id, ourPrice, order: order.resources }, 'calculated invalid price');
      return;
    }

    // check if our price is competitive
    if (ourPrice > order.maxPricePerBlock) {
      logger.info({ orderId: order.id, ourPrice, maxPrice: order.maxPricePerBlock }, 'our price too high');
      return;
    }

    logger.info({ orderId: order.id, ourPrice, maxPrice: order.maxPricePerBlock, nodeId: this.config.nodeId }, 'submitting bid');

    // submit bid
    try {
      await this.submitBid(order.id, ourPrice);
      // only add to set after successful bid
      this.submittedBids.add(order.id);
      logger.info({ orderId: order.id }, 'bid successful');
    } catch (err: any) {
      if (err.message === 'already bid') {
        // we already bid on this in a previous run, remember it silently
        this.submittedBids.add(order.id);
        return;
      }
      logger.error({ err, orderId: order.id }, 'failed to submit bid');
    }
  }

  // check if we have resources for order
  private async canHandleOrder(order: Order): Promise<boolean> {
    const resources = await this.monitor.getAvailableResources();

    // check cpu
    const requiredCpu = order.resources.cpu;
    if (resources.cpu.available < requiredCpu) {
      logger.info({
        orderId: order.id,
        required: requiredCpu,
        available: resources.cpu.available
      }, 'insufficient cpu');
      return false;
    }

    // check memory (convert to GB)
    const requiredMemory = this.parseMemoryToGb(order.resources.memory);
    if (resources.memory.available < requiredMemory) {
      logger.info({
        orderId: order.id,
        requiredMemory,
        availableMemory: resources.memory.available
      }, 'insufficient memory');
      return false;
    }

    // check gpu if required
    if (order.resources.gpu && order.resources.gpu.units > 0) {
      const requiredGpuUnits = order.resources.gpu.units;
      const requiredVendor = order.resources.gpu.attributes?.vendor;
      const requiredRam = order.resources.gpu.attributes?.ram;

      const availableGpus = resources.gpu || [];

      if (availableGpus.length < requiredGpuUnits) {
        logger.info({
          orderId: order.id,
          requiredGpuUnits,
          availableGpus: availableGpus.length
        }, 'insufficient gpu count');
        return false;
      }

      // check vendor requirement if specified
      if (requiredVendor) {
        const vendorKey = Object.keys(requiredVendor)[0]?.toLowerCase();
        const matchingGpus = availableGpus.filter((g: any) =>
          g.vendor.includes(vendorKey)
        );

        if (matchingGpus.length < requiredGpuUnits) {
          logger.info({
            orderId: order.id,
            requiredVendor: vendorKey,
            matchingGpus: matchingGpus.length
          }, 'no matching gpu vendor');
          return false;
        }

        // check vram requirement if specified
        if (requiredRam) {
          const requiredVram = this.parseMemoryToGb(requiredRam);
          const sufficientGpus = matchingGpus.filter((g: any) => g.vram >= requiredVram);

          if (sufficientGpus.length < requiredGpuUnits) {
            logger.info({
              orderId: order.id,
              requiredVram,
              availableVram: matchingGpus.map((g: any) => g.vram)
            }, 'insufficient gpu vram');
            return false;
          }
        }
      }
    }

    return true;
  }

  // calculate competitive bid price
  private calculateBidPrice(order: Order): number {
    const cpu = order.resources.cpu;
    const memory = this.parseMemoryToGb(order.resources.memory);

    // base cost
    const cpuCost = cpu * this.config.pricingStrategy.cpuPricePerCore;
    const memoryCost = memory * this.config.pricingStrategy.memoryPricePerGb;

    // gpu cost if required
    let gpuCost = 0;
    if (order.resources.gpu && order.resources.gpu.units > 0) {
      const gpuPricePerUnit = this.config.pricingStrategy.gpuPricePerUnit || 0.1;
      gpuCost = order.resources.gpu.units * gpuPricePerUnit;
    }

    const baseCost = cpuCost + memoryCost + gpuCost;

    // add margin
    let price = baseCost * this.config.pricingStrategy.margin;

    // minimum bid to ensure non-zero pricing
    if (price < 0.001) {
      price = 0.001;
    }

    // round to 4 decimals for precision
    return Math.round(price * 10000) / 10000;
  }

  // submit bid to orchestrator
  private async submitBid(orderId: string, pricePerBlock: number): Promise<void> {
    const bidData = {
      orderId,
      nodeId: this.config.nodeId,
      pricePerBlock
    };

    logger.debug({ bidData }, 'submitting bid');

    const response = await fetch(`${this.config.orchestratorUrl}/api/v1/provider/bids`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify(bidData)
    });

    if (response.ok) {
      const data: any = await response.json();
      logger.info({ orderId, pricePerBlock, bidId: data.bid.id }, 'bid submitted');
    } else {
      const error: any = await response.json();
      // check if we already bid on this order
      if (error.message?.includes('already bid')) {
        // throw this specific error so evaluateAndBid can track it
        throw new Error('already bid');
      }
      // only log other errors
      logger.error({ orderId, status: response.status, error }, 'bid api error');
      throw new Error(error.message || error.error || 'bid submission failed');
    }
  }

  // parse memory size to GB
  private parseMemoryToGb(size: string): number {
    const match = size.match(/^(\d+(?:\.\d+)?)\s*([A-Za-z]+)$/);
    if (!match) return 0;

    const value = parseFloat(match[1]);
    const unit = match[2];

    const multipliers: Record<string, number> = {
      'Ki': 1 / (1024 * 1024),
      'Mi': 1 / 1024,
      'Gi': 1,
      'Ti': 1024
    };

    return value * (multipliers[unit] || 1);
  }

}
