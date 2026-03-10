// tests for DeploymentExecutor - deployment lifecycle, shell sessions, events

jest.mock('../lib/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }
}));

// mock dockerode
const mockStream = {
  on: jest.fn(),
  write: jest.fn(),
  end: jest.fn()
};

const mockExec = {
  start: jest.fn().mockResolvedValue(mockStream),
  resize: jest.fn()
};

const mockContainerInstance = {
  id: 'ctr-abc123',
  start: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined),
  remove: jest.fn().mockResolvedValue(undefined),
  inspect: jest.fn().mockResolvedValue({
    State: { Running: true, Status: 'running', StartedAt: new Date().toISOString(), FinishedAt: '0001-01-01T00:00:00Z', ExitCode: 0 },
    Config: { Image: 'node:20-alpine', Env: [], WorkingDir: '/', ExposedPorts: {} },
    HostConfig: { NetworkMode: 'bridge', Binds: [] },
    RestartCount: 0,
    Mounts: [],
    NetworkSettings: { Networks: {} }
  }),
  exec: jest.fn().mockResolvedValue(mockExec),
  logs: jest.fn().mockImplementation((_opts: any, cb: any) => {
    // noop - just don't call cb to avoid issues
  }),
  modem: {
    demuxStream: jest.fn()
  }
};

const mockNetwork = {
  id: 'net-123',
  remove: jest.fn().mockResolvedValue(undefined)
};

const mockVolume = {
  Name: 'kova-deploy1-web-data',
  remove: jest.fn().mockResolvedValue(undefined)
};

const mockDocker = {
  createContainer: jest.fn().mockResolvedValue(mockContainerInstance),
  createNetwork: jest.fn().mockResolvedValue(mockNetwork),
  createVolume: jest.fn().mockResolvedValue(mockVolume),
  getContainer: jest.fn().mockReturnValue(mockContainerInstance),
  getNetwork: jest.fn().mockReturnValue(mockNetwork),
  getVolume: jest.fn().mockReturnValue(mockVolume),
  listContainers: jest.fn().mockResolvedValue([]),
  listNetworks: jest.fn().mockResolvedValue([]),
  listVolumes: jest.fn().mockResolvedValue({ Volumes: [] }),
  pull: jest.fn().mockImplementation((_image: string, _optsOrCb: any, maybeCb?: any) => {
    // handle both pull(image, cb) and pull(image, opts, cb) signatures
    const cb = typeof maybeCb === 'function' ? maybeCb : _optsOrCb;
    const fakeStream = { on: jest.fn() };
    cb(null, fakeStream);
  }),
  modem: {
    followProgress: jest.fn().mockImplementation((_stream: any, onFinish: any) => {
      onFinish(null);
    })
  },
  run: jest.fn().mockResolvedValue(undefined)
};

jest.mock('dockerode', () => {
  return jest.fn().mockImplementation(() => mockDocker);
});

import { DeploymentExecutor } from '../services/deployment-executor';

describe('DeploymentExecutor', () => {
  let executor: DeploymentExecutor;

  const simpleManifest = {
    version: '2.0',
    services: {
      web: {
        image: 'nginx:latest',
        expose: [{ port: 80, as: 80, to: [{ global: true }] }]
      }
    },
    profiles: {
      compute: {
        webProfile: {
          resources: {
            cpu: { units: 2 },
            memory: { size: '512Mi' }
          }
        }
      }
    },
    deployment: {
      web: {
        myProvider: { profile: 'webProfile', count: 1 }
      }
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // reset container inspect to say it's not running (for create flow)
    mockContainerInstance.inspect.mockRejectedValue(new Error('not found'));
    executor = new DeploymentExecutor({
      orchestratorUrl: 'http://localhost:3000',
      apiKey: 'sk_test_key'
    });
  });

  // -- executeDeployment --

  it('should create network, pull image, create and start container', async () => {
    await executor.executeDeployment({
      deploymentId: 'deploy-1',
      leaseId: 'lease-1',
      manifest: simpleManifest as any
    });

    expect(mockDocker.createNetwork).toHaveBeenCalledWith(
      expect.objectContaining({
        Name: expect.stringContaining('kova-deploy-'),
        Driver: 'bridge'
      })
    );

    expect(mockDocker.pull).toHaveBeenCalledWith('nginx:latest', expect.any(Object), expect.any(Function));
    expect(mockDocker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        Image: 'nginx:latest',
        Labels: expect.objectContaining({
          'kova.deployment': 'deploy-1',
          'kova.service': 'web'
        })
      })
    );
    expect(mockContainerInstance.start).toHaveBeenCalled();
  });

  it('should emit deployment-started event', async () => {
    const events: any[] = [];
    executor.on('deployment-started', (data) => events.push(data));

    await executor.executeDeployment({
      deploymentId: 'deploy-1',
      leaseId: 'lease-1',
      manifest: simpleManifest as any
    });

    expect(events).toHaveLength(1);
    expect(events[0].deploymentId).toBe('deploy-1');
    expect(events[0].leaseId).toBe('lease-1');
  });

  it('should track deployment in running list', async () => {
    await executor.executeDeployment({
      deploymentId: 'deploy-1',
      leaseId: 'lease-1',
      manifest: simpleManifest as any
    });

    expect(executor.getRunningDeployments()).toContain('deploy-1');
  });

  it('should return deployment info via getDeployment', async () => {
    await executor.executeDeployment({
      deploymentId: 'deploy-1',
      leaseId: 'lease-1',
      manifest: simpleManifest as any
    });

    const dep = executor.getDeployment('deploy-1');
    expect(dep).toBeDefined();
    expect(dep!.deploymentId).toBe('deploy-1');
    expect(dep!.leaseId).toBe('lease-1');
  });

  it('should return undefined for unknown deployment', () => {
    expect(executor.getDeployment('nope')).toBeUndefined();
  });

  // -- resource limits from manifest --

  it('should apply memory limit from compute profile', async () => {
    await executor.executeDeployment({
      deploymentId: 'deploy-1',
      leaseId: 'lease-1',
      manifest: simpleManifest as any
    });

    const containerConfig = mockDocker.createContainer.mock.calls[0][0];
    // 512Mi = 512 * 1024^2 = 536870912 bytes
    expect(containerConfig.HostConfig.Memory).toBe(536870912);
  });

  it('should apply cpu limit from compute profile', async () => {
    await executor.executeDeployment({
      deploymentId: 'deploy-1',
      leaseId: 'lease-1',
      manifest: simpleManifest as any
    });

    const containerConfig = mockDocker.createContainer.mock.calls[0][0];
    // 2 cores: CpuQuota = 2 * 100000 = 200000
    expect(containerConfig.HostConfig.CpuQuota).toBe(200000);
  });

  // -- stopDeployment --

  it('should stop containers but preserve volumes', async () => {
    await executor.executeDeployment({
      deploymentId: 'deploy-1',
      leaseId: 'lease-1',
      manifest: simpleManifest as any
    });

    await executor.stopDeployment('deploy-1');

    expect(mockContainerInstance.stop).toHaveBeenCalled();
    expect(mockContainerInstance.remove).toHaveBeenCalled();
    expect(executor.getRunningDeployments()).not.toContain('deploy-1');
  });

  it('should silently handle stop for unknown deployment', async () => {
    await executor.stopDeployment('nonexistent');
    // no throw
  });

  // -- closeDeployment --

  it('should stop containers and delete volumes', async () => {
    await executor.executeDeployment({
      deploymentId: 'deploy-1',
      leaseId: 'lease-1',
      manifest: simpleManifest as any
    });

    await executor.closeDeployment('deploy-1');

    expect(mockContainerInstance.stop).toHaveBeenCalled();
    expect(executor.getRunningDeployments()).not.toContain('deploy-1');
    // should attempt to list and cleanup volumes
    expect(mockDocker.listVolumes).toHaveBeenCalled();
  });

  it('should attempt volume cleanup even if deployment is not in memory', async () => {
    await executor.closeDeployment('orphaned-deploy');
    expect(mockDocker.listVolumes).toHaveBeenCalledWith({
      filters: { name: ['kova-orphaned-deploy'] }
    });
  });

  // -- shell sessions --

  it('should start shell session in deployment container', async () => {
    await executor.executeDeployment({
      deploymentId: 'deploy-1',
      leaseId: 'lease-1',
      manifest: simpleManifest as any
    });

    // mock container inspect to say it's running for shell
    mockContainerInstance.inspect.mockResolvedValue({
      State: { Running: true, Status: 'running', StartedAt: new Date().toISOString(), FinishedAt: '0001-01-01T00:00:00Z', ExitCode: 0 },
      Config: { Image: 'node:20-alpine', Env: [], WorkingDir: '/', ExposedPorts: {} },
      HostConfig: { NetworkMode: 'bridge', Binds: [] },
      RestartCount: 0,
      Mounts: [],
      NetworkSettings: { Networks: {} }
    });

    const onOutput = jest.fn();
    const result = await executor.startShellSession('sess-1', 'deploy-1', 'web', onOutput);

    expect(result).toEqual({ success: true });
    expect(mockContainerInstance.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        Cmd: ['/bin/sh'],
        AttachStdin: true,
        AttachStdout: true,
        Tty: true
      })
    );
  });

  it('should return error for shell on unknown deployment', async () => {
    const result = await executor.startShellSession('sess-1', 'nope', 'web', jest.fn());
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should send input to shell session', async () => {
    await executor.executeDeployment({
      deploymentId: 'deploy-1',
      leaseId: 'lease-1',
      manifest: simpleManifest as any
    });

    mockContainerInstance.inspect.mockResolvedValue({
      State: { Running: true }, Config: { Image: 'test', Env: [], WorkingDir: '/', ExposedPorts: {} },
      HostConfig: { NetworkMode: 'bridge', Binds: [] }, RestartCount: 0, Mounts: [], NetworkSettings: { Networks: {} }
    });
    await executor.startShellSession('sess-1', 'deploy-1', 'web', jest.fn());

    const ok = executor.sendShellInput('sess-1', 'ls\n');
    expect(ok).toBe(true);
    expect(mockStream.write).toHaveBeenCalledWith('ls\n');
  });

  it('should return false for input to nonexistent session', () => {
    expect(executor.sendShellInput('nope', 'ls')).toBe(false);
  });

  it('should resize shell terminal', async () => {
    await executor.executeDeployment({
      deploymentId: 'deploy-1',
      leaseId: 'lease-1',
      manifest: simpleManifest as any
    });

    mockContainerInstance.inspect.mockResolvedValue({
      State: { Running: true }, Config: { Image: 'test', Env: [], WorkingDir: '/', ExposedPorts: {} },
      HostConfig: { NetworkMode: 'bridge', Binds: [] }, RestartCount: 0, Mounts: [], NetworkSettings: { Networks: {} }
    });
    await executor.startShellSession('sess-1', 'deploy-1', 'web', jest.fn());

    const ok = executor.resizeShell('sess-1', 120, 40);
    expect(ok).toBe(true);
    expect(mockExec.resize).toHaveBeenCalledWith({ h: 40, w: 120 });
  });

  it('should close shell session', async () => {
    await executor.executeDeployment({
      deploymentId: 'deploy-1',
      leaseId: 'lease-1',
      manifest: simpleManifest as any
    });

    mockContainerInstance.inspect.mockResolvedValue({
      State: { Running: true }, Config: { Image: 'test', Env: [], WorkingDir: '/', ExposedPorts: {} },
      HostConfig: { NetworkMode: 'bridge', Binds: [] }, RestartCount: 0, Mounts: [], NetworkSettings: { Networks: {} }
    });
    await executor.startShellSession('sess-1', 'deploy-1', 'web', jest.fn());

    executor.closeShellSession('sess-1');
    expect(mockStream.end).toHaveBeenCalled();

    // session should be gone now
    expect(executor.sendShellInput('sess-1', 'test')).toBe(false);
  });

  // -- security --

  it('should set security options on container', async () => {
    await executor.executeDeployment({
      deploymentId: 'deploy-1',
      leaseId: 'lease-1',
      manifest: simpleManifest as any
    });

    const containerConfig = mockDocker.createContainer.mock.calls[0][0];
    expect(containerConfig.HostConfig.Privileged).toBe(false);
    expect(containerConfig.HostConfig.CapDrop).toContain('ALL');
    expect(containerConfig.HostConfig.SecurityOpt).toContain('no-new-privileges:true');
  });

  // -- multi-service --

  it('should start multiple services from manifest', async () => {
    const multiManifest = {
      ...simpleManifest,
      services: {
        web: { image: 'nginx:latest' },
        api: { image: 'node:20' }
      },
      deployment: {
        web: { myProvider: { profile: 'webProfile', count: 1 } },
        api: { myProvider: { profile: 'webProfile', count: 1 } }
      }
    };

    await executor.executeDeployment({
      deploymentId: 'deploy-1',
      leaseId: 'lease-1',
      manifest: multiManifest as any
    });

    // should have pulled both images
    expect(mockDocker.pull).toHaveBeenCalledTimes(2);
    // should have created 2 containers
    expect(mockDocker.createContainer).toHaveBeenCalledTimes(2);
  });
});
