// Converte capturas do renderer e a identidade em imagens prontas para o website.
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
(async () => {
  const images = path.join(root, 'assets/images');
  const brand = path.join(root, 'assets/brand');
  const dimensions = new Map();
  const responsiveCaptures = ['formulas', 'payment', 'budget',
    'dashboard-detail', 'formulas-detail', 'withdrawal-detail', 'customers-detail', 'history-detail'];
  for (const name of responsiveCaptures) {
    for (const width of [960, 1600]) {
      const source = path.join(images, `sources/${name}.png`);
      const info = await sharp(source).resize(width).webp({quality: 88}).toFile(path.join(images, `${name}-${width}.webp`));
      dimensions.set(`assets/images/${name}-${width}.webp`, info);
      await sharp(source).resize(width).avif({quality: 65, effort: 4}).toFile(path.join(images, `${name}-${width}.avif`));
    }
  }
  for (const name of ['dashboard', 'recipe', 'withdrawal', 'customers', 'history']) {
    const source = path.join(images, `sources/${name}.png`);
    await sharp(source).resize(1600).webp({quality: 88}).toFile(path.join(images, `${name}-1600.webp`));
  }
  // Reserva no HTML a proporção exata de cada captura, inclusive os recortes.
  const htmlPath = path.join(root, 'index.html');
  const html = await fs.readFile(htmlPath, 'utf8');
  await fs.writeFile(htmlPath, html.replace(/<img\b[^>]*>/g, tag => {
    const info = dimensions.get(tag.match(/\bsrc="([^"]+)"/)?.[1]);
    return info ? tag.replace(/\bwidth="\d+"/, `width="${info.width}"`).replace(/\bheight="\d+"/, `height="${info.height}"`) : tag;
  }));
  console.log('Capturas responsivas renderizadas.');
  if (process.argv.includes('--previews-only')) return;
  const symbol = await fs.readFile(path.join(brand, 'symbol-white.svg'), 'utf8');
  const body = symbol.slice(symbol.indexOf('<g'), symbol.lastIndexOf('</svg>'));
  const tile = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><title>MagisForm</title><rect width="256" height="256" rx="56" fill="#173E35"/><g transform="translate(18 18) scale(.86)">${body}</g></svg>`;
  await fs.writeFile(path.join(brand, 'favicon.svg'), tile);
  for (const size of [32, 180, 192, 512]) {
    const name = size === 180 ? 'apple-touch-icon.png' : size === 32 ? 'favicon-32.png' : `icon-${size}.png`;
    await sharp(Buffer.from(tile)).resize(size).png().toFile(path.join(brand, name));
  }
  const horizontal = await fs.readFile(path.join(brand, 'logo-horizontal-white.svg'), 'utf8');
  const logoBody = horizontal.slice(horizontal.indexOf('<g'), horizontal.lastIndexOf('</svg>'));
  const card = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#173E35"/><g transform="translate(58 55) scale(.66)">${logoBody}</g><text x="64" y="245" fill="#FFFDF8" font-family="Georgia,serif" font-size="65">Do orçamento à entrega,</text><text x="64" y="326" fill="#FFFDF8" font-family="Georgia,serif" font-size="65">cada fórmula sob controle.</text><path d="M64 385H1136" stroke="#789389"/><text x="64" y="448" fill="#DCE8E1" font-family="Segoe UI,sans-serif" font-size="25">Software para farmácias de manipulação</text><rect x="64" y="502" width="334" height="64" rx="32" fill="#D95C4F"/><text x="96" y="543" fill="#101814" font-family="Segoe UI,sans-serif" font-size="22" font-weight="600">Agende uma demonstração</text></svg>`;
  await fs.writeFile(path.join(images, 'sources/social-card.svg'), card);
  await sharp(Buffer.from(card)).png().toFile(path.join(images, 'social-card.png'));
  console.log('Favicons e imagem de compartilhamento renderizados.');
})().catch(error => { console.error(error); process.exitCode = 1; });
