import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { hashPassword, verifyPassword } from '../../src/domain/passwords.ts';
import { csvCell, toCsv } from '../../src/util/csv.ts';
import { FormReader, slugify } from '../../src/util/form.ts';
import { formatUtc, fromDatetimeLocal, relative } from '../../src/util/time.ts';
import { html, raw } from '../../src/views/html.ts';

describe('csv', () => {
  test('neutralizes formula injection in text', () => {
    assert.equal(csvCell('=HYPERLINK("http://evil")'), `"'=HYPERLINK(""http://evil"")"`);
    assert.equal(csvCell('+1'), "'+1");
    assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
    assert.equal(csvCell('-2+3'), "'-2+3");
  });

  test('keeps numbers numeric, including negative offsets', () => {
    assert.equal(csvCell(-0.39), '-0.39');
    assert.equal(csvCell(4), '4');
    assert.equal(csvCell(Number.NaN), '');
  });

  test('quotes commas, quotes and newlines, and ends lines with CRLF', () => {
    assert.equal(toCsv(['a', 'b'], [['x,y', 'say "hi"\nthere']]), 'a,b\r\n"x,y","say ""hi""\nthere"\r\n');
  });
});

describe('html', () => {
  test('escapes interpolated values', () => {
    assert.equal(html`<p>${'<script>alert(1)</script>'}</p>`.value, '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    assert.equal(html`<a title="${`" onmouseover="x`}">`.value, '<a title="&quot; onmouseover=&quot;x">');
  });

  test('passes SafeHtml through and flattens arrays', () => {
    assert.equal(html`<ul>${['a', '<b>'].map((x) => html`<li>${x}</li>`)}</ul>`.value, '<ul><li>a</li><li>&lt;b&gt;</li></ul>');
    assert.equal(html`${raw('<br>')}${null}${false}${0}`.value, '<br>0');
  });
});

describe('form reading', () => {
  test('collects every error at once', () => {
    const form = new FormReader({ title: '', url: 'javascript:alert(1)', n: '99' });
    form.text('title', { label: 'Title', required: true });
    form.url('url', 'Link');
    form.int('n', { label: 'N', min: 1, max: 20 });
    assert.deepEqual(Object.keys(form.errors).sort(), ['n', 'title', 'url']);
  });

  test('accepts http(s) URLs only', () => {
    const form = new FormReader({ a: 'https://example.org/x', b: 'data:text/html,hi' });
    assert.equal(form.url('a', 'A'), 'https://example.org/x');
    form.url('b', 'B');
    assert.ok(form.errors.b);
  });

  test('slugify', () => {
    assert.equal(slugify('Sample Hack 2026!'), 'sample-hack-2026');
    assert.equal(slugify('  Café  Night '), 'cafe-night');
  });
});

describe('time', () => {
  test('datetime-local values are read as UTC', () => {
    assert.equal(fromDatetimeLocal('2026-03-01T18:00'), '2026-03-01T18:00:00.000Z');
    assert.equal(fromDatetimeLocal('not a date'), null);
  });

  test('formats and describes instants', () => {
    assert.equal(formatUtc('2026-03-01T18:00:00Z'), '1 Mar 2026, 18:00 UTC');
    const now = new Date('2026-03-01T18:00:00Z');
    assert.equal(relative('2026-03-01T20:00:00Z', now), 'in 2 hours');
    assert.equal(relative('2026-02-27T18:00:00Z', now), '2 days ago');
  });
});

describe('passwords', () => {
  test('hash and verify with scrypt; wrong or missing hashes fail', async () => {
    const hash = await hashPassword('correct horse');
    assert.match(hash, /^scrypt\$16384\$8\$1\$/);
    assert.equal(await verifyPassword('correct horse', hash), true);
    assert.equal(await verifyPassword('wrong horse', hash), false);
    assert.equal(await verifyPassword('anything', null), false);
    assert.notEqual(await hashPassword('correct horse'), hash, 'salted');
  });
});
