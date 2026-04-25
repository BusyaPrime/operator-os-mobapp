const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

// Alias the historical workspace package names to inlined sources so
// the migrated mobile code can keep its `@operator-os/contracts` and
// `@operator-os/config` imports unchanged. Keeps the migration to a
// standalone repo a copy + alias job; not a refactor.
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  '@operator-os/contracts': path.resolve(projectRoot, 'src/contracts'),
  '@operator-os/config': path.resolve(projectRoot, 'src/config')
};

// TS NodeNext + ESM convention: source files import siblings with the
// `.js` extension because that is the post-compile shape. `tsc` resolves
// `.js` to `.ts`. Metro doesn't by default. This resolver hook strips
// a trailing `.js` from a relative import when the literal file is
// missing and retries; if the .ts/.tsx source exists we get a normal
// resolve. Same pattern as the monorepo's metro.config.js.
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName.endsWith('.js') &&
    (moduleName.startsWith('.') || moduleName.startsWith('/'))
  ) {
    try {
      return context.resolveRequest(
        context,
        moduleName.replace(/\.js$/, ''),
        platform
      );
    } catch {
      // fall through
    }
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
