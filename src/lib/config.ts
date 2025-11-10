import convict from 'convict';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// config with sensible defaults
const schema = {
  node: {
    id: {
      doc: 'unique node identifier',
      format: String,
      default: '',
      env: 'KOVA_NODE_ID'
    },
    name: {
      doc: 'friendly name for this node',
      format: String,
      default: 'kova-node',
      env: 'KOVA_NODE_NAME'
    }
  },
  network: {
    port: {
      doc: 'p2p port to listen on',
      format: 'port',
      default: 4001,
      env: 'KOVA_P2P_PORT'
    },
    bootstrapNodes: {
      doc: 'initial nodes to connect to',
      format: Array,
      default: [],
      env: 'KOVA_BOOTSTRAP_NODES'
    }
  },
  orchestratorUrl: {
    doc: 'orchestrator API URL for registration',
    format: String,
    default: 'https://test.kovanetwork.com',
    env: 'KOVA_ORCHESTRATOR_URL'
  },
  resources: {
    maxCpu: {
      doc: 'max cpu cores to offer',
      format: Number,
      default: 0, // 0 = auto detect
      env: 'KOVA_MAX_CPU'
    },
    maxMemory: {
      doc: 'max memory in gb to offer',
      format: Number,
      default: 0, // 0 = auto detect
      env: 'KOVA_MAX_MEMORY'
    },
    maxDisk: {
      doc: 'max disk space in gb to offer',
      format: Number,
      default: 100,
      env: 'KOVA_MAX_DISK'
    }
  },
  earnings: {
    wallet: {
      doc: 'wallet address for payments',
      format: String,
      default: '',
      env: 'KOVA_WALLET_ADDRESS'
    }
  }
};

export class NodeConfig {
  private static instance: convict.Config<any>;
  
  static async load(configPath?: string): Promise<any> {
    this.instance = convict(schema);

    // try to load config from file
    const paths = [
      configPath,
      join(process.cwd(), 'kova.config.json'),
      join(homedir(), '.kova', 'config.json')
    ].filter(p => p);

    for (const path of paths) {
      if (path && existsSync(path)) {
        try {
          const configFile = readFileSync(path, 'utf8');
          this.instance.load(JSON.parse(configFile));
          break;
        } catch (err) {
          // whatever just use defaults
        }
      }
    }

    // validate it
    this.instance.validate({ allowed: 'strict' } as any);

    return this.instance.getProperties();
  }
  
  static get(path?: string): any {
    if (!this.instance) {
      throw new Error('config not loaded yet');
    }
    if (path) {
      // @ts-ignore - convict types are too complex
      const result: any = this.instance.get(path);
      return result;
    }
    return this.instance.getProperties();
  }
}