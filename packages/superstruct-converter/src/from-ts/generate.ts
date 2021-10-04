import { camelCase } from 'case-anything';
import ts from 'typescript';

import { generateStructSchemaVariableStatement as generateStructSchemaVariableStatement } from './generate-struct-schema.js';
import { resolveModules } from './resolve-modules.js';
import { transformRecursiveSchema } from './transform-recursive-schema.js';

export interface GenerateFromTsProps {
  /**
   * Content of the typescript source file.
   */
  sourceText: string;

  /**
   * Max iteration number to resolve the declaration order.
   */
  maxRun?: number;

  /**
   * Filter function on type/interface name.
   */
  nameFilter?: (name: string) => boolean;

  /**
   * Schema name generator.
   */
  getSchemaName?: (identifier: string) => string;

  /**
   * Whether to preserve doc comments.
   *
   * @default true
   */
  keepComments?: boolean;
}

/**
 * Generate struct schemas and integration tests from a typescript file.
 *
 * This function take care of the sorting of the `const` declarations and solved potential circular references
 */
export function generateFromTs(props: GenerateFromTsProps) {
  const {
    sourceText,
    maxRun = 10,
    nameFilter = () => true,
    getSchemaName = (id) => `${camelCase(id)}Schema`,
    keepComments = true,
  } = props;

  // Create a source file and deal with modules
  const sourceFile = resolveModules(sourceText);

  // Extract the nodes (interface declarations & type aliases)
  const nodes: Array<ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration> = [];

  const visitor = (node: ts.Node) => {
    if (
      (ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      nameFilter(node.name.text)
    ) {
      nodes.push(node);
    }
  };
  ts.forEachChild(sourceFile, visitor);

  // Generate zod schemas
  const structSchemas = nodes.map((node) => {
    const typeName = node.name.text;
    const varName = getSchemaName(typeName);
    const structSchema = generateStructSchemaVariableStatement({
      structImportValue: 's',
      node,
      sourceFile,
      varName,
      getDependencyName: getSchemaName,
    });

    return { typeName, varName, ...structSchema };
  });

  // Resolves statements order
  // A schema can't be declared if all the referenced schemas used inside this one are not previously declared.
  const statements = new Map<string, { typeName: string; value: ts.VariableStatement }>();
  const typeImports: Set<string> = new Set();

  let n = 0;

  while (statements.size !== structSchemas.length && n < maxRun) {
    for (const {
      varName,
      dependencies,
      statement,
      typeName,
      requiresImport,
    } of structSchemas.filter(({ varName }) => !statements.has(varName))) {
      const isCircular = dependencies.includes(varName);
      const missingDependencies = dependencies
        .filter((dep) => dep !== varName)
        .filter((dep) => !statements.has(dep));

      if (missingDependencies.length === 0) {
        if (isCircular) {
          typeImports.add(typeName);
          statements.set(varName, {
            value: transformRecursiveSchema('s', statement, typeName),
            typeName,
          });
        } else {
          if (requiresImport) {
            typeImports.add(typeName);
          }

          statements.set(varName, { value: statement, typeName });
        }
      }
    }

    n++; // Just a safety net to avoid infinity loops
  }

  // Warn the user of possible not resolvable loops
  const missingStatements = structSchemas.filter(({ varName }) => !statements.has(varName));

  const errors: string[] = [];

  if (missingStatements.length > 0) {
    errors.push(
      `Some schemas can't be generated due to circular dependencies:
${missingStatements.map(({ varName }) => `${varName}`).join('\n')}`,
    );
  }

  // Create output files (zod schemas & integration tests)
  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: !keepComments,
  });

  const printerWithComments = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
  });

  const print = (node: ts.Node) => printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);

  const transformedSourceText = printerWithComments.printFile(sourceFile);

  const imports = [...typeImports.values()];
  const getContent = (typesImportPath: string) => `// Generated by superstruct-converter
import * as s from "superstruct-extra";
${imports.length > 0 ? `\nimport { ${imports.join(', ')} } from "${typesImportPath}";\n` : ''}
${[...statements.values()].map((statement) => print(statement.value)).join('\n\n')}
`;

  return {
    /**
     * Source text with pre-process applied.
     */
    transformedSourceText,

    /**
     * Create the content of the superstruct schemas file.
     *
     * @param typesImportPath Relative path of the source file
     */
    getContent,

    /**
     * List of generation errors.
     */
    errors,

    /**
     * `true` if zodSchemaFile have some resolvable circular dependencies
     */
    hasCircularDependencies: imports.length > 0,
  };
}