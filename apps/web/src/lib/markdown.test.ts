import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from './markdown';

/** Fixture text of our own: the real notice is written by package 5.6. */
const FIXTURE = `# How Lance uses your data

Lance reads your **mail** and *calendar* to prepare proposals.
It never sends mail.

## What is kept

- Mail bodies for 90 days
- Transcripts for 180 days,
  then removed
- The ledger for two years

1. Read this notice.
2. Accept it.

Questions go to [the Lance admins](mailto:lance-admins@valliance.ai), or see \`docs/compliance\`.`;

describe('parseMarkdown', () => {
  it('reads headings, paragraphs and both kinds of list', () => {
    const blocks = parseMarkdown(FIXTURE);
    expect(blocks.map((block) => block.kind)).toEqual([
      'heading',
      'paragraph',
      'heading',
      'list',
      'list',
      'paragraph',
    ]);
    expect(blocks[0]).toEqual({
      kind: 'heading',
      level: 1,
      children: [{ kind: 'text', text: 'How Lance uses your data' }],
    });
  });

  it('joins the lines of one paragraph and one list item', () => {
    const blocks = parseMarkdown(FIXTURE);
    expect(blocks[1]).toEqual({
      kind: 'paragraph',
      children: [
        { kind: 'text', text: 'Lance reads your ' },
        { kind: 'strong', children: [{ kind: 'text', text: 'mail' }] },
        { kind: 'text', text: ' and ' },
        { kind: 'em', children: [{ kind: 'text', text: 'calendar' }] },
        { kind: 'text', text: ' to prepare proposals. It never sends mail.' },
      ],
    });
    const list = blocks[3];
    expect(list?.kind === 'list' ? list.items[1] : null).toEqual([
      { kind: 'text', text: 'Transcripts for 180 days, then removed' },
    ]);
  });

  it('tells a numbered list from a bulleted one', () => {
    const blocks = parseMarkdown(FIXTURE);
    expect(blocks[3]).toMatchObject({ kind: 'list', ordered: false });
    expect(blocks[4]).toMatchObject({ kind: 'list', ordered: true });
  });
});

describe('parseInline', () => {
  it('keeps a mail or web link and inline code', () => {
    expect(parseInline('see [the admins](mailto:a@b.test) or `docs`')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', href: 'mailto:a@b.test', children: [{ kind: 'text', text: 'the admins' }] },
      { kind: 'text', text: ' or ' },
      { kind: 'code', text: 'docs' },
    ]);
  });

  it('drops a link that could run script, keeping its text', () => {
    expect(parseInline('[click](javascript:alert(1))')).toEqual([
      { kind: 'text', text: 'click' },
      { kind: 'text', text: ')' },
    ]);
  });

  it('leaves HTML as text, never markup', () => {
    expect(parseInline('<script>x</script>')).toEqual([
      { kind: 'text', text: '<script>x</script>' },
    ]);
  });
});
