import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    'bin/agentfw': 'src/bin/agentfw.ts',
    'bin/tap': 'src/bin/tap.ts',
    'bin/tools': 'src/bin/tools.ts',
  },
  format: 'esm',
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: false,
  // Packages that use dynamic `require(<relative>)` at runtime, which
  // bundlers can't statically resolve. Keep them external and resolve them
  // from node_modules at install time (declared in `dependencies`).
  //
  // - better-sqlite3: native .node binding + path-relative JS loader.
  // - jsonc-parser:   lazy-loads its formatter via `require('./impl/format')`.
  external: ['better-sqlite3', 'jsonc-parser'],
})
