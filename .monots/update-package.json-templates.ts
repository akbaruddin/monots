import { loadJsonFile } from 'load-json-file';
import { writeJsonFile } from 'write-json-file';
import { got } from 'got';
import glob from 'fast-glob';

const DATA_ROOT_URL = 'https://data.jsdelivr.com/v1/package/npm/';

function getLatestVersion(name: string) {
  return got(`${DATA_ROOT_URL}${name}`)
    .json<any>()
    .then((response) => {
      console.log({ response });
      return response.tags.latest;
    });
}

async function run() {
  // find and load package.json.template files
  const files = await glob('**/package.json.template', {
    cwd: process.cwd(),
    absolute: true,
  });

  const promises = files.map(async (file) => {
    // read the json file
    const json = await loadJsonFile<any>(file);
    const dependencies = json.dependencies || {};
    const internalPromises: Promise<void>[] = [];

    // read the dependencies
    for (const name of Object.keys(dependencies)) {
      internalPromises.push(
        // update the dependencies to the latest versions
        getLatestVersion(name).then((version) => {
          dependencies[name] = `^${version}`;
        }),
      );
    }

    // wait for all versions to be updated
    await Promise.all(internalPromises);

    // write the updated json file
    await writeJsonFile(file, json, { indent: 2 });
  });

  await Promise.all(promises);
}

run();
