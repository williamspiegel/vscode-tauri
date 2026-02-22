import { createLogger, defineConfig } from 'vite';

const logger = createLogger();
const loggerWarn = logger.warn;
const loggerWarnOnce = logger.warnOnce?.bind(logger);

function shouldSuppressWarning(message: string): boolean {
  return (
    (message.includes('Sourcemap for "') && message.includes('points to missing source files')) ||
    message.includes('The above dynamic import cannot be analyzed by Vite.') ||
    message.includes('Plugin: vite:import-analysis') ||
    message.includes('packages/dynamic-import-vars#limitations')
  );
}

logger.warn = (message, options) => {
  if (typeof message === 'string' && shouldSuppressWarning(message)) {
    return;
  }

  loggerWarn(message, options);
};

if (loggerWarnOnce) {
  logger.warnOnce = (message, options) => {
    if (typeof message === 'string' && shouldSuppressWarning(message)) {
      return;
    }

    loggerWarnOnce(message, options);
  };
}

export default defineConfig({
  customLogger: logger,
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    fs: {
      allow: ['..', '../../..', '../../../..']
    }
  }
});
