import { access, lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const POSIX_PAGE_PATH = /^pages\/[a-z0-9][a-z0-9/-]*\.md$/;
const POSIX_FAQ_PATH = /^faq\/[a-z0-9][a-z0-9/-]*\.md$/;
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

function fenceOpening(text) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  return { marker: match[1][0], length: match[1].length };
}

function closesFence(text, fence) {
  const run = /^ {0,3}(`+|~+)[ \t]*$/.exec(text)?.[1];
  return Boolean(run && run[0] === fence.marker && run.length >= fence.length);
}

function isEscaped(text, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function maskInlineCode(text) {
  const characters = text.split('');
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '`' || isEscaped(text, start)) continue;
    let length = 1;
    while (text[start + length] === '`') length += 1;
    let end = start + length;
    while (end < text.length) {
      const candidate = text.indexOf('`'.repeat(length), end);
      if (candidate === -1) break;
      if (
        !isEscaped(text, candidate) &&
        text[candidate - 1] !== '`' &&
        text[candidate + length] !== '`'
      ) {
        for (let index = start; index < candidate + length; index += 1) characters[index] = ' ';
        start = candidate + length - 1;
        break;
      }
      end = candidate + length;
    }
  }
  return characters.join('');
}

function maskMarkdownCode(markdown) {
  let fence;
  let indentedCode = false;
  let listContext = false;
  let previousBlank = true;
  let masked = '';
  for (const line of markdown.matchAll(/^.*(?:\r?\n|$)/gm)) {
    if (!line[0]) continue;
    const newline = /\r?\n$/.exec(line[0])?.[0] ?? '';
    const text = line[0].slice(0, line[0].length - newline.length);
    if (fence) {
      if (closesFence(text, fence)) fence = undefined;
      masked += ' '.repeat(text.length) + newline;
      continue;
    }
    if (indentedCode) {
      if (!text.trim() || /^(?: {4}|\t)/.test(text)) {
        masked += ' '.repeat(text.length) + newline;
        previousBlank = !text.trim();
        continue;
      }
      indentedCode = false;
    }
    const opening = fenceOpening(text);
    if (opening) {
      fence = opening;
      masked += ' '.repeat(text.length) + newline;
      continue;
    }
    const listItem = /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/.test(text);
    if (listItem) listContext = true;
    else if (text.trim() && !/^[ \t]+/.test(text)) listContext = false;
    if (
      previousBlank &&
      !listContext &&
      /^(?: {4}|\t)/.test(text) &&
      text.trim()
    ) {
      indentedCode = true;
      masked += ' '.repeat(text.length) + newline;
      previousBlank = false;
      continue;
    }
    masked += text + newline;
    previousBlank = !text.trim();
  }
  return maskInlineCode(masked);
}

function isSetextTextLine(text) {
  return Boolean(
    text.trim() &&
      !/^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/.test(text) &&
      !/^ {0,3}>/.test(text) &&
      !/^ {0,3}#{1,6}(?:[ \t]+|$)/.test(text) &&
      !/^(?: {4}|\t)/.test(text) &&
      !/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.test(text),
  );
}

async function validateMarkdown(markdown, pageFile, root, knownPages, errors) {
  const prose = maskMarkdownCode(markdown);
  if (RAW_HTML.test(prose)) errors.push(`${pageFile}: raw HTML is not allowed`);

  const pageDirectory = path.dirname(path.join(root, pageFile));
  for (const match of prose.matchAll(MARKDOWN_LINK)) {
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

function validateFaqGrammar(markdown, faqFile, errors) {
  const headings = [];
  let fence;
  let previousLine = '';
  for (const line of markdown.matchAll(/^.*(?:\r?\n|$)/gm)) {
    if (!line[0]) continue;
    const text = line[0].replace(/\r?\n$/, '');
    if (fence) {
      if (closesFence(text, fence)) fence = undefined;
      continue;
    }
    const opening = fenceOpening(text);
    if (opening) {
      fence = opening;
      previousLine = '';
      continue;
    }
    if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(text) && isSetextTextLine(previousLine)) {
      errors.push(`${faqFile}: Setext headings are not allowed`);
    }
    const heading = /^ {0,3}(#{1,2})(?:[ \t]+(.*?))?[ \t]*$/.exec(text);
    if (heading) {
      headings.push({
        level: heading[1].length,
        title: (heading[2] ?? '').trim(),
        start: line.index,
        end: line.index + text.length,
      });
    }
    previousLine = text;
  }
  if (headings.some((heading) => heading.level === 1)) {
    errors.push(`${faqFile}: level-one headings are not allowed`);
  }
  const questions = headings.filter((heading) => heading.level === 2);
  if (!questions.length || markdown.slice(0, questions[0]?.start ?? 0).trim()) {
    errors.push(`${faqFile}: FAQ must start with a level-two question`);
  }
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index].title;
    const answerStart = questions[index].end;
    const answerEnd = questions[index + 1]?.start ?? markdown.length;
    if (!question) errors.push(`${faqFile}: empty question`);
    if (!markdown.slice(answerStart, answerEnd).trim()) {
      errors.push(`${faqFile}: empty answer for "${question}"`);
    }
  }
}

export async function validateBundle(bundleDirectory) {
  const root = path.resolve(bundleDirectory);
  const errors = [];
  for (const entry of ['manifest.json', 'pages', 'faq', 'assets', 'scripts']) {
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

  const faqFiles = new Set();
  if (manifest.faq !== undefined) {
    if (
      typeof manifest.faq?.title !== 'string' ||
      !manifest.faq.title.trim() ||
      !Array.isArray(manifest.faq.sections) ||
      manifest.faq.sections.length === 0
    ) {
      errors.push('faq must contain a title and sections');
    } else {
      const faqSlugs = new Set();
      for (const section of manifest.faq.sections) {
        if (!SLUG.test(section?.slug ?? '') || faqSlugs.has(section.slug)) {
          errors.push(`invalid or duplicate FAQ slug "${section?.slug ?? ''}"`);
        } else faqSlugs.add(section.slug);
        if (typeof section?.title !== 'string' || !section.title.trim()) {
          errors.push(`FAQ section "${section?.slug ?? ''}" has no title`);
        }
        if (!POSIX_FAQ_PATH.test(section?.file ?? '') || section.file.includes('..')) {
          errors.push(`invalid FAQ path "${section?.file ?? ''}"`);
          continue;
        }
        if (faqFiles.has(section.file)) errors.push(`duplicate FAQ file "${section.file}"`);
        faqFiles.add(section.file);
        try {
          await access(path.join(root, section.file));
        } catch {
          errors.push(`missing FAQ file "${section.file}"`);
        }
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
  let actualFaqFiles = [];
  try {
    actualFaqFiles = (await markdownFiles(path.join(root, 'faq'))).map((file) => `faq/${file}`);
  } catch {
    if (manifest.faq !== undefined) errors.push('faq directory is missing');
  }
  for (const faqFile of actualFaqFiles) {
    if (!faqFiles.has(faqFile)) errors.push(`orphan FAQ file "${faqFile}"`);
  }
  for (const pageFile of files) {
    try {
      const markdown = await readFile(path.join(root, pageFile), 'utf8');
      await validateMarkdown(markdown, pageFile, root, files, errors);
    } catch {
      // A precise missing-page error was already recorded above.
    }
  }
  for (const faqFile of faqFiles) {
    try {
      const markdown = await readFile(path.join(root, faqFile), 'utf8');
      validateFaqGrammar(markdown, faqFile, errors);
      await validateMarkdown(markdown, faqFile, root, files, errors);
    } catch {
      // A precise missing-file error was already recorded above.
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
