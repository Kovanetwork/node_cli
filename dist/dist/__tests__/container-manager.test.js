// tests for ContainerManager - container lifecycle, exec, file ops, health
jest.mock('../lib/logger.js', () => ({
    logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }
}));
const mockDocker = {
    checkDocker: jest.fn().mockResolvedValue(true),
    pullImage: jest.fn().mockResolvedValue(undefined),
    createContainer: jest.fn().mockResolvedValue({
        id: 'container-123',
        // never resolve wait() so the container stays "running" in the map
        wait: jest.fn().mockReturnValue(new Promise(() => { }))
    }),
    getContainerStats: jest.fn().mockResolvedValue({ memory: 100, cpu: 5, network: { rx: 0, tx: 0 } }),
    cleanupContainer: jest.fn().mockResolvedValue(undefined),
    execCommand: jest.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 }),
    getContainerLogs: jest.fn().mockResolvedValue('log output'),
    streamContainerLogs: jest.fn().mockResolvedValue(() => { })
};
jest.mock('../lib/docker.js', () => ({
    DockerManager: jest.fn().mockImplementation(() => mockDocker)
}));
import { ContainerManager } from '../services/container-manager';
describe('ContainerManager', () => {
    let cm;
    const testJob = {
        id: 'job-001',
        userId: 'user-1',
        image: 'alpine:latest',
        resources: { cpu: 2, memory: 4, disk: 10 },
        env: { FOO: 'bar' },
        duration: 0
    };
    beforeEach(() => {
        jest.clearAllMocks();
        cm = new ContainerManager();
    });
    afterEach(async () => {
        // cleanup intervals
        await cm.stop();
    });
    // -- start --
    it('should check docker availability on start', async () => {
        await cm.start();
        expect(mockDocker.checkDocker).toHaveBeenCalled();
    });
    it('should throw if docker is not available', async () => {
        mockDocker.checkDocker.mockResolvedValueOnce(false);
        await expect(cm.start()).rejects.toThrow('docker not available');
    });
    // -- runJob --
    it('should pull image and create container', async () => {
        const containerId = await cm.runJob(testJob);
        expect(containerId).toBe('container-123');
        expect(mockDocker.pullImage).toHaveBeenCalledWith('alpine:latest');
        expect(mockDocker.createContainer).toHaveBeenCalledWith(expect.objectContaining({
            jobId: 'job-001',
            image: 'alpine:latest',
            cpus: 2,
            memory: 4096 // 4gb * 1024
        }));
    });
    it('should emit container-started event on successful run', async () => {
        const events = [];
        cm.on('container-started', (data) => events.push(data));
        await cm.runJob(testJob);
        expect(events).toHaveLength(1);
        expect(events[0].jobId).toBe('job-001');
        expect(events[0].containerId).toBe('container-123');
    });
    it('should track running jobs after run', async () => {
        await cm.runJob(testJob);
        expect(cm.getRunningJobs()).toContain('job-001');
    });
    it('should emit container-failed on error', async () => {
        mockDocker.pullImage.mockRejectedValueOnce(new Error('pull failed'));
        const events = [];
        cm.on('container-failed', (data) => events.push(data));
        await expect(cm.runJob(testJob)).rejects.toThrow('pull failed');
        expect(events).toHaveLength(1);
        expect(events[0].jobId).toBe('job-001');
    });
    // -- stopContainer --
    it('should stop and remove tracked container', async () => {
        await cm.runJob(testJob);
        const events = [];
        cm.on('container-stopped', (data) => events.push(data));
        await cm.stopContainer('job-001');
        expect(mockDocker.cleanupContainer).toHaveBeenCalledWith('container-123');
        expect(cm.getRunningJobs()).not.toContain('job-001');
        expect(events).toHaveLength(1);
    });
    it('should silently no-op when stopping unknown job', async () => {
        await cm.stopContainer('nonexistent');
        // no throw
    });
    // -- execInContainer --
    it('should exec command in running container', async () => {
        await cm.runJob(testJob);
        const result = await cm.execInContainer('job-001', 'whoami');
        expect(mockDocker.execCommand).toHaveBeenCalledWith('container-123', 'whoami');
        expect(result.stdout).toBe('ok');
        expect(result.exitCode).toBe(0);
    });
    it('should throw when exec on unknown container', async () => {
        await expect(cm.execInContainer('nope', 'ls')).rejects.toThrow('container not found');
    });
    it('should throw when exec on stopped container', async () => {
        await cm.runJob(testJob);
        await cm.stopContainer('job-001');
        await expect(cm.execInContainer('job-001', 'ls')).rejects.toThrow('container not found');
    });
    // -- getContainerLogs --
    it('should fetch logs from docker', async () => {
        await cm.runJob(testJob);
        const logs = await cm.getContainerLogs('job-001', 50);
        expect(mockDocker.getContainerLogs).toHaveBeenCalledWith('container-123', 50);
        expect(logs).toBe('log output');
    });
    it('should throw for logs on unknown container', async () => {
        await expect(cm.getContainerLogs('nope')).rejects.toThrow('container not found');
    });
    // -- writeFile --
    it('should base64 encode content and exec write command', async () => {
        await cm.runJob(testJob);
        await cm.writeFile('job-001', '/tmp/test.txt', 'hello world');
        expect(mockDocker.execCommand).toHaveBeenCalled();
        const call = mockDocker.execCommand.mock.calls[0];
        expect(call[0]).toBe('container-123');
        // command should contain base64 encoded content
        const encoded = Buffer.from('hello world', 'utf8').toString('base64');
        expect(call[1]).toContain(encoded);
        expect(call[1]).toContain('/tmp/test.txt');
    });
    it('should reject path traversal in writeFile', async () => {
        await cm.runJob(testJob);
        await expect(cm.writeFile('job-001', '/tmp/../etc/passwd', 'bad'))
            .rejects.toThrow('path traversal');
    });
    it('should reject relative paths in writeFile', async () => {
        await cm.runJob(testJob);
        await expect(cm.writeFile('job-001', 'relative/path.txt', 'bad'))
            .rejects.toThrow('filepath must be absolute');
    });
    it('should reject shell metacharacters in filepath', async () => {
        await cm.runJob(testJob);
        await expect(cm.writeFile('job-001', '/tmp/test;rm -rf /', 'bad'))
            .rejects.toThrow('invalid characters');
    });
    it('should reject system paths like /proc', async () => {
        await cm.runJob(testJob);
        await expect(cm.writeFile('job-001', '/proc/self/environ', 'bad'))
            .rejects.toThrow('system paths not allowed');
    });
    // -- readFile --
    it('should read file from container via exec', async () => {
        await cm.runJob(testJob);
        const content = await cm.readFile('job-001', '/tmp/data.txt');
        expect(content).toBe('ok');
        expect(mockDocker.execCommand).toHaveBeenCalledWith('container-123', expect.stringContaining('/tmp/data.txt'));
    });
    it('should reject path traversal in readFile', async () => {
        await cm.runJob(testJob);
        await expect(cm.readFile('job-001', '/dev/null/../etc/shadow'))
            .rejects.toThrow('path traversal');
    });
    // -- getHealthStatus --
    it('should return undefined for unknown job', () => {
        expect(cm.getHealthStatus('nope')).toBeUndefined();
    });
    it('should return initial health status after run', async () => {
        await cm.runJob(testJob);
        const health = cm.getHealthStatus('job-001');
        expect(health).toBeDefined();
        expect(health.status).toBe('unknown');
        expect(health.failures).toBe(0);
    });
    // -- getRunningJobs --
    it('should return empty array with no jobs', () => {
        expect(cm.getRunningJobs()).toEqual([]);
    });
    it('should list multiple running jobs', async () => {
        await cm.runJob(testJob);
        await cm.runJob({ ...testJob, id: 'job-002' });
        const jobs = cm.getRunningJobs();
        expect(jobs).toHaveLength(2);
        expect(jobs).toContain('job-001');
        expect(jobs).toContain('job-002');
    });
});
