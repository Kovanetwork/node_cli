// tests for ResourceLimitManager - pure in-memory resource tracking
jest.mock('../lib/logger.js', () => ({
    logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }
}));
import { ResourceLimitManager } from '../lib/resource-limits';
describe('ResourceLimitManager', () => {
    const defaultLimits = { cpu: 8, memory: 32, disk: 500 };
    // -- initialization --
    it('should store limits passed to constructor', () => {
        const mgr = new ResourceLimitManager(defaultLimits);
        const limits = mgr.getLimits();
        expect(limits.cpu).toBe(8);
        expect(limits.memory).toBe(32);
        expect(limits.disk).toBe(500);
    });
    it('should return a copy from getLimits, not internal ref', () => {
        const mgr = new ResourceLimitManager(defaultLimits);
        const a = mgr.getLimits();
        const b = mgr.getLimits();
        expect(a).not.toBe(b);
        expect(a).toEqual(b);
    });
    it('should start with zero usage', () => {
        const mgr = new ResourceLimitManager(defaultLimits);
        const usage = mgr.getCurrentUsage();
        expect(usage.cpu).toBe(0);
        expect(usage.memory).toBe(0);
        expect(usage.disk).toBe(0);
    });
    it('should report full capacity as available initially', () => {
        const mgr = new ResourceLimitManager(defaultLimits);
        const avail = mgr.getAvailableResources();
        expect(avail.cpu).toBe(8);
        expect(avail.memory).toBe(32);
        expect(avail.disk).toBe(500);
    });
    // -- canAcceptJob --
    it('should accept a job that fits within limits', () => {
        const mgr = new ResourceLimitManager(defaultLimits);
        expect(mgr.canAcceptJob({ cpu: 4, memory: 16 })).toBe(true);
    });
    it('should reject a job that exceeds cpu', () => {
        const mgr = new ResourceLimitManager(defaultLimits);
        expect(mgr.canAcceptJob({ cpu: 10, memory: 8 })).toBe(false);
    });
    it('should reject a job that exceeds memory', () => {
        const mgr = new ResourceLimitManager(defaultLimits);
        expect(mgr.canAcceptJob({ cpu: 2, memory: 64 })).toBe(false);
    });
    it('should reject a job that exceeds disk when disk is specified', () => {
        const mgr = new ResourceLimitManager(defaultLimits);
        expect(mgr.canAcceptJob({ cpu: 1, memory: 1, disk: 600 })).toBe(false);
    });
    it('should accept a job with no disk requirement even when disk is limited', () => {
        const mgr = new ResourceLimitManager({ cpu: 4, memory: 8, disk: 10 });
        expect(mgr.canAcceptJob({ cpu: 2, memory: 4 })).toBe(true);
    });
    // -- allocateResources --
    it('should allocate resources and update usage', () => {
        const mgr = new ResourceLimitManager(defaultLimits);
        const ok = mgr.allocateResources('job-1', { cpu: 2, memory: 8, disk: 50 });
        expect(ok).toBe(true);
        const usage = mgr.getCurrentUsage();
        expect(usage.cpu).toBe(2);
        expect(usage.memory).toBe(8);
        expect(usage.disk).toBe(50);
    });
    it('should fail to allocate when resources are insufficient', () => {
        const mgr = new ResourceLimitManager(defaultLimits);
        mgr.allocateResources('job-1', { cpu: 6, memory: 28 });
        const ok = mgr.allocateResources('job-2', { cpu: 4, memory: 8 });
        expect(ok).toBe(false);
    });
    it('should reduce available after allocation', () => {
        const mgr = new ResourceLimitManager(defaultLimits);
        mgr.allocateResources('job-1', { cpu: 3, memory: 10, disk: 100 });
        const avail = mgr.getAvailableResources();
        expect(avail.cpu).toBe(5);
        expect(avail.memory).toBe(22);
        expect(avail.disk).toBe(400);
    });
    // -- releaseResources --
    it('should free resources on release', () => {
        const mgr = new ResourceLimitManager(defaultLimits);
        mgr.allocateResources('job-1', { cpu: 4, memory: 16, disk: 200 });
        mgr.releaseResources('job-1', { cpu: 4, memory: 16, disk: 200 });
        const usage = mgr.getCurrentUsage();
        expect(usage.cpu).toBe(0);
        expect(usage.memory).toBe(0);
        expect(usage.disk).toBe(0);
    });
    it('should not go below zero on release', () => {
        const mgr = new ResourceLimitManager(defaultLimits);
        mgr.allocateResources('job-1', { cpu: 2, memory: 4 });
        // release more than allocated - shouldn't go negative
        mgr.releaseResources('job-1', { cpu: 5, memory: 10, disk: 50 });
        const usage = mgr.getCurrentUsage();
        expect(usage.cpu).toBe(0);
        expect(usage.memory).toBe(0);
        expect(usage.disk).toBe(0);
    });
    // -- concurrent jobs --
    it('should track multiple allocations correctly', () => {
        const mgr = new ResourceLimitManager(defaultLimits);
        mgr.allocateResources('job-1', { cpu: 2, memory: 8 });
        mgr.allocateResources('job-2', { cpu: 3, memory: 12 });
        const usage = mgr.getCurrentUsage();
        expect(usage.cpu).toBe(5);
        expect(usage.memory).toBe(20);
    });
    it('should allow new job after partial release', () => {
        const mgr = new ResourceLimitManager(defaultLimits);
        mgr.allocateResources('job-1', { cpu: 6, memory: 24 });
        // can't fit another big job
        expect(mgr.canAcceptJob({ cpu: 4, memory: 16 })).toBe(false);
        // release the first one
        mgr.releaseResources('job-1', { cpu: 6, memory: 24 });
        expect(mgr.canAcceptJob({ cpu: 4, memory: 16 })).toBe(true);
    });
    // -- getUsagePercentage --
    it('should report 0% usage when nothing allocated', () => {
        const mgr = new ResourceLimitManager(defaultLimits);
        const pct = mgr.getUsagePercentage();
        expect(pct.cpu).toBe(0);
        expect(pct.memory).toBe(0);
        expect(pct.disk).toBe(0);
    });
    it('should report correct percentages', () => {
        const mgr = new ResourceLimitManager({ cpu: 10, memory: 100, disk: 1000 });
        mgr.allocateResources('job-1', { cpu: 5, memory: 25, disk: 200 });
        const pct = mgr.getUsagePercentage();
        expect(pct.cpu).toBe(50);
        expect(pct.memory).toBe(25);
        expect(pct.disk).toBe(20);
    });
    it('should report 100% when fully allocated', () => {
        const mgr = new ResourceLimitManager({ cpu: 4, memory: 16, disk: 100 });
        mgr.allocateResources('job-1', { cpu: 4, memory: 16, disk: 100 });
        const pct = mgr.getUsagePercentage();
        expect(pct.cpu).toBe(100);
        expect(pct.memory).toBe(100);
        expect(pct.disk).toBe(100);
    });
    // -- edge cases --
    it('should handle zero resource limits without crashing', () => {
        const mgr = new ResourceLimitManager({ cpu: 0, memory: 0, disk: 0 });
        expect(mgr.canAcceptJob({ cpu: 1, memory: 1 })).toBe(false);
        expect(mgr.allocateResources('job-1', { cpu: 1, memory: 1 })).toBe(false);
    });
    it('should handle allocation with only disk=0 (no disk requested)', () => {
        const mgr = new ResourceLimitManager(defaultLimits);
        const ok = mgr.allocateResources('job-1', { cpu: 1, memory: 1, disk: 0 });
        // disk is falsy (0), so it shouldn't add disk usage
        expect(ok).toBe(true);
        expect(mgr.getCurrentUsage().disk).toBe(0);
    });
    it('should return a copy from getCurrentUsage', () => {
        const mgr = new ResourceLimitManager(defaultLimits);
        const a = mgr.getCurrentUsage();
        const b = mgr.getCurrentUsage();
        expect(a).not.toBe(b);
        expect(a).toEqual(b);
    });
});
