import pino from 'pino';

// just a logger nothing fancy
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: { 
      colorize: true,
      ignore: 'pid,hostname'
    }
  } : undefined
});