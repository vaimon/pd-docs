import { access, lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const POSIX_PAGE_PATH = /^pages\/[a-z0-9][a-z0-9/-]*\.md$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RAW_HTML = /<\s*\/?\s*[a-z][^>]*>/i;
const MARKDOWN_LINK = /(!?)\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
const SAFE_ASSET = /\.(?:avif|gif|jpe?g|png|webp)$/;

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function parseManifest(source, errors) {
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    errors.push('manifest.json is not valid JSON');
    return null;
  }
  if (
    manifest?.schemaVersion !== 1 ||
    typeof manifest.title !== 'string' ||
    !manifest.title.trim() ||
    !Array.isArray(manifest.sections) ||
    manifest.sections.length === 0
  ) {
    errors.push('manifest.json must use schemaVersion 1 and contain a title and sections');
    return null;
  }
  return manifest;
}

async function markdownFiles(directory, root = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(absolute, root)));
    if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  }
  return files;
}

async function rejectSymbolicLinks(root, relativePath) {
  const absolute = path.join(root, relativePath);
  let stat;
  try {
    stat = await lstat(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`symbolic link "${relativePath}" is not allowed`);
  }
  if (!stat.isDirectory()) return;

  const entries = await readdir(absolute);
  for (const entry of entries) {
    await rejectSymbolicLinks(
      root,
      path.posix.join(relativePath.split(path.sep).join('/'), entry),
    );
  }
}

async function validateMarkdown(markdown, pageFile, root, knownPages, errors) {
  if (RAW_HTML.test(markdown)) errors.push(`${pageFile}: raw HTML is not allowed`);

  const pageDirectory = path.dirname(path.join(root, pageFile));
  for (const match of markdown.matchAll(MARKDOWN_LINK)) {
    const [, imageMarker, rawTarget] = match;
    const target = decodeURI(rawTarget.split('#')[0]);
    if (!target) continue;
    const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(target)?.[0].toLowerCase();
    if (scheme) {
      if (imageMarker) errors.push(`${pageFile}: external image "${rawTarget}" is not allowed`);
      if (!['http:', 'https:', 'mailto:'].includes(scheme)) {
        errors.push(`${pageFile}: unsafe link scheme in "${rawTarget}"`);
      }
      continue;
    }

    const absolute = path.resolve(pageDirectory, target);
    if (!inside(root, absolute)) {
      errors.push(`${pageFile}: link "${rawTarget}" escapes the bundle`);
      continue;
    }
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (imageMarker) {
      if (!relative.startsWith('assets/')) {
        errors.push(`${pageFile}: image "${rawTarget}" must be stored under assets/`);
      } else if (!SAFE_ASSET.test(relative)) {
        errors.push(`${pageFile}: unsafe image format in "${rawTarget}"`);
      } else {
        try {
          await access(absolute);
        } catch {
          errors.push(`${pageFile}: missing image "${relative}"`);
        }
      }
    } else if (target.toLowerCase().endsWith('.md') && !knownPages.has(relative)) {
      errors.push(`${pageFile}: link target "${relative}" is not in the manifest`);
    } else if (!target.toLowerCase().endsWith('.md') && relative.startsWith('assets/')) {
      if (!SAFE_ASSET.test(relative)) {
        errors.push(`${pageFile}: unsafe asset format in "${rawTarget}"`);
      }
    } else if (!target.toLowerCase().endsWith('.md')) {
      errors.push(`${pageFile}: unsupported local link "${rawTarget}"`);
    }
  }
}

export async function validateBundle(bundleDirectory) {
  const root = path.resolve(bundleDirectory);
  const errors = [];
  for (const entry of ['manifest.json', 'pages', 'assets', 'scripts']) {
    await rejectSymbolicLinks(root, entry);
  }
  let source;
  try {
    source = await readFile(path.join(root, 'manifest.json'), 'utf8');
  } catch {
    throw new Error('manifest.json is missing');
  }
  const manifest = parseManifest(source, errors);
  if (!manifest) throw new Error(errors.join('\n'));

  const slugs = new Set();
  const files = new Set();
  for (const section of manifest.sections) {
    if (
      typeof section?.title !== 'string' ||
      !section.title.trim() ||
      !Array.isArray(section.pages) ||
      section.pages.length === 0
    ) {
      errors.push('each manifest section must contain a title and pages');
      continue;
    }
    for (const page of section.pages) {
      if (!SLUG.test(page?.slug ?? '')) errors.push(`invalid slug "${page?.slug ?? ''}"`);
      else if (slugs.has(page.slug)) errors.push(`duplicate slug "${page.slug}"`);
      else slugs.add(page.slug);

      if (typeof page?.title !== 'string' || !page.title.trim()) {
        errors.push(`page "${page?.slug ?? ''}" has no title`);
      }
      if (!POSIX_PAGE_PATH.test(page?.file ?? '') || page.file.includes('..')) {
        errors.push(`invalid page path "${page?.file ?? ''}"`);
        continue;
      }
      if (files.has(page.file)) errors.push(`duplicate page file "${page.file}"`);
      files.add(page.file);
      try {
        await access(path.join(root, page.file));
      } catch {
        errors.push(`missing page "${page.file}"`);
      }
    }
  }

  let actualPages = [];
  try {
    actualPages = (await markdownFiles(path.join(root, 'pages'))).map((file) => `pages/${file}`);
  } catch {
    errors.push('pages directory is missing');
  }
  for (const pageFile of actualPages) {
    if (!files.has(pageFile)) errors.push(`orphan page "${pageFile}"`);
  }
  for (const pageFile of files) {
    try {
      const markdown = await readFile(path.join(root, pageFile), 'utf8');
      await validateMarkdown(markdown, pageFile, root, files, errors);
    } catch {
      // A precise missing-page error was already recorded above.
    }
  }

  if (errors.length) throw new Error(errors.join('\n'));
  return manifest;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const bundleDirectory = process.argv[2] ?? '.';
  try {
    const manifest = await validateBundle(bundleDirectory);
    const pageCount = manifest.sections.reduce((total, section) => total + section.pages.length, 0);
    console.log(`Validated ${pageCount} documentation pages`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
