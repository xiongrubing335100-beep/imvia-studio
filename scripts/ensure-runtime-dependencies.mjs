import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(process.env.IMVIA_PLUGIN_ROOT || path.join(scriptDirectory, '..'));
const packageJsonPath = path.join(pluginRoot, 'package.json');
const nodeModulesDirectory = path.join(pluginRoot, 'node_modules');
const pnpmStoreDirectory = path.join(nodeModulesDirectory, '.pnpm');

async function isUsablePath(candidate) {
  try {
    await fs.stat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function findPnpmPackage(dependencyName) {
  const encodedPrefix = dependencyName.startsWith('@')
    ? `${dependencyName.replace('/', '+')}@`
    : `${dependencyName}@`;

  let entries;
  try {
    entries = await fs.readdir(pnpmStoreDirectory, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(encodedPrefix)) continue;
    const candidate = path.join(pnpmStoreDirectory, entry.name, 'node_modules', dependencyName);
    if (await isUsablePath(candidate)) return candidate;
  }
  return null;
}

async function ensureDependency(dependencyName, destination, optional = false) {
  if (await isUsablePath(destination)) return false;

  const target = await findPnpmPackage(dependencyName);
  if (!target && optional) return false;
  if (!target) {
    throw new Error(
      `Missing runtime dependency "${dependencyName}". The plugin cache has no usable pnpm package. ` +
        'Reinstall IMVIA Studio from its marketplace source.',
    );
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });
  const relativeTarget = path.relative(path.dirname(destination), target);
  const linkTarget = process.platform === 'win32' ? target : relativeTarget;
  try {
    await fs.symlink(linkTarget, destination, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error?.code !== 'EEXIST' || !(await isUsablePath(destination))) throw error;
  }
  return true;
}

const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
const repaired = [];

async function ensurePackageDependencies(packageMetadata, dependencyContainer) {
  const optionalDependencies = new Set(Object.keys(packageMetadata.optionalDependencies || {}));
  for (const [dependencyName, metadata] of Object.entries(packageMetadata.peerDependenciesMeta || {})) {
    if (metadata?.optional) optionalDependencies.add(dependencyName);
  }
  const dependencies = {
    ...(packageMetadata.dependencies || {}),
    ...(packageMetadata.peerDependencies || {}),
  };
  for (const dependencyName of Object.keys(dependencies)) {
    const destination = path.join(dependencyContainer, dependencyName);
    if (await ensureDependency(dependencyName, destination, optionalDependencies.has(dependencyName))) {
      repaired.push(dependencyName);
    }
  }
}

async function packageRootsInPnpmStore() {
  const roots = [];
  let entries;
  try {
    entries = await fs.readdir(pnpmStoreDirectory, { withFileTypes: true });
  } catch {
    return roots;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const container = path.join(pnpmStoreDirectory, entry.name, 'node_modules');
    let children;
    try {
      children = await fs.readdir(container, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      const childPath = path.join(container, child.name);
      if (child.name.startsWith('@') && child.isDirectory()) {
        let scopedChildren;
        try {
          scopedChildren = await fs.readdir(childPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const scopedChild of scopedChildren) {
          if (scopedChild.isDirectory() && await isUsablePath(path.join(childPath, scopedChild.name, 'package.json'))) {
            roots.push(path.join(childPath, scopedChild.name));
          }
        }
      } else if (child.isDirectory() && await isUsablePath(path.join(childPath, 'package.json'))) {
        roots.push(childPath);
      }
    }
  }
  return roots;
}

await ensurePackageDependencies(packageJson, nodeModulesDirectory);
for (const packageRoot of await packageRootsInPnpmStore()) {
  const metadata = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const packageParent = path.dirname(packageRoot);
  const dependencyContainer = path.basename(packageParent).startsWith('@')
    ? path.dirname(packageParent)
    : packageParent;
  await ensurePackageDependencies(metadata, dependencyContainer);
}

if (repaired.length > 0) {
  process.stderr.write(`IMVIA Studio repaired ${repaired.length} runtime dependency links.\n`);
}
