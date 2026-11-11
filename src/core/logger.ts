import { redactDeep } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Sink for tests; defaults to stderr. stdout is reserved for the MCP protocol. */
  sink?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const threshold = LEVEL_ORDER[level];
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));

  const write = (entryLevel: Exclude<LogLevel, 'silent'>, event: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[entryLevel] < threshold) {
      return;
    }
    const payload = redactDeep({
      ts: new Date().toISOString(),
      level: entryLevel,
      event,
      ...(fields ?? {}),
    });
    try {
      sink(JSON.stringify(payload));
    } catch {
      sink(JSON.stringify({ ts: new Date().toISOString(), level: 'error', event: 'log_serialization_failed' }));
    }
  };

  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}

export function silentLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}
