// @ts-ignore-next-line
import Hyperswarm from 'hyperswarm';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { logger } from './logger.js';
import { MessageSigner } from './message-signer.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export class P2PNode extends EventEmitter {
  private swarm: any;
  private topic: Buffer;
  private connections: Map<string, any> = new Map();
  private signer: MessageSigner;
  private keyPair: any;

  constructor(options: { port: number; bootstrapNodes: string[] }) {
    super();
    this.signer = new MessageSigner();
    this.topic = crypto.createHash('sha256').update('kova-network').digest();
    this.keyPair = this.loadOrGenerateKeyPair();
  }

  private loadOrGenerateKeyPair() {
    const kovaDir = join(homedir(), '.kova');
    const keyPath = join(kovaDir, 'node-keypair.json');

    try {
      if (existsSync(keyPath)) {
        const data = JSON.parse(readFileSync(keyPath, 'utf8'));
        logger.info('loaded existing node keypair');
        return {
          publicKey: Buffer.from(data.publicKey, 'hex'),
          secretKey: Buffer.from(data.secretKey, 'hex')
        };
      }
    } catch (err) {
      logger.warn({ err }, 'failed to load keypair, generating new one');
    }

    // generate new keypair
    const publicKey = crypto.randomBytes(32);
    const secretKey = crypto.randomBytes(32);

    try {
      if (!existsSync(kovaDir)) {
        mkdirSync(kovaDir, { recursive: true });
      }
      writeFileSync(keyPath, JSON.stringify({
        publicKey: publicKey.toString('hex'),
        secretKey: secretKey.toString('hex')
      }));
      logger.info('generated and saved new node keypair');
    } catch (err) {
      logger.warn({ err }, 'failed to save keypair');
    }

    return { publicKey, secretKey };
  }

  async start() {
    this.swarm = new Hyperswarm({ keyPair: this.keyPair });

    // join the kova network topic
    this.swarm.join(this.topic, { server: true, client: true });

    // handle new connections
    this.swarm.on('connection', (socket: any, info: any) => {
      const connId = info.publicKey.toString('hex').substring(0, 12);
      this.connections.set(connId, socket);

      logger.info({ connId, peer: info.publicKey.toString('hex') }, 'new peer connected');

      // handle incoming messages
      socket.on('data', (data: Buffer) => {
        try {
          const signedMessage = JSON.parse(data.toString());

          if (!this.signer.verify(signedMessage)) {
            logger.warn({ connId }, 'rejected message with bad signature');
            return;
          }

          this.handleMessage(signedMessage.payload, socket);
        } catch (err) {
          logger.debug({ err }, 'failed to parse p2p message');
        }
      });

      socket.on('close', () => {
        this.connections.delete(connId);
        logger.debug({ connId }, 'peer disconnected');
      });

      socket.on('error', (err: Error) => {
        logger.debug({ err, connId }, 'peer connection error');
      });
    });

    logger.info({
      topic: this.topic.toString('hex'),
      connections: this.connections.size
    }, 'p2p node started');
  }

  private handleMessage(message: any, socket: any) {
    switch (message.type) {
      case 'job-request':
        this.emit('job-request', message.data);
        break;

      case 'job-cancel':
        this.emit('job-cancel', message.data);
        break;

      case 'deployment-manifest':
        this.emit('deployment-manifest', message.data);
        break;

      case 'deployment-close':
        this.emit('deployment-close', message.data);
        break;

      case 'deployment-paused':
        this.emit('deployment-paused', message.data);
        break;

      case 'node-announcement':
        break;

      default:
        logger.debug({ type: message.type }, 'unknown message type');
    }
  }

  async stop() {
    if (this.swarm) {
      await this.swarm.destroy();
      logger.info('p2p node stopped');
    }
  }

  async advertiseCapabilities(resources: any) {
    const payload = {
      type: 'node-announcement',
      data: {
        nodeId: this.getPeerId(),
        resources,
        version: '0.0.1'
      }
    };

    const signedMessage = this.signer.sign(payload);

    for (const socket of this.connections.values()) {
      try {
        socket.write(JSON.stringify(signedMessage));
      } catch (err) {
        // connection probably dead
      }
    }

    logger.info({ resources }, 'advertised capabilities to network');
  }

  getPeerId(): string {
    // use swarm keyPair public key as peer id
    return this.swarm?.keyPair?.publicKey?.toString('hex').substring(0, 16) || 'unknown';
  }

  async sendToOrchestrator(message: any) {
    const signedMessage = this.signer.sign(message);

    for (const socket of this.connections.values()) {
      try {
        socket.write(JSON.stringify(signedMessage));
        return true;
      } catch (err) {
        continue;
      }
    }
    return false;
  }

  getConnectionCount(): number {
    return this.connections.size;
  }
}
