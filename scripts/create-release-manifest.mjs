import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';

const [tag, commit, imageFile] = process.argv.slice(2);
if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag ?? '') ||
    !/^[a-f0-9]{40}$/.test(commit ?? '') || imageFile !== 'magisform-image.tar.gz') {
  throw new Error('Tag, commit ou arquivo de imagem inválido.');
}
const hash = createHash('sha256');
for await (const chunk of createReadStream(imageFile)) hash.update(chunk);
const manifest = {
  format: 1,
  tag,
  commit,
  image: `magisform:release-${tag}`,
  file: imageFile,
  sha256: hash.digest('hex'),
};
await writeFile('magisform-release.json', JSON.stringify(manifest, null, 2) + '\n');
