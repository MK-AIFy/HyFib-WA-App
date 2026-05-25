export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogMetadata {
  [key: string]: unknown;
}

export class Logger {
  constructor(private readonly component: string, private readonly minimum: LogLevel = "info") {}

  debug(message: string, metadata: LogMetadata = {}): void {
    this.write("debug", message, metadata);
  }

  info(message: string, metadata: LogMetadata = {}): void {
    this.write("info", message, metadata);
  }

  warn(message: string, metadata: LogMetadata = {}): void {
    this.write("warn", message, metadata);
  }

  error(message: string, metadata: LogMetadata = {}): void {
    this.write("error", message, metadata);
  }

  private write(level: LogLevel, message: string, metadata: LogMetadata): void {
    if (!shouldLog(this.minimum, level)) {
      return;
    }

    const payload = {
      ts: new Date().toISOString(),
      level,
      component: this.component,
      message,
      ...metadata
    };

    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
}

function shouldLog(minimum: LogLevel, requested: LogLevel): boolean {
  const order: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40
  };
  return order[requested] >= order[minimum];
}
