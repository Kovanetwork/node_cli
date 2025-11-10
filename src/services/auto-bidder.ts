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
  pricingStrategy: {
    cpuPricePerCore: number;  // per core per block
    memoryPricePerGb: number; // per gb per block
    margin: number;            // profit margin multiplier
  };
}

export class AutoBidder {
  private config: AutoBidderConfig;
  private monitor: ResourceMonitor;
  private pollingInterval: NodeJS.Timeout | null = null;

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
          'Authorization': `Bearer ${await this.getToken()}`
        }
      });

      if (!response.ok) {
        logger.debug('failed to fetch orders');
        return;
      }

      const data: any = await response.json();
      const orders: Order[] = data.orders || [];

      if (orders.length === 0) {
        return;
      }

      logger.debug({ count: orders.length }, 'found open orders');

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
    // check if we can handle this order
    const canHandle = await this.canHandleOrder(order);
    if (!canHandle) {
      logger.debug({ orderId: order.id }, 'cannot handle order - insufficient resources');
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
      logger.debug({ orderId: order.id, ourPrice, maxPrice: order.maxPricePerBlock }, 'our price too high');
      return;
    }

    logger.info({ orderId: order.id, ourPrice, maxPrice: order.maxPricePerBlock, nodeId: this.config.nodeId }, 'submitting bid');

    // submit bid
    try {
      await this.submitBid(order.id, ourPrice);
    } catch (err: any) {
      if (err.message?.includes('already bid')) {
        // we already bid on this, skip
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
      return false;
    }

    // check memory (convert to GB)
    const requiredMemory = this.parseMemoryToGb(order.resources.memory);
    if (resources.memory.available < requiredMemory) {
      return false;
    }

    // TODO: check disk, gpu if required

    return true;
  }

  // calculate competitive bid price
  private calculateBidPrice(order: Order): number {
    const cpu = order.resources.cpu;
    const memory = this.parseMemoryToGb(order.resources.memory);

    // base cost
    const cpuCost = cpu * this.config.pricingStrategy.cpuPricePerCore;
    const memoryCost = memory * this.config.pricingStrategy.memoryPricePerGb;

    const baseCost = cpuCost + memoryCost;

    // add margin
    let price = baseCost * this.config.pricingStrategy.margin;

    // minimum bid of 1 to ensure non-zero pricing
    if (price < 1) {
      price = 1;
    }

    // round to 2 decimals
    return Math.round(price * 100) / 100;
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
        'Authorization': `Bearer ${await this.getToken()}`
      },
      body: JSON.stringify(bidData)
    });

    if (response.ok) {
      const data: any = await response.json();
      logger.info({ orderId, pricePerBlock, bidId: data.bid.id }, 'bid submitted');
    } else {
      const error: any = await response.json();
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

  // get authentication token for provider
  private async getToken(): Promise<string> {
    // for now, use test token
    // in production, provider would authenticate with wallet
    const response = await fetch(`${this.config.orchestratorUrl}/api/v1/auth/test-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: this.config.providerId,
        role: 'provider'
      })
    });

    const data: any = await response.json();
    return data.token;
  }
}
