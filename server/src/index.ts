import { startServer } from './app.ts';
import { log } from './logger.ts';

startServer().catch((error: unknown) => {
  log('error', 'Mineview failed to start', error);
  process.exit(1);
});
