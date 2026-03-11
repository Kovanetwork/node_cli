import crypto from 'crypto';
import { logger } from './logger.js';
export class MessageSigner {
    privateKey;
    publicKey;
    publicKeyPem;
    usedNonces = new Set();
    nonceCleanupInterval;
    constructor(keyPair) {
        if (keyPair) {
            this.privateKey = crypto.createPrivateKey(keyPair.privateKey);
            this.publicKey = crypto.createPublicKey(keyPair.publicKey);
            this.publicKeyPem = keyPair.publicKey;
        }
        else {
            const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
            this.privateKey = privateKey;
            this.publicKey = publicKey;
            this.publicKeyPem = this.publicKey.export({ type: 'spki', format: 'pem' }).toString();
        }
        // cleanup old nonces every 5 min to prevent replay attacks
        this.nonceCleanupInterval = setInterval(() => {
            this.usedNonces.clear();
        }, 5 * 60 * 1000);
    }
    sign(payload) {
        const timestamp = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const message = {
            payload,
            timestamp,
            nonce
        };
        const messageString = JSON.stringify(message);
        const signature = crypto.sign(null, Buffer.from(messageString), this.privateKey);
        return {
            payload,
            signature: signature.toString('base64'),
            publicKey: this.publicKeyPem,
            timestamp,
            nonce
        };
    }
    verify(signedMessage, maxAge = 60000) {
        try {
            // reject old or future messages
            const age = Date.now() - signedMessage.timestamp;
            if (age > maxAge || age < 0) {
                logger.warn({ age, maxAge }, 'message timestamp out of range');
                return false;
            }
            // prevent replay attacks
            if (this.usedNonces.has(signedMessage.nonce)) {
                logger.warn({ nonce: signedMessage.nonce }, 'nonce already used');
                return false;
            }
            const message = {
                payload: signedMessage.payload,
                timestamp: signedMessage.timestamp,
                nonce: signedMessage.nonce
            };
            const messageString = JSON.stringify(message);
            const signature = Buffer.from(signedMessage.signature, 'base64');
            const publicKey = crypto.createPublicKey(signedMessage.publicKey);
            const isValid = crypto.verify(null, Buffer.from(messageString), publicKey, signature);
            if (isValid) {
                this.usedNonces.add(signedMessage.nonce);
            }
            return isValid;
        }
        catch (err) {
            logger.error({ err }, 'failed to verify signature');
            return false;
        }
    }
    getPublicKey() {
        return this.publicKeyPem;
    }
    getPrivateKey() {
        return this.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    }
    getFingerprint() {
        const hash = crypto.createHash('sha256');
        hash.update(this.publicKeyPem);
        return hash.digest('hex').substring(0, 16);
    }
    destroy() {
        if (this.nonceCleanupInterval) {
            clearInterval(this.nonceCleanupInterval);
        }
        this.usedNonces.clear();
    }
}
