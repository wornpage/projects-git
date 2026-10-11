import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

test('Miniflare resolves its patched native image renderer and preserves SVG pixels',async()=>{
  const require=createRequire(import.meta.url);
  const consumer=createRequire(require.resolve('miniflare'));
  const sharp=consumer('sharp');
  const [major,minor,patch]=(sharp.versions.rsvg??'').split('.').map(Number);
  assert.ok(major>2||major===2&&(minor>63||minor===63&&patch>=2),'Load patched librsvg 2.63.2 or later from the consumer dependency.');
  const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#ff0000"/></svg>');
  const png=await sharp(svg).png().toBuffer({resolveWithObject:true});
  assert.equal(png.info.format,'png');assert.equal(png.info.width,4);assert.equal(png.info.height,4);
  const pixels=await sharp(png.data).ensureAlpha().raw().toBuffer();
  assert.deepEqual([...pixels.subarray(40,44)],[255,0,0,255]);
  console.log(JSON.stringify({nativeImageRenderer:{sharp:sharp.versions.sharp,librsvg:sharp.versions.rsvg,libvips:sharp.versions.vips}}));
});
