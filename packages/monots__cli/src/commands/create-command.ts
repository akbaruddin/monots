import { FatalError, folderExists, ProjectEntity } from '@monots/core';
import type { CommandBoolean, CommandString, Usage } from '@monots/types';
import chalk from 'chalk';
import { Option } from 'clipanion';
import { template } from 'lodash-es';
import path from 'node:path';
import { Transform } from 'node:stream';
import ora from 'ora';
import copy from 'recursive-copy';

import { getPackagePath, mangleScopedPackageName } from '../helpers.js';
import { BaseCommand } from './base-command.js';

/**
 * Create a package for the project.
 *
 * @category CliCommand
 */
export class CreateCommand extends BaseCommand {
  static override paths = [['create']];
  static override usage: Usage = {
    description: 'Create a package for the current project in the packages folder.',
    category: 'Create',
    details: `
      Create a TypeScript package within the current project.
    `,
    examples: [
      [
        'Create a package using the default simple template',
        '$0 create --description="Awesome package" @monots/new-package',
      ],
    ],
  };
  packageName: CommandString = Option.String({ required: true });

  project?: CommandBoolean = Option.Boolean('--project,-P', {
    description: 'When true will create a new project instead.',
  });

  keywords?: CommandString = Option.String('--keywords,-K', {
    description: 'Comma separated package keywords',
  });

  interactive?: CommandBoolean = Option.Boolean('--interactive,-i', {
    description: 'Set to true to interactively add required data for the package',
  });

  template?: CommandString = Option.String('--template,-T', {
    description: 'The template to use. This can be a file path or a url for a GitHub project',
  });

  description?: CommandString = Option.String('--description,-D', {
    description: 'Set the description of the package being created',
  });

  override async execute() {
    super.execute();

    if (this.project) {
      throw new FatalError('Creating projects is not currently supported.', this.cwd);
    }

    const spinner = ora(chalk`loading project package`).start();

    try {
      const project = await ProjectEntity.create({ cwd: this.cwd });
      const output = path.join(project.packagesFolder, mangleScopedPackageName(this.packageName));

      if (await folderExists(output)) {
        throw new FatalError(
          chalk`A package already exists for: {bold ${this.packageName}}`,
          this.cwd,
        );
      }

      const input = this.template
        ? path.resolve(this.template)
        : getPackagePath('templates/package/simple');
      const variables = { description: this.description, name: this.packageName };

      spinner.text = 'generating the template files';
      await copyTemplate({ input, output, variables });

      // spinner.text = 'installing dependencies';
      // await project.install();

      // // Reload packages
      spinner.text = 'reloading project and fixing files';
      await project.loadPackages();
      await project.savePackagesJson();
      await project.saveTsConfigFiles();

      spinner.succeed(chalk`{bold amazing!} your package was created!`);
      return 0;
    } catch (error: any) {
      spinner.fail(`oops, something went wrong: ${error.message}`);
      return 1;
    }
  }
}

interface TemplateVariables {
  description?: string;
  name: string;
}

interface CopyTemplateProps {
  input: string;
  output: string;
  variables: TemplateVariables;
}

async function copyTemplate(props: CopyTemplateProps) {
  const { input, output, variables } = props;

  await copy(input, output, {
    rename: (filename) => template(filename)(variables).replace(/.template$/, ''),
    transform: (filename) => {
      if (path.extname(filename) !== '.template') {
        // eslint-disable-next-line unicorn/no-null
        return null as any;
      }

      return new Transform({
        transform: (chunk, _encoding, done) => {
          const output = template(chunk.toString())(variables);
          done(undefined, output);
          // render(chunk.toString(), variables, {}, (error, ouput) => {
          // });
        },
      });
    },
  });
}