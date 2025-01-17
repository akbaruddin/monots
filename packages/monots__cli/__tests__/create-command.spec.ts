import { loadJsonFile } from 'load-json-file';
import { expect, test } from 'vitest';

import { cli } from '../src/setup';
import { setupFixtures } from './helpers';

test('`monots create` should create package with a description', async () => {
  const { context, getPath, cleanup } = await setupFixtures('pnpm-with-packages');
  const result = await cli.run(['create', '--description', 'DDD', '@scoped/d'], context);
  const json = await loadJsonFile<any>(getPath('packages/scoped__d/package.json'));

  expect(result).toBe(0);
  expect(json.name).toBe('@scoped/d');
  expect(json.description).toBe('DDD');
  expect(json.exports).toEqual({
    '.': {
      browser: './dist/index.browser.esm.js',
      import: './dist/index.esm.js',
      types: './dist/index.d.ts',
    },
    './index.js': {
      browser: './dist/index.browser.esm.js',
      import: './dist/index.esm.js',
      types: './dist/index.d.ts',
    },
    './package.json': './package.json',
    './types/*': './dist/*.d.ts',
  });

  await cleanup();
});

test('`monots create` should not overwrite existing packages', async () => {
  const { cleanup, context } = await setupFixtures('pnpm-with-packages');
  const result = await cli.run(['create', '--description', 'C', '@scoped/c'], context);

  expect(result).toBe(1);

  await cleanup();
});
