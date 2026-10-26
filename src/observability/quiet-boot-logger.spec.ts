import { QuietBootLogger } from './quiet-boot-logger';

describe('QuietBootLogger', () => {
  const inner = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
    fatal: jest.fn(),
  };
  const logger = new QuietBootLogger(inner);

  beforeEach(() => jest.clearAllMocks());

  it('drops the three contexts that make up the boot burst', () => {
    for (const context of [
      'RouterExplorer',
      'RoutesResolver',
      'InstanceLoader',
    ]) {
      logger.log(`Mapped {/api/thing, GET} route`, context);
    }
    expect(inner.log).not.toHaveBeenCalled();
  });

  it('keeps the start-up lines that say whether anything works', () => {
    logger.log('Database connection established', 'PrismaService');
    logger.log('Redis connection ready', 'RedisService');
    logger.log('Permission catalogue synced', 'PermissionCatalogService');
    expect(inner.log).toHaveBeenCalledTimes(3);
  });

  it('never filters an error or a warning, whatever the context', () => {
    // The entire point: a crash during boot must survive, even if it is
    // attributed to one of the noisy contexts.
    logger.error('Nest could not resolve dependencies', 'InstanceLoader');
    logger.warn('something looks wrong', 'RouterExplorer');
    logger.fatal('out of memory', 'RoutesResolver');

    expect(inner.error).toHaveBeenCalledTimes(1);
    expect(inner.warn).toHaveBeenCalledTimes(1);
    expect(inner.fatal).toHaveBeenCalledTimes(1);
  });

  it('passes through a message with no context at all', () => {
    logger.log('bare message');
    expect(inner.log).toHaveBeenCalledWith('bare message');
  });
});
