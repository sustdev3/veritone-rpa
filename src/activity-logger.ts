import winston from 'winston';
import path from 'path';

const LOG_DIR = path.resolve(__dirname, '..', 'logs');

export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    })
  ),
  transports: [
    // Console output
    new winston.transports.Console(),
    // Rolling daily log file
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'rpa.log'),
      maxsize: 5 * 1024 * 1024, // 5 MB
      maxFiles: 7,
    }),
  ],
});
