// tests for HeartbeatService - heartbeat lifecycle, events, payload

jest.mock('../lib/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }
}));

import { HeartbeatService } from '../services/heartbeat';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// mock resource monitor
const mockMonitor = {
  getAvailableResources: jest.fn().mockResolvedValue({
    cpu: { cores: 8, available: 6 },
    memory: { total: 32, available: 24 },
    disk: [{ path: '/', total: 500, available: 400 }],
    network: { bandwidth: 100 },
    gpu: [{ vendor: 'nvidia', model: 'rtx 4090', vram: 24 }]
  }),
  start: jest.fn(),
  stop: jest.fn()
};

// mock limit manager
const mockLimitManager = {
  getLimits: jest.fn().mockReturnValue({ cpu: 4, memory: 16, disk: 200 }),
  getAvailableResources: jest.fn().mockReturnValue({ cpu: 3, memory: 12, disk: 150 }),
  getCurrentUsage: jest.fn().mockReturnValue({ cpu: 1, memory: 4, disk: 50 })
};

describe('HeartbeatService', () => {
  let hb: HeartbeatService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    hb = new HeartbeatService(
      'node-abc',
      'http://localhost:3000',
      mockMonitor as any,
      mockLimitManager as any,
      30 // 30s interval
    );
  });

  afterEach(async () => {
    await hb.stop();
    jest.useRealTimers();
  });

  // -- start/stop --

  it('should send initial heartbeat on start', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ timestamp: Date.now() })
    });

    await hb.start();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/nodes/node-abc/heartbeat',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
    );
  });

  it('should mark as active after start', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({})
    });

    expect(hb.isActive()).toBe(false);
    await hb.start();
    expect(hb.isActive()).toBe(true);
  });

  it('should mark as inactive after stop', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({})
    });

    await hb.start();
    await hb.stop();
    expect(hb.isActive()).toBe(false);
  });

  it('should not start twice', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({})
    });

    await hb.start();
    await hb.start();
    // only 1 initial heartbeat
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // -- heartbeat payload --

  it('should send provider limits in payload, not raw system resources', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({})
    });

    await hb.start();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // should use limit manager values, not monitor values
    expect(body.resources.cpu.cores).toBe(4); // from getLimits()
    expect(body.resources.cpu.available).toBe(3); // from getAvailableResources()
    expect(body.resources.memory.total).toBe(16);
    expect(body.resources.memory.available).toBe(12);
  });

  it('should include gpu info from monitor', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({})
    });

    await hb.start();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.resources.gpu).toHaveLength(1);
    expect(body.resources.gpu[0].vendor).toBe('nvidia');
  });

  // -- events --

  it('should emit heartbeat-success on ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ timestamp: 12345 })
    });

    const events: any[] = [];
    hb.on('heartbeat-success', (data) => events.push(data));

    await hb.start();
    expect(events).toHaveLength(1);
    expect(events[0].timestamp).toBe(12345);
    expect(events[0].resources).toBeDefined();
  });

  it('should emit heartbeat-error on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'server error'
    });

    const errors: any[] = [];
    hb.on('heartbeat-error', (data) => errors.push(data));

    await hb.start();
    expect(errors).toHaveLength(1);
    expect(errors[0].status).toBe(500);
  });

  it('should emit heartbeat-error on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('connection refused'));

    const errors: any[] = [];
    hb.on('heartbeat-error', (data) => errors.push(data));

    await hb.start();
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBeInstanceOf(Error);
  });

  it('should emit pending-jobs when orchestrator returns them', async () => {
    const pendingJobs = [
      { id: 'job-1', manifest: {} },
      { id: 'job-2', manifest: {} }
    ];

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ timestamp: Date.now(), pendingJobs })
    });

    const received: any[] = [];
    hb.on('pending-jobs', (jobs) => received.push(jobs));

    await hb.start();
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(pendingJobs);
  });

  it('should not emit pending-jobs when list is empty', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ timestamp: Date.now(), pendingJobs: [] })
    });

    const received: any[] = [];
    hb.on('pending-jobs', (jobs) => received.push(jobs));

    await hb.start();
    expect(received).toHaveLength(0);
  });

  // -- triggerHeartbeat --

  it('should allow manual heartbeat trigger', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({})
    });

    await hb.start();
    mockFetch.mockClear();

    await hb.triggerHeartbeat();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // -- interval --

  it('should send periodic heartbeats', async () => {
    jest.useRealTimers(); // real timers needed for this test

    const shortHb = new HeartbeatService(
      'node-abc',
      'http://localhost:3000',
      mockMonitor as any,
      mockLimitManager as any,
      1 // 1 second interval
    );

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({})
    });

    await shortHb.start();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // wait a bit over 1 second for the interval to fire
    await new Promise(r => setTimeout(r, 1500));

    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    await shortHb.stop();
  });
});

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}
