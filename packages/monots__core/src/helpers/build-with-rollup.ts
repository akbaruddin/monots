import alias from '@rollup/plugin-alias';
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import replace from '@rollup/plugin-replace';
import type { Options } from '@swc/core';
import { transform } from '@swc/core';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import normalizePath from 'normalize-path';
import type { OutputAsset, OutputChunk, OutputOptions, Plugin, RollupOptions } from 'rollup';
import { rollup } from 'rollup';

import { FIELD_EXTENSIONS, OUTPUT_FOLDER } from '../constants.js';
import type { PackageEntity } from '../entities/index.js';
import type { EntrypointField } from '../schema.js';
import { BatchError, FatalError, ScopelessError, UnexpectedBuildError } from './errors.js';

export const builtins = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

function createConfig(properties: GetRollupConfigProperties): RollupOptions {
  const { pkg, type } = properties;
  const externalModules = Object.keys({
    ...pkg.populatedJson.peerDependencies,
    ...pkg.populatedJson.dependencies,
    ...pkg.monots.externalModules,
  });

  if (type !== 'browser') {
    externalModules.push(...builtins);
  }

  const input: Record<string, string> = {};

  for (const entrypoint of pkg.entrypoints) {
    input[path.join(OUTPUT_FOLDER, entrypoint.baseName || 'index')] = entrypoint.source;
  }

  const warnings: FatalError[] = [];

  const config: RollupOptions = {
    input,
    external: makeExternalPredicate(externalModules),
    onwarn: (warning) => {
      if (typeof warning === 'string') {
        warnings.push(
          new FatalError(`An unhandled Rollup error occurred: ${chalk.red(warning)}`, pkg.name),
        );
        return;
      }

      switch (warning.code) {
        case 'CIRCULAR_DEPENDENCY':
        case 'EMPTY_BUNDLE':
        case 'EVAL':
        case 'UNUSED_EXTERNAL_IMPORT':
          break;

        case 'UNRESOLVED_IMPORT':
          if (warning.source?.startsWith('.')) {
            break;
          }

          warnings.push(
            new FatalError(
              `"${warning.source}" is imported by "${normalizePath(
                path.relative(pkg.directory, warning.importer ?? ''),
              )}" but the package is not specified in dependencies or peerDependencies`,
              pkg.name,
            ),
          );

          return;

        case 'THIS_IS_UNDEFINED':
          warnings.push(
            new FatalError(
              `"${normalizePath(
                path.relative(pkg.directory, warning.loc?.file ?? ''),
              )}" used \`this\` keyword at the top level of an ES module. You can read more about this at ${
                warning.url ?? ''
              } and fix this issue that has happened here:\n\n${warning.frame ?? ''}\n`,
              pkg.name,
            ),
          );

          return;

        default: {
          warnings.push(
            new FatalError(
              `An unhandled Rollup error occurred: ${chalk.red(warning.toString())}`,
              pkg.name,
            ),
          );
        }
      }
    },
    plugins: [
      {
        name: 'throw-warnings',
        buildEnd() {
          if (warnings.length > 0) {
            throw new BatchError(warnings);
          }
        },
      },
      type === 'browser' &&
        alias({
          // Allow files that are specific to the browser. Name your file
          // `file.default.ts` and create the alternative browser import
          // `file.browser.ts`. The browser entrypoint will use the `browser`
          // file while the default esm environment will use `file.default.ts`.
          entries: [{ find: /^(.*)\.default(\.[jt]sx?)$/, replacement: '$1.browser$2' }],
        }),
      type === 'main' &&
        alias({
          // Allow files that are specific to commonjs. Name your file
          // `file.default.ts` and create the alternative commonjs import
          // `file.cjs.ts`. The commonjs entrypoint will use the `cjs` file
          // while the default esm environment will use `file.default.ts`.
          entries: [{ find: /^(.*)\.default(\.[jt]sx?)$/, replacement: '$1.node$2' }],
        }),
      swc({
        cwd: pkg.project.directory,
        env: { targets: pkg.browserslist },
        jsc: {
          externalHelpers: !!pkg.populatedJson.dependencies?.['@swc/helpers'],
          transform: { react: { runtime: 'automatic' } },
        },
      }),
      json({ namedExports: false }),
      resolve({ extensions: ['.js', '.jsx', '.ts', '.tsx', '.cjs', '.mjs'] }),
      type === 'browser' &&
        replace({
          values: {
            ['typeof ' + 'document']: JSON.stringify('object'),
            ['typeof ' + 'window']: JSON.stringify('object'),
          },
          preventAssignment: true,
        }),
    ].filter((x): x is Plugin => !!x),
  };

  return config;
}

// this makes sure nested imports of external packages are external
function makeExternalPredicate(externals: string[]) {
  if (externals.length === 0) {
    return () => false;
  }

  const pattern = new RegExp(`^(${externals.join('|')})($|/)`);
  return (id: string) => pattern.test(id);
}

function swc(options: Options = {}): Plugin {
  return {
    name: 'swc',
    transform(code, filename) {
      options.filename = filename;
      return transform(code, options);
    },
  };
}

interface GetRollupConfigProperties {
  pkg: PackageEntity;
  type: Exclude<EntrypointField, 'types'>;
}

interface Config {
  config: RollupOptions;
  outputs: OutputOptions[];
}

export function createConfigs(pkg: PackageEntity): Config[] {
  const configs: Config[] = [];

  const hasBrowserField = pkg.fields.includes('browser');
  const hasModuleField = pkg.fields.includes('module');
  const hasMainField = pkg.fields.includes('main');

  if (hasMainField || hasModuleField) {
    const config: Config = {
      config: createConfig({ pkg, type: 'module' }),
      outputs: [],
    };

    const mainOutput: OutputOptions = {
      format: 'cjs',
      entryFileNames: `[name]${FIELD_EXTENSIONS['main']}`,
      chunkFileNames: `${OUTPUT_FOLDER}/[name]-[hash]${FIELD_EXTENSIONS['main']}`,
      dir: pkg.directory,
      exports: 'named',
      interop: 'auto',
    };

    const moduleOutput: OutputOptions = {
      format: 'es',
      entryFileNames: `[name]${FIELD_EXTENSIONS['module']}`,
      chunkFileNames: `${OUTPUT_FOLDER}/[name]-[hash]${FIELD_EXTENSIONS['module']}`,
      dir: pkg.directory,
    };

    if (hasMainField) {
      config.outputs.push(mainOutput);
    }

    if (hasModuleField) {
      config.outputs.push(moduleOutput);
    }

    configs.push(config);
  }

  if (hasBrowserField) {
    const browserOutput: OutputOptions = {
      format: 'es',
      entryFileNames: `[name]${FIELD_EXTENSIONS['browser']}`,
      chunkFileNames: `${OUTPUT_FOLDER}/[name]-[hash]${FIELD_EXTENSIONS['browser']}`,
      dir: pkg.directory,
    };

    configs.push({
      config: createConfig({ pkg, type: 'browser' }),
      outputs: [browserOutput],
    });
  }

  return configs;
}

// https://github.com/rollup/rollup/blob/28ffcf4c4a2ab4323091f63944b2a609b7bcd701/src/utils/sourceMappingURL.ts
// this looks ridiculous, but it prevents sourcemap tooling from mistaking
// this for an actual sourceMappingURL
let SOURCEMAPPING_URL = 'sourceMa';
SOURCEMAPPING_URL += 'ppingURL';

// https://github.com/rollup/rollup/blob/28ffcf4c4a2ab4323091f63944b2a609b7bcd701/src/rollup/rollup.ts#L333-L356
async function writeOutputFile(
  outputFile: OutputAsset | OutputChunk,
  outputOptions: OutputOptions,
): Promise<void> {
  const fileName = path.resolve(
    outputOptions.dir || path.dirname(outputOptions.file ?? ''),
    outputFile.fileName,
  );
  let writeSourceMapPromise: Promise<void> | undefined;
  let source: string | Uint8Array;

  if (outputFile.type === 'asset') {
    source = outputFile.source;
  } else {
    source = outputFile.code;

    if (outputOptions.sourcemap && outputFile.map) {
      let url: string;

      if (outputOptions.sourcemap === 'inline') {
        url = outputFile.map.toUrl();
      } else {
        url = `${path.basename(outputFile.fileName)}.map`;
        writeSourceMapPromise = fs.writeFile(`${fileName}.map`, outputFile.map.toString());
      }

      if (outputOptions.sourcemap !== 'hidden') {
        source += `//# ${SOURCEMAPPING_URL}=${url}\n`;
      }
    }
  }

  await Promise.all([fs.writeFile(fileName, source), writeSourceMapPromise]);
}

async function buildPackage(pkg: PackageEntity) {
  const configs = createConfigs(pkg);
  const promises: Array<Promise<void>> = [];

  for (const { config, outputs } of configs) {
    const promise = rollup(config)
      .then((bundle) => {
        return Promise.all(
          outputs.map(async (config) => {
            const { output } = await bundle.generate(config);
            return { output, config };
          }),
        );
      })
      .then(async (chunks) => {
        await Promise.all(
          chunks.map(async (bundle) => {
            await Promise.all(
              bundle.output.map(async (output) => {
                await writeOutputFile(output, bundle.config);
              }),
            );
          }),
        );
      });

    promises.push(promise);
  }

  await Promise.all(promises);
}

/**
 * Build a package using rollup.
 */
export async function buildPackageWithRollup(pkg: PackageEntity): Promise<void> {
  try {
    await buildPackage(pkg);
  } catch (error) {
    if (error instanceof Promise) {
      await error;
      await buildPackageWithRollup(pkg);
      return;
    }

    if (
      error instanceof FatalError ||
      error instanceof BatchError ||
      error instanceof ScopelessError
    ) {
      throw error;
    }

    throw new UnexpectedBuildError(error as Error, pkg.name);
  }
}
