import {build} from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,relative} from 'node:path';

const root = fileURLToPath(new URL('../',import.meta.url));
export async function entranceAssets() {
  const built = await build({absWorkingDir:root,entryPoints:['public/app.js'],bundle:true,write:false,
    metafile:true,format:'esm',platform:'browser',logLevel:'silent'});
  const names = Object.keys(built.metafile.inputs).map(path=>relative(resolve(root,'public'),resolve(root,path)).replaceAll('\\','/'));
  if (names.some(path=>path.startsWith('../') || !path.endsWith('.js'))) throw Error('Demo module graph escaped public JavaScript.');
  return [...new Set([...names,'styles.css','action-feedback.css','demo/demo.css','vendor/wornpage-button-0.2.3/worn-button.css'])].sort();
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = resolve(root,'src/entrance/assets.mjs');
  const text = '// Closed dependency graph of the read-only workbench. Regenerate explicitly with scripts/entrance-assets.mjs --write.\n'
    + 'export const DEMO_ASSETS = Object.freeze(' + JSON.stringify(await entranceAssets(),null,2) + ');\n';
  if (process.argv.includes('--write')) await writeFile(path,text);
  else if (await readFile(path,'utf8') !== text) throw Error('Public demo asset graph changed. Review it and regenerate the allowlist.');
  console.log(process.argv.includes('--write') ? 'Reviewed demo asset allowlist written.' : 'Demo asset allowlist matches its closed import graph.');
}
