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

test('accepts an optional FAQ and validates its question grammar', async () => {
  const root = await fixture();
  await mkdir(path.join(root, 'faq'));
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath));
  manifest.faq = {
    title: 'FAQ',
    sections: [{ slug: 'stages', title: 'Stages', file: 'faq/stages.md' }],
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(
    path.join(root, 'faq', 'stages.md'),
    '## Question?\n\nAnswer with [docs](../pages/overview.md).\n\n### Details\n\n- item\n\n`<b>[inline](javascript:bad) ![remote](https://example.com/a.png)</b>`\n\n```sh\n<script>bad()</script>\n![remote](https://example.com/a.png)\n```not-a-close\n## not a question\n```\n',
  );

  await assert.doesNotReject(validateBundle(root));
});

test('rejects malformed, unsafe and orphan FAQ files', async () => {
  const root = await fixture();
  await mkdir(path.join(root, 'faq'));
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath));
  manifest.faq = {
    title: 'FAQ',
    sections: [{ slug: 'stages', title: 'Stages', file: 'faq/stages.md' }],
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(
    path.join(root, 'faq', 'stages.md'),
    '# FAQ\n\n## Empty answer\n\n## Unsafe\n\n<script>x</script>\n\n![remote](https://example.com/a.png)\n',
  );
  await writeFile(path.join(root, 'faq', 'orphan.md'), '## Orphan?\n\nYes.\n');

  await assert.rejects(
    validateBundle(root),
    /orphan FAQ file.*level-one headings.*empty answer.*raw HTML.*external image/s,
  );
});

test('rejects a bare FAQ question marker after a valid item', async () => {
  const root = await fixture();
  await mkdir(path.join(root, 'faq'));
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath));
  manifest.faq = {
    title: 'FAQ',
    sections: [{ slug: 'stages', title: 'Stages', file: 'faq/stages.md' }],
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(
    path.join(root, 'faq', 'stages.md'),
    '## Valid question?\n\nAnswer.\n\n##\n\nText.\n',
  );

  await assert.rejects(validateBundle(root), /empty question/);
});

test('rejects Setext H1 and H2 in FAQ prose', async () => {
  for (const underline of ['===', '---']) {
    const root = await fixture();
    await mkdir(path.join(root, 'faq'));
    const manifestPath = path.join(root, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath));
    manifest.faq = {
      title: 'FAQ',
      sections: [{ slug: 'stages', title: 'Stages', file: 'faq/stages.md' }],
    };
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(
      path.join(root, 'faq', 'stages.md'),
      `## Valid question?\n\nAnswer.\n\nSetext\n${underline}\n`,
    );

    await assert.rejects(validateBundle(root), /Setext headings are not allowed/);
  }
});

test('accepts HTML and link syntax in top-level indented code with blank continuation', async () => {
  const root = await fixture();
  await writeFile(
    path.join(root, 'pages', 'overview.md'),
    '# Overview\n\n    <script>not markup</script>\n\n    ![remote](https://example.com/a.png) [unsafe](javascript:bad)\n',
  );

  await assert.doesNotReject(validateBundle(root));
});

test('still scans an indented list continuation as prose', async () => {
  const root = await fixture();
  await writeFile(
    path.join(root, 'pages', 'overview.md'),
    '# Overview\n\n- item\n\n    ![remote](https://example.com/a.png) [unsafe](javascript:bad)\n',
  );

  await assert.rejects(validateBundle(root), /external image.*unsafe link scheme/s);
});

test('escaped backticks do not hide unsafe prose while genuine code spans do', async () => {
  const rejected = await fixture(
    '# Overview\n\n\\`![remote](https://example.com/a.png) [unsafe](javascript:bad)\\`\n',
  );
  await assert.rejects(validateBundle(rejected), /external image.*unsafe link scheme/s);

  const accepted = await fixture(
    '# Overview\n\n\\\\`![remote](https://example.com/a.png) [unsafe](javascript:bad)\\\\`\n',
  );
  await assert.doesNotReject(validateBundle(accepted));
});

test('matches CommonMark ATX indentation and permits a list thematic break', async () => {
  const root = await fixture();
  await mkdir(path.join(root, 'faq'));
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath));
  manifest.faq = {
    title: 'FAQ',
    sections: [{ slug: 'stages', title: 'Stages', file: 'faq/stages.md' }],
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(
    path.join(root, 'faq', 'stages.md'),
    '  ## Indented question?\n\n- item\n---\n',
  );
  await assert.doesNotReject(validateBundle(root));

  await writeFile(
    path.join(root, 'faq', 'stages.md'),
    '  # Hidden H1\n\n  ## Question?\n\nAnswer.\n',
  );
  await assert.rejects(validateBundle(root), /level-one headings are not allowed/);
});
