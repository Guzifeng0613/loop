import { createApp } from './app.js';
import { config } from './config.js';

const context = await createApp();

const shutdown = async () => {
  await context.app.close();
  context.store.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await context.app.listen({ host: config.host, port: config.port });
