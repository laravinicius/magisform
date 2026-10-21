import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { stdin, stdout } from 'node:process';

const root = path.resolve(process.env.MAGISFORM_PROVISION_ROOT ?? path.resolve(import.meta.dirname, '..'));
const template = path.join(root, 'deploy/tenant-template/compose.yaml');
const catalogFile = path.join(root, 'deploy/tenants/catalog.json');
const args = process.argv.slice(2);
const id = args[0];
const host = args[1]?.toLowerCase();
const imageFlag = args.indexOf('--image');
const image = imageFlag >= 0 ? args[imageFlag + 1] : '';
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const apply = args.includes('--apply');
const jsonResult = args.includes('--json-result');
const defaultBrand = id?.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
const brand = option('--brand', defaultBrand);
const theme = {
  primary: option('--primary', '#D95C4F'), secondary: option('--secondary', '#173E35'),
  background: option('--background', '#F4F1E9'), surface: option('--surface', '#FFFDF8'),
  ink: option('--ink', '#17201D'), muted: option('--muted', '#5F6965'),
};
const usage = 'Uso: npm run tenant:provision -- <id> <host> --image <repo@sha256:digest|magisform:git-commit> [--brand "Nome público"] [--primary #RRGGBB] [--secondary #RRGGBB] [--background #RRGGBB] [--surface #RRGGBB] [--ink #RRGGBB] [--muted #RRGGBB] [--apply]';
if (!/^[a-z][a-z0-9-]{1,30}$/.test(id ?? '') || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host ?? '') || !image || /[\r\n\0]/.test(image)) throw new Error(usage);
if (typeof brand !== 'string' || !brand.trim() || brand.trim().length > 80 || /[\r\n\0<>]/.test(brand) || Object.values(theme).some((color) => !/^#[0-9a-fA-F]{6}$/.test(color ?? ''))) throw new Error('Marca ou tema público inválido. Use nome simples e cores hexadecimais #RRGGBB.');
if (!(/@sha256:[a-f0-9]{64}$/.test(image) || /^magisform:git-[a-f0-9]{7,40}$/.test(image))) throw new Error('Informe um digest sha256 aprovado ou a imagem local identificada pelo commit.');
const install = path.join(root, 'deploy/tenants', id);
const alias = `mf-${id}`;
const network = `npm-${id}`;
const project = `magisform-${id}`;
let catalog = {};
try { catalog = JSON.parse(await fs.readFile(catalogFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const docker = (dockerArgs, input) => spawnSync('docker', dockerArgs, { cwd: existsSync(install) ? install : root, encoding: 'utf8', windowsHide: true, input, maxBuffer: 1024 * 1024 });
const checked = (dockerArgs, input) => {
  const result = docker(dockerArgs, input);
  if (result.error || result.status !== 0) throw new Error(`Docker falhou (${dockerArgs[0]}): ${result.error?.message ?? result.stderr.trim()}`);
  return result.stdout.trim();
};
let edgeCidr = catalog[id]?.edgeCidr;
const existingNetwork = docker(['network', 'inspect', network]);
if (existingNetwork.status === 0) {
  const info = JSON.parse(existingNetwork.stdout)[0];
  if (info?.Labels?.['com.magisform.tenant'] !== id) throw new Error('Rede de entrada preexistente não pertence a esta instalação.');
  edgeCidr = info.IPAM?.Config?.[0]?.Subnet;
}
const reserved = new Set(Object.values(catalog ?? {}).map((tenant) => tenant.edgeCidr).filter(Boolean));
try {
  for (const networkId of checked(['network', 'ls', '-q']).split(/\r?\n/).filter(Boolean)) {
    for (const config of JSON.parse(checked(['network', 'inspect', networkId]))[0]?.IPAM?.Config ?? []) if (config.Subnet) reserved.add(config.Subnet);
  }
} catch { /* modo prepare continua disponível sem daemon Docker */ }
if (!edgeCidr) {
  const start = Number.parseInt(crypto.createHash('sha256').update(id).digest('hex').slice(0, 4), 16);
  for (let offset = 0; offset < 55 * 254; offset += 1) {
    const pool = 200 + Math.floor(offset / 254);
    const hostOctet = ((start + offset) % 254) + 1;
    const candidate = `10.${pool}.${hostOctet}.0/24`;
    if (![...reserved].some((range) => {
      const [ip, bitsText] = range.split('/'); const bits = Number(bitsText);
      if (!ip || !Number.isInteger(bits) || bits < 0 || bits > 32) return true;
      const val = (s) => s.split('.').map(Number).reduce((a, n) => ((a * 256) + n) >>> 0, 0);
      const low = val(ip); const high = bits === 0 ? 0xffffffff : (low | (0xffffffff >>> bits)) >>> 0;
      const candidateLow = val(candidate.split('/')[0]); const candidateHigh = (candidateLow + 255) >>> 0;
      return candidateLow <= high && candidateHigh >= low;
    })) { edgeCidr = candidate; break; }
  }
}
if (!edgeCidr) throw new Error('Não foi possível reservar uma sub-rede /24 exclusiva para esta instalação.');
const portSuffix = process.env.MAGISFORM_SERVER_ORIGIN_PORT_SUFFIX ?? '';
if (portSuffix && !/^:\d{1,5}$/.test(portSuffix)) throw new Error('Sufixo de porta de origem inválido.');
const values = { COMPOSE_PROJECT_NAME: project, MAGISFORM_IMAGE: image, TENANT_HOST: host, TENANT_ORIGIN: `https://${host}${portSuffix}`, TENANT_ALLOW_HOST_WITHOUT_PORT: String(Boolean(portSuffix)), TENANT_NAME: brand.trim(), TENANT_BRAND: brand.trim(), TENANT_BRAND_PRIMARY: theme.primary, TENANT_BRAND_SECONDARY: theme.secondary, TENANT_BRAND_BACKGROUND: theme.background, TENANT_BRAND_SURFACE: theme.surface, TENANT_BRAND_INK: theme.ink, TENANT_BRAND_MUTED: theme.muted, TENANT_ALIAS: alias, TENANT_EDGE_NETWORK: network, TENANT_EDGE_CIDR: edgeCidr };
const escapeEnv = (value) => String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
const writePrivate = async (file, data) => {
  await fs.writeFile(file, data, { flag: 'wx', mode: 0o600 });
  if (process.platform !== 'win32') await fs.chmod(file, 0o600);
  else {
    try {
      if (!process.env.USERNAME) throw new Error('Não foi possível determinar a conta para restringir o segredo no Windows.');
      const acl = spawnSync('icacls.exe', [file, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(F)`, '/grant:r', 'SYSTEM:(F)'], { encoding: 'utf8', windowsHide: true });
      if (acl.error || acl.status !== 0) throw new Error(`Não foi possível restringir a ACL do segredo ${path.basename(file)}.`);
    } catch (error) {
      await fs.rm(file, { force: true });
      throw error;
    }
  }
};

let preparedExisting = false;
if (catalog[id]) {
  if (catalog[id].host !== host || catalog[id].image !== image || catalog[id].brand !== brand.trim() || JSON.stringify(catalog[id].brandTheme) !== JSON.stringify(theme) || catalog[id].compose !== `deploy/tenants/${id}/compose.yaml`) throw new Error('ID já provisionado com outro host/imagem/marca. Instalação não alterada.');
  if (!catalog[id].edgeCidr) {
    const envPath = path.join(install, '.env');
    const currentEnv = await fs.readFile(envPath, 'utf8');
    if (/^TENANT_EDGE_CIDR=/m.test(currentEnv)) throw new Error('CIDR de rede no .env diverge do catálogo; revisão manual necessária.');
    const nextEnv = `${currentEnv.trimEnd()}\nTENANT_EDGE_CIDR=${edgeCidr}\n`;
    await fs.writeFile(`${envPath}.stage10`, nextEnv, { flag: 'wx', mode: 0o600 });
    await fs.rename(`${envPath}.stage10`, envPath);
    catalog[id].edgeCidr = edgeCidr;
    const migratedCatalog = `${catalogFile}.${process.pid}.stage10.tmp`;
    await fs.writeFile(migratedCatalog, JSON.stringify(catalog, null, 2) + '\n', { flag: 'wx' });
    await fs.rename(migratedCatalog, catalogFile);
  }
  if (!apply || catalog[id].status === 'provisioned') {
    if (jsonResult && catalog[id].status === 'provisioned') {
      const saved = Object.fromEntries((await fs.readFile(path.join(install, 'secrets/initial-admin.txt'), 'utf8')).trim().split(/\r?\n/).map((line) => { const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)]; }));
      process.stdout.write(JSON.stringify({ id, host, name: brand.trim(), admin: { name: saved.nome, username: saved.usuario, password: saved.senha } }) + '\n');
      process.exit(0);
    }
    console.log(`Instalação ${id} já existe; nenhum arquivo ou segredo foi alterado.`);
    console.log(`Compose: ${path.join(install, 'compose.yaml')}`);
    console.log(`Alias NPM: ${alias}:3001; host: ${host}`);
    process.exit(0);
  }
  if (!['prepared', 'provisioning'].includes(catalog[id].status)) throw new Error('Instalação em estado intermediário. Revisão manual necessária; segredos não foram alterados.');
  preparedExisting = true;
}
if (!preparedExisting) {
  try { await fs.access(install); throw new Error('Diretório da instalação já existe fora do catálogo. Revisão manual necessária; nenhum arquivo alterado.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  await fs.mkdir(path.join(install, 'secrets'), { recursive: true });
  await fs.copyFile(template, path.join(install, 'compose.yaml'));
  await writePrivate(path.join(install, '.env'), Object.entries(values).map(([key, value]) => `${key}=${escapeEnv(value)}`).join('\n') + '\n');
  await writePrivate(path.join(install, 'secrets/db_password.txt'), crypto.randomBytes(32).toString('base64url') + '\n');
  await writePrivate(path.join(install, 'secrets/db_root_password.txt'), crypto.randomBytes(48).toString('base64url') + '\n');
  await writePrivate(path.join(install, 'installation.json'), JSON.stringify({ id, host, alias, image, createdAt: new Date().toISOString(), status: apply ? 'provisioning' : 'prepared' }, null, 2) + '\n');
const instructions = `# Instalação ${id}\n\n- Host: \`${host}\`\n- Projeto Compose: \`${project}\`\n- Alias exclusivo na rede: \`${alias}:3001\`\n- Rede de entrada: \`${network}\` (\`${edgeCidr}\`, exclusiva desta farmácia)\n- Segredos e volume: exclusivos deste diretório/projeto.\n- Imagem compartilhada: \`${image}\`\n\n## Aplicação\n\nEntre neste diretório e execute \`docker compose up -d db\`. Após o banco ficar saudável, execute \`docker compose run --rm --no-deps app node scripts/database-schema.mjs bootstrap\`. Crie o administrador inicial usando o comando de provisionamento do repositório com \`--apply\`; a senha fica em \`secrets/initial-admin.txt\` com acesso restrito. Por fim, execute \`docker compose up -d app\`.\n\nConecte o container \`magisform-npm\` à rede exclusiva com \`docker network connect ${network} magisform-npm\`. Cadastre no NPM Proxy Host para \`${host}\`, esquema HTTP, upstream \`${alias}:3001\`, websockets e Block Common Exploits ligados; selecione certificado individual para este hostname, Force SSL e HTTP/2. O mesmo host atende frontend e \`/api/v1\`. O NPM não deve ser conectado à rede \`data\`.\n\nNão há porta publicada no host. A rede \`data\` é interna e contém apenas app e MariaDB. Para parar, use \`docker compose down\`; preserve o volume \`${project}_mariadb_data\` em rollback.\n`;
await fs.writeFile(path.join(install, 'NPM-Proxy-Host.md'), instructions, { flag: 'wx' });
catalog[id] = { host, alias, network, edgeCidr, image, brand: brand.trim(), brandTheme: theme, compose: `deploy/tenants/${id}/compose.yaml`, status: apply ? 'provisioning' : 'prepared', createdAt: catalog[id]?.createdAt ?? new Date().toISOString() };
await fs.mkdir(path.dirname(catalogFile), { recursive: true });
const temporaryCatalog = `${catalogFile}.${process.pid}.tmp`;
await fs.writeFile(temporaryCatalog, JSON.stringify(catalog, null, 2) + '\n', { flag: 'wx' });
await fs.rename(temporaryCatalog, catalogFile);
}

if (apply) {
  const networkResult = docker(['network', 'inspect', network]);
  if (networkResult.status === 0) {
    const existing = JSON.parse(networkResult.stdout)[0];
    if (existing?.Labels?.['com.magisform.tenant'] !== id) throw new Error('Rede de entrada preexistente não pertence a esta instalação. Nenhum container foi iniciado.');
  } else checked(['network', 'create', '--label', `com.magisform.tenant=${id}`, '--subnet', edgeCidr, network]);
  checked(['compose', 'up', '-d', 'db']);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = docker(['compose', 'ps', '--format', 'json', 'db']);
    if (result.status === 0 && result.stdout.trim()) {
      try {
        const services = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
        ready = services.some((service) => service.Health === 'healthy');
      } catch { ready = false; }
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!ready) throw new Error('MariaDB não ficou saudável em 120 s; diretório, segredos e volume foram preservados para recuperação.');
  const preflight = checked(['compose', 'run', '--rm', '--no-deps', 'app', 'node', 'scripts/database-schema.mjs', 'preflight']);
  if (/banco magisform vazio; elegível para bootstrap/.test(preflight)) {
    checked(['compose', 'run', '--rm', '--no-deps', 'app', 'node', 'scripts/database-schema.mjs', 'bootstrap']);
  } else if (!/schema v3 válido \(bootstrap\)/.test(preflight)) {
    throw new Error('Preflight não reconheceu schema bootstrap v3; nenhuma alteração de schema foi aplicada.');
  }
  const prompt = args.includes('--admin-name') && args.includes('--admin-user') ? null : readline.createInterface({ input: stdin, output: stdout });
  try {
    const adminFile = path.join(install, 'secrets/initial-admin.txt');
    let adminName, username, password;
    try {
      const saved = Object.fromEntries((await fs.readFile(adminFile, 'utf8')).trim().split(/\r?\n/).map((line) => { const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)]; }));
      adminName = saved.nome; username = saved.usuario; password = saved.senha;
      if (!adminName || !username || !password) throw new Error('Arquivo de administrador inicial inválido; revisão manual necessária.');
      if (args.includes('--admin-name') && option('--admin-name', '') !== adminName) throw new Error('O nome do administrador diverge das credenciais já protegidas. Nenhuma alteração foi feita.');
      if (args.includes('--admin-user') && option('--admin-user', '') !== username) throw new Error('O usuário do administrador diverge das credenciais já protegidas. Nenhuma alteração foi feita.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      adminName = option('--admin-name', 'Administrador');
      username = option('--admin-user', 'admin');
      if (prompt) {
        adminName = await prompt.question('Nome do administrador inicial: ');
        username = await prompt.question('Usuário do administrador inicial (único): ');
      }
      password = crypto.randomBytes(32).toString('base64url');
      await writePrivate(adminFile, `nome=${adminName}\nusuario=${username}\nsenha=${password}\n`);
    }
    const seed = JSON.stringify({ name: adminName, username, password });
    checked(['compose', 'run', '--rm', '--no-deps', '-T', 'app', 'node', 'scripts/tenant-initial-admin.mjs'], seed);
  } finally { prompt?.close(); }
  checked(['compose', 'up', '-d', 'app']);
  const record = JSON.parse(await fs.readFile(path.join(install, 'installation.json'), 'utf8'));
  record.status = 'provisioned';
  await fs.writeFile(path.join(install, 'installation.json'), JSON.stringify(record, null, 2) + '\n');
  catalog[id].status = 'provisioned';
  catalog[id].completedAt = new Date().toISOString();
  const completedCatalog = `${catalogFile}.${process.pid}.tmp`;
  await fs.writeFile(completedCatalog, JSON.stringify(catalog, null, 2) + '\n', { flag: 'wx' });
  await fs.rename(completedCatalog, catalogFile);
}
if (jsonResult) {
  const saved = Object.fromEntries((await fs.readFile(path.join(install, 'secrets/initial-admin.txt'), 'utf8')).trim().split(/\r?\n/).map((line) => { const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)]; }));
  process.stdout.write(JSON.stringify({ id, host, name: brand.trim(), admin: { name: saved.nome, username: saved.usuario, password: saved.senha } }) + '\n');
} else {
  console.log(`Instalação ${id} preparada em ${install}.`);
  console.log(`Host ${host} → rede ${network}, alias ${alias}:3001.`);
  console.log(`Rede de entrada ${network} (${edgeCidr}); o executor conecta o NPM e configura o Proxy Host automaticamente.`);
  console.log(`Instruções persistentes: ${path.join(install, 'NPM-Proxy-Host.md')}`);
  if (!apply) console.log('Para executar bootstrap e criar o administrador após validar imagem/ambiente, repita o mesmo comando com --apply.');
}
