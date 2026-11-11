#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServices } from './app.js';
import { createLogger, type LogLevel } from './core/logger.js';
import { createEmailMcpServer } from './server.js';

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error', 'silent'];

function resolveLogLevel(value: string | undefined): LogLevel {
  if (value !== undefined && (LOG_LEVELS as readonly string[]).includes(value)) {
    return value as LogLevel;
  }
  return 'info';
}

async function main(): Promise<void> {
  const logger = createLogger({ level: resolveLogLevel(process.env.EMAIL_LOG_LEVEL) });
  const services = await buildServices({ env: process.env, logger });
  const server = createEmailMcpServer(services);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('server_started', {
    accounts: services.config.accounts.map((account) => account.id),
    send_enabled: services.policy.status().global_send_enabled,
    data_dir: services.config.dataDir,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('server_stopping', { signal });
    try {
      await server.close();
    } catch (error) {
      logger.warn('server_close_failed', { error });
    }
    try {
      await services.accounts.closeAll();
    } catch (error) {
      logger.warn('account_close_failed', { error });
    }
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

main().catch((error: unknown) => {
  const logger = createLogger({ level: 'error' });
  logger.error('startup_failed', { error });
  process.exitCode = 1;
});
