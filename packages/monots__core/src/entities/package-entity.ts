import { deepMerge, removeUndefined } from '@monots/utils';
import is from '@sindresorhus/is';
import chalkTemplate from 'chalk-template';
import del from 'del';
import glob from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import normalizePath from 'normalize-path';
import parseJson from 'parse-json';
import sortKeys from 'sort-keys';
import { entries } from 'ts-entries';
import { objectKeys } from 'ts-extras';
import type { JsonObject } from 'type-fest';
import { writeJsonFile } from 'write-json-file';

import { OUTPUT_FOLDER, SOURCE_FOLDER_NAME } from '../constants.js';
import { createAutoGeneratedFlag, FatalError, prefixRelativePath } from '../helpers/index.js';
import type { Entrypoint, EntrypointField, ExportsField, PackageMonots } from '../schema.js';
import { entrypointFields, Package } from '../schema.js';
import type { References } from '../types.js';
import type { BaseEntityProps, SaveJsonProps } from './base-entity.js';
import { BaseEntity } from './base-entity.js';
import { EntrypointEntity } from './entrypoint-entity.js';
import type { ProjectEntity } from './project-entity.js';

interface PackageEntityProps extends BaseEntityProps<Package> {
  project: ProjectEntity;
}

interface CreatePackageEntityProps {
  /**
   * The absolute path to the directory.
   */
  directory: string;

  /**
   * The parent project.
   */
  project: ProjectEntity;
}

export class PackageEntity extends BaseEntity<Package> {
  static async create(props: CreatePackageEntityProps): Promise<PackageEntity> {
    const { directory, project } = props;
    const jsonPath = path.join(directory, 'package.json');
    const json = parseJson(await fs.readFile(jsonPath, 'utf8'));
    const map = project.sharedMap;
    const packageEntity = new PackageEntity({ path: jsonPath, map, json, project });
    await packageEntity.createEntrypoints();

    return packageEntity;
  }

  project: ProjectEntity;

  /**
   * The entrypoints for this `package`.
   */
  entrypoints: EntrypointEntity[] = [];

  /**
   * Cached value of fields since it is accessed multiple times by entrypoints.
   */
  #fields: EntrypointField[] | undefined;
  #exportFields: ExportsField[] | undefined;

  /**
   * The supported fields for this package and it's nested entrypoints. It uses
   * a cached private variable for fields.
   */
  get fields(): EntrypointField[] {
    return (this.#fields ??= entrypointFields.filter(
      (field) => !is.nullOrUndefined(this.json[field]),
    ));
  }

  /**
   * The default browserslist to use for the project.
   */
  get browserslist(): string | string[] {
    return this.json.browserslist ?? this.project.browserslist;
  }

  get exportFields(): ExportsField[] {
    return (this.#exportFields ??= [...this.fields.map((field) => fieldNameToExportName[field])]);
  }

  /**
   * True when this is a library.
   */
  get isLibrary(): boolean {
    return this.monots.mode === 'library';
  }

  /**
   * True when this is a command line interface package (CLI).
   */
  get isCli(): boolean {
    return this.monots.mode === 'cli';
  }

  /**
   * The dist directory which is used for all entrypoint files.
   */
  get output(): string {
    return path.join(this.directory, OUTPUT_FOLDER);
  }

  get name(): string {
    return this.populatedJson.name;
  }

  /**
   * True when this package should export types.
   */
  get publicTypes(): boolean {
    return this.isLibrary && this.fields.includes('types');
  }

  #monots?: Required<PackageMonots>;
  get monots(): Required<PackageMonots> {
    if (this.#monots) {
      return this.#monots;
    }

    const monots = {
      ...DEFAULT_MONOTS_PACKAGE_OPTIONS,
      ...removeUndefined(this.populatedJson.monots ?? {}),
    };

    if (monots.tsconfigs === false) {
      this.#monots = monots;
      return monots;
    }

    const compilerOptions = { types: [], noEmit: true };

    if (is.emptyObject(monots.tsconfigs)) {
      monots.tsconfigs = {
        [monots.sourceFolderName]: { compilerOptions },
      };

      this.#monots = monots;
      return monots;
    }

    if (monots.tsconfigs[monots.sourceFolderName] !== false) {
      const sourceConfig = deepMerge(
        { compilerOptions },
        monots.tsconfigs[monots.sourceFolderName] ?? {},
      );
      monots.tsconfigs[monots.sourceFolderName] = sourceConfig;
    }

    this.#monots = monots;
    return monots;
  }

  get externalModules(): string[] {
    const json = this.json;
    const monots = this.monots;
    const deps = {
      ...json.dependencies,
      ...json.devDependencies,
      ...json.peerDependencies,
      ...json.optionalDependencies,
    };

    return [...new Set([...objectKeys(deps), ...monots.externalModules])];
  }

  private constructor(props: PackageEntityProps) {
    const { project, ...rest } = props;
    super({ ...rest, struct: Package });
    this.project = project;
  }

  async createEntrypoints(): Promise<void> {
    // Only create entrypoint for library packages.
    if (!(this.isLibrary || this.isCli)) {
      return;
    }

    const cwd = path.join(this.directory, this.monots.sourceFolderName);
    const sourceFiles = await glob(this.monots.entrypoints, {
      cwd,
      onlyFiles: true,
      absolute: true,
    });

    const inputs = await Promise.all(
      sourceFiles.map((file) => this.#mapEntrypointSourceFile(file)),
    );
    this.entrypoints = this.#createEntrypointEntities(inputs);
    this.#throwIfDuplicateEntrypoints();
  }

  /**
   * Prepare the package for usages in development.
   */
  async prepare(): Promise<void> {
    if (!(this.isLibrary || this.isCli)) {
      return;
    }

    await this.#ensureDist();
    const promises: Array<Promise<void>> = [];

    for (const entrypoint of this.entrypoints) {
      promises.push(entrypoint.generateDevFiles());
    }

    await Promise.all(promises);
  }

  createJson(): Package {
    if (!this.isLibrary) {
      return this.json;
    }

    const json: Package = { ...this.json };

    if (!json.type) {
      // Default to declaring the library as a module.
      json.type = 'module';
    }

    if (!this.monots.ignoreExports) {
      json.exports = this.#generateExportsField();
    }

    json.files = this.#getRequiredFiles();
    return json;
  }

  /**
   * Create the tsconfig files configured for this package and return the
   * references for the root package.
   */
  async createTsconfigs(): Promise<string[]> {
    const tsconfigs = this.monots.tsconfigs || {};
    const folders = await fs.readdir(this.directory);
    const rootReferences: string[] = [];
    const promises: Array<Promise<void>> = [];
    const sourceFolderName = this.monots.sourceFolderName;
    const isSourceFolder = (name: string) => [sourceFolderName].includes(name);
    const extendedTsconfig = this.project.monots.baseTsconfig;
    const isRelativeExtendsPath =
      extendedTsconfig.startsWith('./') || extendedTsconfig.startsWith('../');

    for (const [folder, content] of entries(tsconfigs)) {
      if (!content || !(folder === '' || folders.includes(folder) || isSourceFolder(folder))) {
        continue;
      }

      const { compilerOptions, ...rest } = content;
      const absolutePath = path.join(this.directory, folder, 'tsconfig.json');
      const relativeExtendedTsconfig = isRelativeExtendsPath
        ? path.relative(
            path.dirname(absolutePath),
            path.join(this.project.directory, extendedTsconfig),
          )
        : extendedTsconfig;

      const referencePath = path.dirname(path.relative(this.project.directory, absolutePath));
      const initialTsconfig = {
        ...createAutoGeneratedFlag(folder),
        extends: relativeExtendedTsconfig,
      };

      rootReferences.push(referencePath);

      if (!isSourceFolder(folder)) {
        const json = {
          ...initialTsconfig,
          ...(content as JsonObject),
          compilerOptions: {
            noEmit: true,
            declaration: false,
            ...compilerOptions,
          },
        };
        promises.push(writeJsonFile(absolutePath, json, { detectIndent: true }));

        continue;
      }

      // Set the module type to CommonJS for `commonjs` repos
      const baseCompilerOptions =
        this.populatedJson.type === 'commonjs' ? { module: 'CommonJS' } : {};
      const compilerOptionsOverride = this.publicTypes
        ? {
            ...baseCompilerOptions,
            declaration: true,
            noEmit: false,
            composite: true,
            emitDeclarationOnly: true,
            outDir: path.join(path.relative(sourceFolderName, ''), OUTPUT_FOLDER),
          }
        : { ...baseCompilerOptions };
      const dependencies = {
        ...this.populatedJson.dependencies,
        ...this.populatedJson.devDependencies,
        ...this.populatedJson.peerDependencies,
      };
      const referencePaths = new Set<string>();

      for (const dependency of objectKeys(dependencies)) {
        const pkg = this.project.packageMap.get(dependency);

        if (!pkg || !pkg.isLibrary) {
          continue;
        }

        referencePaths.add(
          path.relative(
            path.dirname(absolutePath),
            path.join(pkg.directory, pkg.monots.sourceFolderName),
          ),
        );
      }

      const references: References[] = [...referencePaths].map((path) => ({ path }));

      const json = {
        ...initialTsconfig,
        compilerOptions: {
          ...compilerOptions,
          ...compilerOptionsOverride,
        },
        ...(rest as JsonObject),
        references: references.sort((a, z) => a.path.localeCompare(z.path)),
      };

      promises.push(writeJsonFile(absolutePath, json, { detectIndent: true }));
    }

    await Promise.all(promises);
    return rootReferences;
  }

  async validate(): Promise<FatalError[]> {
    const errors: FatalError[] = [];
    const props: SaveJsonProps = { errors, fix: false };

    await this.saveJson(props);

    return errors;
  }

  /**
   * This automatically saves the JSON for the nested entrypoints as well.
   */
  override async saveJson(props: SaveJsonProps = {}): Promise<boolean> {
    const promises: Array<Promise<boolean>> = [];

    for (const entrypoint of this.entrypoints) {
      promises.push(entrypoint.saveJson(props));
    }

    const values = await Promise.all(promises);
    const changed = await super.saveJson(props);

    return changed || values.some((value) => value);
  }

  /**
   * Ensure that the dist file is created.
   */
  async #ensureDist() {
    await del(this.output);
    await fs.mkdir(this.output, { recursive: true });
  }

  /**
   * Make sure the name provided for the source file is valid.
   */
  #validateSourceFilePath(sourceFile: string) {
    if (!/\.tsx?$/.test(sourceFile)) {
      throw new FatalError(
        chalkTemplate`Entrypoint source files must end in .ts or .tsx but ${path.relative(
          this.directory,
          sourceFile,
        )} does not`,
        this.name,
      );
    }

    if (
      !normalizePath(sourceFile).includes(
        normalizePath(path.join(this.directory, this.monots.sourceFolderName)),
      )
    ) {
      throw new FatalError(
        chalkTemplate`Entrypoint source files must be inside of the source directory of a package but ${path.relative(
          this.directory,
          sourceFile,
        )} is not`,
        this.name,
      );
    }
  }

  /**
   * Throw an error if there are duplicate entrypoints.
   */
  #throwIfDuplicateEntrypoints() {
    const entrypointsWithSourcePath = new Map<string, string>();

    for (const entrypoint of this.entrypoints) {
      if (entrypointsWithSourcePath.has(entrypoint.name)) {
        const message = `This package has multiple source files for the same entrypoint of ${
          entrypoint.name
        } at ${path.relative(
          this.directory,
          entrypointsWithSourcePath.get(entrypoint.name) ?? '',
        )} and ${path.relative(this.directory, entrypoint.source)}: {bold ${this.name}}`;

        throw new Error(message);
      }

      entrypointsWithSourcePath.set(entrypoint.name, entrypoint.source);
    }
  }

  #mapEntrypointSourceFile = async (sourceFile: string): Promise<EntrypointInput> => {
    this.#validateSourceFilePath(sourceFile);

    // TODO it's possible for root files to be wrongly identified at the moment.
    let directory = path.join(
      this.directory,
      sourceFile
        .replace(path.join(this.directory, this.monots.sourceFolderName), '')
        .replace(/\.[jt]sx?$/, ''),
    );

    if (path.basename(directory) === 'index') {
      directory = path.dirname(directory);
    }

    const jsonFile = path.join(directory, 'package.json');

    let jsonContents: string | undefined;
    const sourceContents = await fs.readFile(sourceFile, 'utf8');

    try {
      jsonContents = await fs.readFile(jsonFile, 'utf8');
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    return { jsonFile, jsonContents, sourceFile, sourceContents };
  };

  #createEntrypointEntities = (items: EntrypointInput[]): EntrypointEntity[] => {
    const entrypoints: EntrypointEntity[] = [];

    for (const item of items) {
      const { jsonContents, jsonFile, sourceFile: source, sourceContents } = item;
      const json: Entrypoint = jsonContents ? parseJson(jsonContents) : {};

      entrypoints.push(
        new EntrypointEntity({
          source,
          json,
          map: this.sharedMap,
          package: this,
          path: jsonFile,
          contents: sourceContents,
        }),
      );
    }

    return entrypoints;
  };

  /**
   * Create the JSON for the exports field.
   */
  #generateExportsField() {
    let extraExports = this.monots.extraExports;
    const exportsObject: Record<string, string | Record<string, any>> = {
      './package.json': './package.json',
    };

    if (this.fields.includes('types')) {
      exportsObject['./types/*'] = `./${OUTPUT_FOLDER}/*.d.ts`;
    }

    if (this.isLibrary) {
      // Only add entrypoints for libraries.
      for (const entrypoint of this.entrypoints) {
        const name = entrypoint.isRoot
          ? '.'
          : prefixRelativePath(path.relative(this.name, entrypoint.name));
        const nameWithExtension = entrypoint.isRoot ? './index.js' : `${name}.js`;
        const value = { ...entrypoint.fields.exports };
        exportsObject[name] = value;
        exportsObject[nameWithExtension] = value;
      }
    } else {
      // Preserve the extra exports for non-libraries.
      extraExports = { ...this.json.exports, ...extraExports };
    }

    return sortKeys({ ...exportsObject, ...extraExports }, { deep: true });
  }

  #getRequiredFiles() {
    const files = new Set(this.populatedJson.files ?? []);

    if (!files.has(OUTPUT_FOLDER)) {
      files.add(OUTPUT_FOLDER);
    }

    for (const entrypoint of this.entrypoints) {
      if (entrypoint.isRoot) {
        continue;
      }

      const name = entrypoint.baseName;

      if (!files.has(name)) {
        files.add(name);
      }
    }

    return [...files].sort();
  }
}

const fieldNameToExportName: Record<EntrypointField, ExportsField> = {
  module: 'import',
  main: 'require',
  browser: 'browser',
  types: 'types',
};

interface EntrypointInput {
  /**
   * The full path to the package.json for the entrypoint.
   */
  jsonFile: string;

  /**
   * The string contents of the package.json for the entrypoint.
   */
  jsonContents: string | undefined;

  /**
   * The source file used.
   */
  sourceFile: string;

  /**
   * The contents of the source file.
   */
  sourceContents: string;
}

const DEFAULT_MONOTS_PACKAGE_OPTIONS: Required<PackageMonots> = {
  entrypoints: ['index.{ts,tsx}'],
  tsconfigs: {},
  mode: 'library',
  externalModules: [],
  sourceFolderName: SOURCE_FOLDER_NAME,
  extraExports: {},
  ignoreExports: false,
  addExportsToEntrypoints: false,
};
