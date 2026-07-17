export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  requestId?: string;
  organizationId?: string;
  userId?: string;
  provider?: string;
  action?: string;
  [key: string]: unknown;
}

export interface StructuredLogMessage {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

export class Logger {
  private defaultContext: LogContext;

  constructor(defaultContext: LogContext = {}) {
    this.defaultContext = defaultContext;
  }

  private log(level: LogLevel, message: string, context?: LogContext, err?: Error): void {
    const payload: StructuredLogMessage = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: { ...this.defaultContext, ...context },
    };

    if (err) {
      payload.error = {
        name: err.name,
        message: err.message,
        stack: err.stack,
      };
    }

    const jsonOutput = JSON.stringify(payload);

    switch (level) {
      case 'error':
        console.error(jsonOutput);
        break;
      case 'warn':
        console.warn(jsonOutput);
        break;
      case 'info':
      case 'debug':
      default:
        console.log(jsonOutput);
        break;
    }
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  error(message: string, err?: Error, context?: LogContext): void {
    this.log('error', message, context, err);
  }

  child(additionalContext: LogContext): Logger {
    return new Logger({ ...this.defaultContext, ...additionalContext });
  }
}

export const defaultLogger = new Logger({ service: 'tugpt-platform' });
