// tests for LeaseHandler - lease polling, deployment lifecycle, log batching
jest.mock('../lib/logger.js', () => ({
    logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }
}));
// mock the state manager singleton
jest.mock('../lib/state.js', () => ({
    stateManager: {
        addDeployment: jest.fn(),
        removeDeployment: jest.fn(),
        getActiveDeployments: jest.fn().mockReturnValue([])
    }
}));
// mock dockerode (LeaseHandler creates a Docker instance directly)
const mockContainer = {
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    inspect: jest.fn().mockResolvedValue({ State: { Running: true } })
};
jest.mock('dockerode', () => {
    return jest.fn().mockImplementation(() => ({
        listContainers: jest.fn().mockResolvedValue([]),
        getContainer: jest.fn().mockReturnValue(mockContainer)
    }));
});
import { LeaseHandler } from '../services/lease-handler';
import { stateManager } from '../lib/state';
const mockFetch = jest.fn();
global.fetch = mockFetch;
// mock executor
const mockExecutor = {
    executeDeployment: jest.fn().mockResolvedValue(undefined),
    stopDeployment: jest.fn().mockResolvedValue(undefined),
    closeDeployment: jest.fn().mockResolvedValue(undefined),
    getRunningDeployments: jest.fn().mockReturnValue([]),
    getDeployment: jest.fn().mockReturnValue(undefined),
    updateDeploymentFiles: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    emit: jest.fn()
};
// mock p2p node
const mockP2p = {
    on: jest.fn(),
    emit: jest.fn()
};
// helper to wait for async stuff to settle
const settle = (ms = 150) => new Promise(r => setTimeout(r, ms));
describe('LeaseHandler', () => {
    let handler;
    const config = {
        nodeId: 'node-abc',
        providerId: 'provider-123',
        orchestratorUrl: 'http://localhost:3000',
        apiKey: 'sk_live_testkey'
    };
    const makeLease = (overrides = {}) => ({
        id: 'lease-1',
        deploymentId: 'deploy-1',
        nodeId: 'node-abc',
        pricePerBlock: 0.05,
        manifest: { services: { web: { image: 'nginx' } } },
        manifestVersion: '1',
        filesVersion: 0,
        state: 'active',
        ...overrides
    });
    beforeEach(() => {
        jest.clearAllMocks();
        // reset executor mock
        mockExecutor.getDeployment.mockReturnValue(undefined);
        mockExecutor.getRunningDeployments.mockReturnValue([]);
        handler = new LeaseHandler(config, mockExecutor, mockP2p);
    });
    afterEach(() => {
        handler.stop();
    });
    // -- start/stop --
    it('should start and immediately poll for leases', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ leases: [] })
        });
        handler.start(60000);
        await settle();
        // immediate poll
        expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/api/v1/provider/leases', expect.objectContaining({
            headers: { 'Authorization': 'Bearer sk_live_testkey' }
        }));
    });
    it('should not start twice', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ leases: [] })
        });
        handler.start(60000);
        await settle();
        const callCount = mockFetch.mock.calls.length;
        handler.start(60000);
        await settle();
        // shouldn't have made additional immediate calls
        expect(mockFetch.mock.calls.length).toBe(callCount);
    });
    it('should clear all intervals on stop', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ leases: [] })
        });
        handler.start(60000);
        handler.stop();
        await settle();
        // no throw, cleanup done
    });
    // -- lease polling --
    it('should execute deployment for new lease', async () => {
        const lease = makeLease();
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ leases: [lease] })
        });
        handler.start(60000);
        await settle(300);
        expect(mockExecutor.executeDeployment).toHaveBeenCalledWith({
            deploymentId: 'deploy-1',
            leaseId: 'lease-1',
            manifest: lease.manifest
        });
        expect(stateManager.addDeployment).toHaveBeenCalledWith('deploy-1');
    });
    it('should skip leases for other nodes', async () => {
        const lease = makeLease({ nodeId: 'other-node' });
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ leases: [lease] })
        });
        handler.start(60000);
        await settle(300);
        expect(mockExecutor.executeDeployment).not.toHaveBeenCalled();
    });
    it('should not re-execute already running deployments', async () => {
        const lease = makeLease();
        // pretend it's already running
        mockExecutor.getDeployment.mockReturnValue({ deploymentId: 'deploy-1' });
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ leases: [lease] })
        });
        handler.start(60000);
        await settle(300);
        expect(mockExecutor.executeDeployment).not.toHaveBeenCalled();
    });
    it('should close deployments whose leases disappeared', async () => {
        // first poll returns a lease
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ leases: [makeLease()] })
        });
        handler.start(500);
        await settle(300);
        // now pretend executor still tracks it
        mockExecutor.getRunningDeployments.mockReturnValue(['deploy-1']);
        // second poll returns empty (lease gone)
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ leases: [] })
        });
        await settle(800);
        expect(mockExecutor.closeDeployment).toHaveBeenCalledWith('deploy-1');
        expect(stateManager.removeDeployment).toHaveBeenCalledWith('deploy-1');
    });
    // -- log batching --
    it('should buffer logs from executor log events', () => {
        expect(mockExecutor.on).toHaveBeenCalledWith('log', expect.any(Function));
    });
    it('should flush logs periodically', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ leases: [] })
        });
        handler.start(60000);
        // simulate a log event via the registered callback
        const logCallback = mockExecutor.on.mock.calls.find((c) => c[0] === 'log')[1];
        logCallback({
            deploymentId: 'deploy-1',
            serviceName: 'web',
            logLine: 'test log line',
            stream: 'stdout'
        });
        // wait for log flush (2s interval + margin)
        await settle(2500);
        // should have tried to POST log batch
        const logCalls = mockFetch.mock.calls.filter((c) => c[0]?.includes('/logs/batch'));
        expect(logCalls.length).toBeGreaterThanOrEqual(1);
    });
    it('should flush immediately when buffer hits max size', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ leases: [] })
        });
        handler.start(60000);
        const logCallback = mockExecutor.on.mock.calls.find((c) => c[0] === 'log')[1];
        // send 50 logs to hit the batch max
        for (let i = 0; i < 50; i++) {
            logCallback({
                deploymentId: 'deploy-1',
                serviceName: 'web',
                logLine: `log line ${i}`,
                stream: 'stdout'
            });
        }
        await settle(200);
        // should have posted without waiting for 2s timer
        const logCalls = mockFetch.mock.calls.filter((c) => c[0]?.includes('/logs/batch'));
        expect(logCalls.length).toBeGreaterThanOrEqual(1);
    });
    // -- error handling --
    it('should handle failed lease fetch gracefully', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 500
        });
        handler.start(60000);
        await settle(300);
        // no crash
        expect(mockExecutor.executeDeployment).not.toHaveBeenCalled();
    });
    it('should handle deployment execution failure', async () => {
        mockExecutor.executeDeployment.mockRejectedValueOnce(new Error('docker broke'));
        const lease = makeLease();
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ leases: [lease] })
        });
        handler.start(60000);
        await settle(300);
        // should not crash
        expect(mockExecutor.executeDeployment).toHaveBeenCalled();
    });
    it('should use apiKey for auth token', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ leases: [] })
        });
        handler.start(60000);
        await settle();
        const authHeader = mockFetch.mock.calls[0][1].headers['Authorization'];
        expect(authHeader).toBe('Bearer sk_live_testkey');
    });
    // -- files version tracking --
    it('should detect files version changes and update files', async () => {
        const lease = makeLease({ filesVersion: 1 });
        // first poll - new deployment
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ leases: [lease] })
        });
        handler.start(500);
        await settle(300);
        // now the deployment is "running"
        mockExecutor.getDeployment.mockReturnValue({ deploymentId: 'deploy-1' });
        // second poll - files version bumped
        const updatedLease = makeLease({ filesVersion: 2 });
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ leases: [updatedLease] })
        });
        await settle(800);
        expect(mockExecutor.updateDeploymentFiles).toHaveBeenCalledWith('deploy-1', 'web');
    });
});
