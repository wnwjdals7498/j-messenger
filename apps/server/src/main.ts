import { loadConfig } from './platform/config/index.js';
import { createLogger } from './platform/logging/index.js';
import { createApplication } from './bootstrap/application.js';

let logger: ReturnType<typeof createLogger> | undefined;
try {
  const config = loadConfig();
  logger = createLogger({
    release: config.release,
    module: 'server',
    level: config.logLevel,
  });
  const application = await createApplication(config, { logger });
  await application.app.listen({ host: config.host, port: config.port });
  logger.emit({
    featureId: 'F40',
    event: 'service.ready',
    outcome: 'success',
    fields: { phase: 'listening' },
  });
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      void application.close().then(
        () => {
          process.exitCode = 0;
        },
        () => {
          process.exitCode = 1;
        },
      );
    });
} catch {
  if (logger)
    logger.emit({
      featureId: 'F40',
      event: 'service.failed',
      outcome: 'failure',
      fields: { reasonCode: 'startup_failed' },
    });
  else
    process.stderr.write(
      JSON.stringify({
        time: new Date().toISOString(),
        featureId: 'F38',
        event: 'config.failed',
        outcome: 'failure',
        errorCode: 'configuration_invalid',
      }) + '\n',
    );
  process.exitCode = 1;
}
