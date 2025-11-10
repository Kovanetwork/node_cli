import { logger } from '../lib/logger.js';

export async function stopCommand() {
  logger.info('stopping kova node...');
  
  // todo: graceful shutdown
  // - stop accepting new jobs
  // - wait for current jobs to finish
  // - cleanup containers
  // - leave p2p network
  
  console.log('node stopped (not implemented yet lol)');
}