// tests for AutoBidder - order evaluation, bid pricing, deduplication

jest.mock('../lib/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }
}));

import { AutoBidder } from '../services/auto-bidder';

// mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// mock resource monitor
const mockMonitor = {
  getAvailableResources: jest.fn().mockResolvedValue({
    cpu: { cores: 8, available: 6 },
    memory: { total: 32, available: 24 },
    disk: [{ path: '/', total: 500, available: 400 }],
    network: { bandwidth: 100 },
    gpu: []
  }),
  start: jest.fn(),
  stop: jest.fn(),
  getStats: jest.fn()
};

describe('AutoBidder', () => {
  let bidder: AutoBidder;

  const config = {
    nodeId: 'node-123',
    providerId: 'provider-456',
    orchestratorUrl: 'http://localhost:3000',
    apiKey: 'sk_live_test123',
    pricingStrategy: {
      cpuPricePerCore: 0.01,
      memoryPricePerGb: 0.005,
      gpuPricePerUnit: 0.1,
      margin: 1.2
    }
  };

  // helper to make a fresh order id with recent timestamp
  const makeOrderId = (suffix = '1') => {
    return `user-abc-${Date.now()}-${suffix}`;
  };

  const makeOrder = (overrides: any = {}) => ({
    id: makeOrderId(),
    deploymentId: 'deploy-1',
    resources: {
      cpu: 2,
      memory: '4Gi',
      ...overrides.resources
    },
    placement: { pricing: {} },
    maxPricePerBlock: 1.0,
    ...overrides
  });

  // helper to wait for async operations to settle
  const settle = (ms = 100) => new Promise(r => setTimeout(r, ms));

  beforeEach(() => {
    jest.clearAllMocks();
    bidder = new AutoBidder(config, mockMonitor as any);
  });

  afterEach(() => {
    bidder.stop();
  });

  // -- start/stop --

  it('should start polling and run immediately', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] })
    });

    bidder.start(60000);
    await settle();

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/provider/orders',
      expect.objectContaining({
        headers: { 'Authorization': 'Bearer sk_live_test123' }
      })
    );
  });

  it('should not start twice', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ orders: [] }) });
    bidder.start(60000);
    await settle();
    const callCount = mockFetch.mock.calls.length;
    bidder.start(60000);
    await settle();
    // shouldn't have made additional calls from second start
    expect(mockFetch.mock.calls.length).toBe(callCount);
  });

  it('should stop cleanly', () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ orders: [] }) });
    bidder.start(60000);
    bidder.stop();
    // no error thrown
  });

  // -- order evaluation --

  it('should submit bid for affordable order with sufficient resources', async () => {
    const order = makeOrder();

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ orders: [order] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ bid: { id: 'bid-1' } }) });

    bidder.start(60000);
    await settle(200);

    const bidCall = mockFetch.mock.calls.find(
      (c: any[]) => c[1]?.method === 'POST'
    );
    expect(bidCall).toBeDefined();
    const body = JSON.parse(bidCall![1].body);
    expect(body.orderId).toBe(order.id);
    expect(body.nodeId).toBe('node-123');
    expect(body.pricePerBlock).toBeGreaterThan(0);
  });

  it('should skip orders when resources are insufficient', async () => {
    mockMonitor.getAvailableResources.mockResolvedValueOnce({
      cpu: { cores: 8, available: 1 },
      memory: { total: 32, available: 24 },
      disk: [],
      network: { bandwidth: 100 },
      gpu: []
    });

    const order = makeOrder({ resources: { cpu: 4, memory: '8Gi' } });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ orders: [order] })
    });

    bidder.start(60000);
    await settle(200);

    const bidCalls = mockFetch.mock.calls.filter(
      (c: any[]) => c[1]?.method === 'POST'
    );
    expect(bidCalls).toHaveLength(0);
  });

  it('should skip orders when our price exceeds maxPricePerBlock', async () => {
    const order = makeOrder({ maxPricePerBlock: 0.0001 });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ orders: [order] })
    });

    bidder.start(60000);
    await settle(200);

    const bidCalls = mockFetch.mock.calls.filter(
      (c: any[]) => c[1]?.method === 'POST'
    );
    expect(bidCalls).toHaveLength(0);
  });

  // -- bid price calculation --

  it('should calculate price based on cpu and memory costs with margin', async () => {
    // cpu: 2 cores * 0.01 = 0.02
    // memory: 4gi * 0.005 = 0.02
    // base: 0.04, with 1.2 margin = 0.048
    const order = makeOrder({
      resources: { cpu: 2, memory: '4Gi' },
      maxPricePerBlock: 10
    });

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ orders: [order] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ bid: { id: 'bid-1' } }) });

    bidder.start(60000);
    await settle(200);

    const bidCall = mockFetch.mock.calls.find(
      (c: any[]) => c[1]?.method === 'POST'
    );
    expect(bidCall).toBeDefined();
    const body = JSON.parse(bidCall![1].body);
    expect(body.pricePerBlock).toBe(0.048);
  });

  // -- deduplication --

  it('should not bid on the same order twice', async () => {
    const order = makeOrder();

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ orders: [order] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ bid: { id: 'bid-1' } }) });

    bidder.start(500); // short interval for this test
    await settle(200);

    // second poll returns same order
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ orders: [order] })
    });

    await settle(700);

    // should only have 1 POST (bid submission)
    const bidCalls = mockFetch.mock.calls.filter(
      (c: any[]) => c[1]?.method === 'POST'
    );
    expect(bidCalls).toHaveLength(1);
  });

  it('should track "already bid" errors without retrying', async () => {
    const order = makeOrder();

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ orders: [order] }) })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ message: 'already bid on this order' })
      });

    bidder.start(500);
    await settle(200);

    // next poll, same order should be skipped
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ orders: [order] })
    });

    await settle(700);

    // only 1 POST attempt total
    const bidCalls = mockFetch.mock.calls.filter(
      (c: any[]) => c[1]?.method === 'POST'
    );
    expect(bidCalls).toHaveLength(1);
  });

  // -- error handling --

  it('should handle fetch errors gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));

    bidder.start(60000);
    await settle(200);

    // no crash, bidder still alive
    expect(bidder).toBeDefined();
  });

  it('should handle non-ok response from orders endpoint', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'internal error'
    });

    bidder.start(60000);
    await settle(200);

    // no crash
    expect(bidder).toBeDefined();
  });

  it('should skip orders older than 7 days', async () => {
    const oldTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const order = makeOrder({
      id: `user-abc-${oldTimestamp}-1`
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ orders: [order] })
    });

    bidder.start(60000);
    await settle(200);

    const bidCalls = mockFetch.mock.calls.filter(
      (c: any[]) => c[1]?.method === 'POST'
    );
    expect(bidCalls).toHaveLength(0);
  });

  it('should handle empty orders list', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ orders: [] })
    });

    bidder.start(60000);
    await settle(200);

    // just the one GET, no POSTs
    const getCalls = mockFetch.mock.calls.filter(
      (c: any[]) => !c[1]?.method || c[1]?.method === 'GET'
    );
    expect(getCalls.length).toBeGreaterThanOrEqual(1);
    const bidCalls = mockFetch.mock.calls.filter(
      (c: any[]) => c[1]?.method === 'POST'
    );
    expect(bidCalls).toHaveLength(0);
  });

  it('should include gpu cost in price when order requires gpu', async () => {
    const order = makeOrder({
      resources: {
        cpu: 2,
        memory: '4Gi',
        gpu: { units: 2, attributes: {} }
      },
      maxPricePerBlock: 10
    });

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ orders: [order] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ bid: { id: 'bid-2' } }) });

    // provide gpu in available resources
    mockMonitor.getAvailableResources.mockResolvedValueOnce({
      cpu: { cores: 8, available: 6 },
      memory: { total: 32, available: 24 },
      disk: [],
      network: { bandwidth: 100 },
      gpu: [
        { vendor: 'nvidia', model: 'a100', vram: 40 },
        { vendor: 'nvidia', model: 'a100', vram: 40 }
      ]
    });

    bidder.start(60000);
    await settle(200);

    const bidCall = mockFetch.mock.calls.find(
      (c: any[]) => c[1]?.method === 'POST'
    );
    expect(bidCall).toBeDefined();
    const body = JSON.parse(bidCall![1].body);
    // cpu: 2*0.01=0.02, mem: 4*0.005=0.02, gpu: 2*0.1=0.2 => base 0.24, *1.2 margin = 0.288
    expect(body.pricePerBlock).toBe(0.288);
  });
});
