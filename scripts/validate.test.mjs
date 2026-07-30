import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateBundle } from './validate.mjs';

async function fixture(markdown = '# Обзор\n\n[Требования](requirements.md)\n') {
  const root = await mkdtemp(path.join(tmpdir(), 'pd-docs-'));
  await mkdir(path.join(root, 'pages'));
  await writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      title: 'Руководство',
      sections: [
        {
          title: 'Основное',
          pages: [
            { slug: 'overview', title: 'Обзор', file: 'pages/overview.md' },
            {
              slug: 'requirements',
              title: 'Требования',
              file: 'pages/requirements.md',
            },
          ],
        },
      ],
    }),
  );
  await writeFile(path.join(root, 'pages', 'overview.md'), markdown);
  await writeFile(path.join(root, 'pages', 'requirements.md'), '# Требования\n');
  return root;
}

test('accepts a complete bundle and returns its manifest', async () => {
  const root = await fixture();

  const manifest = await validateBundle(root);

  assert.equal(manifest.sections[0].pages[0].slug, 'overview');
});

test('reports duplicate slugs and missing page files', async () => {
  const root = await fixture();
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath));
  manifest.sections[0].pages[1] = {
    slug: 'overview',
    title: 'Нет страницы',
    file: 'pages/missing.md',
  };
  await writeFile(manifestPath, JSON.stringify(manifest));

  await assert.rejects(
    validateBundle(root),
    /duplicate slug "overview".*missing page "pages\/missing\.md"/s,
  );
});

test('rejects unsafe markup, external images and traversal links', async () => {
  const root = await fixture(
    '# Обзор\n\n<script>alert(1)</script>\n\n![remote](https://example.com/a.png)\n\n![vector](../assets/unsafe.svg)\n\n[secret](../secret.md)\n',
  );

  await assert.rejects(
    validateBundle(root),
    /raw HTML.*external image.*unsafe image format.*not in the manifest/s,
  );
});

test('rejects uppercase asset extensions', async () => {
  const root = await fixture('# Обзор\n\n![upper](../assets/photo.PNG)\n');

  await assert.rejects(
    validateBundle(root),
    /unsafe image format in "\.\.\/assets\/photo\.PNG"/,
  );
});

test('reports orphan Markdown pages', async () => {
  const root = await fixture();
  await writeFile(path.join(root, 'pages', 'orphan.md'), '# Лишняя\n');

  await assert.rejects(validateBundle(root), /orphan page "pages\/orphan\.md"/);
});

test('rejects symbolic links anywhere in the public bundle', async (context) => {
  const root = await fixture();
  const outside = path.join(root, '..', `outside-${path.basename(root)}.md`);
  await writeFile(outside, '# Outside\n');
  try {
    await symlink(outside, path.join(root, 'pages', 'linked.md'));
  } catch (error) {
    if (error.code === 'EPERM') {
      context.skip('creating symlinks requires elevated privileges on Windows');
      return;
    }
    throw error;
  }

  await assert.rejects(
    validateBundle(root),
    /symbolic link "pages\/linked\.md" is not allowed/,
  );
});
