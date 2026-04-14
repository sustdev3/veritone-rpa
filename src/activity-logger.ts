import winston from 'winston';
import path from 'path';
import fs from 'fs';

const LOG_DIR = path.resolve(__dirname, '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const LOG_FILE = path.join(LOG_DIR, 'run.log');

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message }) => {
    return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
  })
);

export const logger = winston.createLogger({
  level: 'info',
  format: logFormat,
  transports: [
    new winston.transports.Console(),
  ],
});

/**
 * Clears the previous run.log and attaches a fresh file transport.
 * Call this once at the start of each bot run (before the first log line),
 * so the file only contains the current session's logs.
 */
export function initFileLogging(): void {
  try { fs.unlinkSync(LOG_FILE); } catch {}
  logger.add(new winston.transports.File({ filename: LOG_FILE }));
}
