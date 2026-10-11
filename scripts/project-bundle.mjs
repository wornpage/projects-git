import {readFile} from 'node:fs/promises';
import {writeProjectBundle, restoreProjectBundle} from '../src/local/project-bundle.mjs';
const [action, ...args] = process.argv.slice(2);
let receipt;
if (action === 'export' && args.length === 4) {
  const [file, expectedArchiveSha256, sourcesFile, directory] = args;
  receipt = await writeProjectBundle({archive: JSON.parse(await readFile(file, 'utf8')), expectedArchiveSha256,
    sources: JSON.parse(await readFile(sourcesFile, 'utf8')), directory});
} else if (action === 'restore' && args.length === 3) {
  const [directory, expectedManifestSha256, destination] = args;
  receipt = await restoreProjectBundle({directory, expectedManifestSha256, destination});
} else throw Error('Usage: project-bundle.mjs export <project.json> <expected-archive-sha256> <local-sources.json> <new-directory> OR restore <bundle-directory> <expected-manifest-sha256> <new-bare-repository>');
console.log(JSON.stringify(receipt, null, 2));
