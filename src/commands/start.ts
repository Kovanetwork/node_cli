import { logger } from '../lib/logger.js';
import { P2PNode } from '../lib/p2p.js';
import { DockerManager } from '../lib/docker.js';
import { ResourceMonitor } from '../lib/monitor.js';
import { NodeConfig } from '../lib/config.js';
import { ContainerManager } from '../services/container-manager.js';
import { JobHandler } from '../services/job-handler.js';
import { HeartbeatService } from '../services/heartbeat.js';
import { NodeAPIServer } from '../api/server.js';
import { stateManager } from '../lib/state.js';
import { ResourceLimitManager } from '../lib/resource-limits.js';
import { AutoBidder } from '../services/auto-bidder.js';
import { LeaseHandler } from '../services/lease-handler.js';
import { DeploymentExecutor } from '../services/deployment-executor.js';

async function registerWithOrchestrator(
  nodeId: string,
  resources: any,
  apiKey?: string,
  walletAddress?: string,
  orchestratorUrl?: string
): Promise<{ providerId: string; walletAddress?: string } | null> {
  if (!orchestratorUrl) {
    logger.warn('no orchestrator URL configured, skipping HTTP registration');
    return null;
  }

  try {
    const body: any = {
      nodeId,
      resources,
      timestamp: Date.now(),
      version: '0.0.1'
    };

    // prefer api key over wallet
    if (apiKey) {
      body.apiKey = apiKey;
    } else if (walletAddress) {
      body.walletAddress = walletAddress;
    }

    const response = await fetch(`${orchestratorUrl}/api/v1/nodes/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (response.ok) {
      const data: any = await response.json();
      logger.info({
        orchestratorUrl,
        walletAddress: data.walletAddress,
        providerId: data.providerId
      }, 'registered with orchestrator');
      return {
        providerId: data.providerId,
        walletAddress: data.walletAddress
      };
    } else {
      logger.warn({ status: response.status }, 'failed to register with orchestrator');
      return null;
    }
  } catch (err) {
    logger.warn({ err }, 'could not reach orchestrator for HTTP registration');
    return null;
  }
}

export async function startNode(options: any) {
  logger.info('starting kova node...');

  // check for authentication (api key or wallet)
  const apiKey = options.apiKey || options.k;
  const walletAddress = options.wallet || options.w;

  if (!apiKey && !walletAddress) {
    console.error('\n❌ ERROR: Either --api-key or --wallet is required');
    console.error('\nRecommended: kova-node start --api-key YOUR_API_KEY');
    console.error('Legacy: kova-node start --wallet YOUR_WALLET_ADDRESS');
    console.error('\nGet your API key from https://test.kovanetwork.com/provider');
    process.exit(1);
  }

  // validate wallet address format if provided
  if (walletAddress && !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    console.error('\n❌ ERROR: Invalid wallet address format');
    console.error('Wallet address must be a valid Ethereum address (0x followed by 40 hex characters)');
    console.error(`Provided: ${walletAddress}`);
    process.exit(1);
  }

  // validate api key format if provided
  if (apiKey && !apiKey.startsWith('sk_live_')) {
    console.error('\n❌ ERROR: Invalid API key format');
    console.error('API key must start with sk_live_');
    console.error(`Provided: ${apiKey.substring(0, 15)}...`);
    process.exit(1);
  }

  // mark as running
  stateManager.setRunning(process.pid);

  // load config or use defaults
  const config = await NodeConfig.load(options.config);

  // setup resource limits based on CLI args
  const limitManager = await ResourceLimitManager.createFromOptions({
    maxCpu: options.maxCpu,
    maxMemory: options.maxMemory,
    maxDisk: options.maxDisk
  });

  // check if docker is even running
  const docker = new DockerManager();
  const dockerReady = await docker.checkDocker();
  if (!dockerReady) {
    logger.error('docker not running... install docker first');
    process.exit(1);
  }

  // start monitoring resources
  const monitor = new ResourceMonitor();
  await monitor.start();

  // join the p2p network
  const p2p = new P2PNode({
    port: parseInt(options.port) || 4001,
    bootstrapNodes: config.bootstrapNodes
  });

  try {
    await p2p.start();

    const nodeId = p2p.getPeerId();
    logger.info({ nodeId, walletAddress }, 'connected to kova network');

    // get system resources but use provider limits
    const systemResources = await monitor.getAvailableResources();
    const providerLimits = limitManager.getLimits();

    // advertise provider limits, not full system resources
    const advertisedResources = {
      cpu: {
        cores: providerLimits.cpu,
        available: providerLimits.cpu
      },
      memory: {
        total: providerLimits.memory,
        available: providerLimits.memory
      },
      disk: systemResources.disk,
      network: systemResources.network
    };

    await p2p.advertiseCapabilities(advertisedResources);

    // register with orchestrator via HTTP
    const registrationResult = await registerWithOrchestrator(nodeId, advertisedResources, apiKey, walletAddress, config.orchestratorUrl);
    const registered = !!registrationResult;
    const effectiveWallet = registrationResult?.walletAddress || walletAddress;

    if (registered) {
      console.log('\n========================================');
      console.log('✓ KOVA NODE STARTED SUCCESSFULLY');
      console.log('========================================');
      console.log(`Node ID: ${nodeId}`);
      console.log(`Wallet: ${effectiveWallet}`);
      console.log(`\nAllocated Resources:`);
      console.log(`CPU: ${providerLimits.cpu} cores`);
      console.log(`Memory: ${providerLimits.memory} GB`);
      console.log(`Disk: ${providerLimits.disk} GB`);
      console.log(`\nDashboard: https://test.kovanetwork.com`);
      console.log('Connect with your wallet to view earnings');
      console.log('========================================\n');
    } else {
      console.log('\n⚠️  Node started but registration failed');
      console.log('Check orchestrator connection and try again\n');
    }

    // start heartbeat service to keep orchestrator updated
    let heartbeat: HeartbeatService | null = null;
    if (config.orchestratorUrl) {
      heartbeat = new HeartbeatService(nodeId, config.orchestratorUrl, monitor, limitManager, 10);
      await heartbeat.start();
      logger.info('heartbeat service started - sending status every 10 seconds');
    } else {
      logger.warn('no orchestrator URL configured - heartbeat disabled');
    }

    // setup job handling
    const containerMgr = new ContainerManager();
    await containerMgr.start();

    const jobHandler = new JobHandler(p2p, containerMgr, limitManager, config.orchestratorUrl);

    // initialize deployment executor early if orchestrator configured
    let deploymentExecutor: DeploymentExecutor | null = null;
    if (config.orchestratorUrl && registered && registrationResult) {
      deploymentExecutor = new DeploymentExecutor();

      // discover any existing deployments from previous runs
      await deploymentExecutor.discoverExistingDeployments();

      logger.info('deployment executor initialized');
    }

    // start api server for exec/logs (with deployment executor if available)
    const apiServer = new NodeAPIServer(containerMgr, deploymentExecutor || undefined, 4002);
    await apiServer.start();

    // listen for pending jobs from heartbeat
    const processedJobs = new Set<string>();
    if (heartbeat) {
      heartbeat.on('pending-jobs', (jobs) => {
        logger.info({ count: jobs.length }, 'processing pending jobs from heartbeat');
        for (const job of jobs) {
          // skip if already processed
          if (processedJobs.has(job.id)) {
            continue;
          }
          processedJobs.add(job.id);

          jobHandler.handleJob(job).catch(err => {
            logger.error({ err, jobId: job.id }, 'failed to handle job from heartbeat');
          });
        }
      });

      // clean up processed jobs set periodically
      setInterval(() => {
        processedJobs.clear();
      }, 5 * 60 * 1000); // every 5 minutes
    }

    // wire up earnings tracking
    jobHandler.on('job-completed', ({ jobId, earnings }) => {
      logger.info({ jobId, earnings }, 'earned from job');
      stateManager.addEarnings(earnings);
      stateManager.incrementCompleted();
    });

    jobHandler.on('job-failed', ({ jobId }) => {
      logger.warn({ jobId }, 'job failed');
      stateManager.incrementFailed();
    });

    // listen for jobs
    p2p.on('job-request', async (job) => {
      // only log non-sensitive job info (NOT env vars)
      logger.info({
        jobId: job.id,
        image: job.image,
        resources: job.resources
        // intentionally NOT logging: env, userId (privacy)
      }, 'got a job request');
      const accepted = await jobHandler.handleJob(job);
      if (accepted) {
        logger.info({ jobId: job.id }, 'job accepted and running');
      }
    });

    // new deployment system
    let autoBidder: AutoBidder | null = null;
    let leaseHandler: LeaseHandler | null = null;

    if (config.orchestratorUrl && registered && registrationResult) {
      // use provider id from registration
      const providerId = registrationResult.providerId;

      // ensure provider account exists
      try {
        const providerRes = await fetch(`${config.orchestratorUrl}/api/v1/auth/test-token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: providerId, role: 'provider' })
        });
        if (providerRes.ok) {
          logger.info({ providerId }, 'provider account ready');
        }
      } catch (err) {
        logger.warn('failed to verify provider account');
      }

      // deployment executor already initialized above
      // setup auto-bidder for competitive bidding
      autoBidder = new AutoBidder({
        nodeId,
        providerId,
        orchestratorUrl: config.orchestratorUrl,
        pricingStrategy: {
          cpuPricePerCore: 0.00017,  // ~$0.01 per core per hour
          memoryPricePerGb: 0.00008, // ~$0.005 per GB per hour
          margin: 0.9                // bid 10% below cost to win
        }
      }, monitor);

      autoBidder.start(15000); // check for orders every 15s
      logger.info({ nodeId }, 'auto-bidder started - will bid on suitable orders');

      // setup lease handler
      if (!deploymentExecutor) {
        throw new Error('deployment executor not initialized');
      }

      leaseHandler = new LeaseHandler({
        nodeId,
        providerId,
        orchestratorUrl: config.orchestratorUrl
      }, deploymentExecutor);

      leaseHandler.start(10000); // check for leases every 10s
      logger.info({ nodeId }, 'lease handler started - will execute assigned deployments');
    }

    // keep running until ctrl+c
    process.on('SIGINT', async () => {
      logger.info('shutting down...');
      stateManager.setStopped();

      if (autoBidder) {
        autoBidder.stop();
      }

      if (leaseHandler) {
        leaseHandler.stop();
      }

      if (heartbeat) {
        await heartbeat.stop();
      }

      await apiServer.stop();
      await containerMgr.stop();
      await p2p.stop();
      await monitor.stop();
      process.exit(0);
    });

  } catch (err) {
    logger.error({ err }, 'failed to start');
    process.exit(1);
  }
}