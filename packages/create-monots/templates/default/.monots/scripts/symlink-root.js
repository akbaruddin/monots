/**
 * @script
 *
 * This is left as a JavaScript file since it is called in the `preinstall` hook
 * before any packages have been installed. It only has access to the `node`
 * internals.
 */

import { lstatSync, readdirSync, readlinkSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve a path relative to the base directory.
 *
 * @param {string[]} paths
 */
function baseDir(...paths) {
  return resolve(__dirname, '../..', ...paths);
}

const targets = readdirSync(baseDir('.monots', 'symlink'))
  // Exclude the `readme.md` file from being symlinked.
  .filter((filename) => !filename.endsWith('readme.md'))
  .map((filename) => ({
    original: baseDir('.monots', 'symlink', filename),
    target: baseDir(filename),
  }));

/**
 * Safely get the stats for a file.
 *
 * @param {string} target
 */
function getFileStatSync(target) {
  try {
    return lstatSync(target);
  } catch {
    return;
  }
}

/**
 * Delete a file or folder recursively.
 *
 * @param {string} path
 *
 * @returns {void}
 */
function deletePath(path) {
  const stat = getFileStatSync(path);

  if (!stat) {
    return;
  }

  if (stat.isFile()) {
    console.log('deleting file', path);
    unlinkSync(path);
  }

  if (!stat.isDirectory()) {
    return;
  }

  // Delete all nested paths
  for (const file of readdirSync(path)) {
    deletePath(join(path, file));
  }

  // Delete the directory
  rmdirSync(path);
}

/**
 * Check that the path is linked to the target.
 *
 * @param {string} path
 * @param {string} target
 */
function isLinkedTo(path, target) {
  try {
    const checkTarget = readlinkSync(path);
    return checkTarget === target;
  } catch {
    return false;
  }
}

for (const { original, target } of targets) {
  const targetStat = getFileStatSync(target);

  // Nothing to do since the path is linked correctly.
  if (isLinkedTo(target, original)) {
    continue;
  }

  // The file or directory exists but is not symlinked correctly. It should be
  // deleted.
  if (targetStat) {
    console.log('deleting path', target);
    deletePath(target);
  }

  symlinkSync(original, target);
}

console.log(
  '\n\u001B[32mSuccessfully symlinked the `support/root` files to the root directory.\u001B[0m\n',
);
