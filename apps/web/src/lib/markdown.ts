/**
 * A small Markdown reader for documents the repository ships, such as the
 * data-processing notice onboarding shows (docs/plans/multi-user.md M3).
 * It covers what those documents use: headings, paragraphs, bulleted and
 * numbered lists, bold, italics, inline code and links. The result is data
 * the page renders as React elements, so no HTML from the document is ever
 * injected into the page. No package is added for this (Valliance
 * minimal-dependencies rule).
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: Inline[] };

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] };

const HEADING = /^(#{1,4})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

/** Only links a reader can follow safely: web, mail and in-app paths. */
const SAFE_HREF = /^(https?:\/\/|mailto:|\/(?!\/))/i;

/** Parses bold, italics, code and links inside one block's text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buffer = '';
  const flush = (): void => {
    if (buffer !== '') out.push({ kind: 'text', text: buffer });
    buffer = '';
  };
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const code = /^`([^`]+)`/.exec(rest);
    if (code !== null) {
      flush();
      out.push({ kind: 'code', text: code[1] ?? '' });
      index += code[0].length;
      continue;
    }
    const strong = /^(\*\*|__)(.+?)\1/.exec(rest);
    if (strong !== null) {
      flush();
      out.push({ kind: 'strong', children: parseInline(strong[2] ?? '') });
      index += strong[0].length;
      continue;
    }
    const em = /^(\*|_)(?!\s)(.+?)(?<!\s)\1/.exec(rest);
    if (em !== null) {
      flush();
      out.push({ kind: 'em', children: parseInline(em[2] ?? '') });
      index += em[0].length;
      continue;
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link !== null) {
      flush();
      const href = link[2] ?? '';
      const children = parseInline(link[1] ?? '');
      if (SAFE_HREF.test(href)) out.push({ kind: 'link', href, children });
      else out.push(...children);
      index += link[0].length;
      continue;
    }
    buffer += text[index] ?? '';
    index += 1;
  }
  flush();
  return out;
}

/** Splits a document into blocks. Lines in one paragraph are joined with a space. */
export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const endParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join(' ')) });
    }
    paragraph = [];
  };
  const endList = (): void => {
    if (list !== null) {
      blocks.push({
        kind: 'list',
        ordered: list.ordered,
        items: list.items.map((item) => parseInline(item)),
      });
    }
    list = null;
  };

  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      endParagraph();
      endList();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      endParagraph();
      endList();
      const level = Math.min(heading[1]?.length ?? 1, 4) as 1 | 2 | 3 | 4;
      blocks.push({ kind: 'heading', level, children: parseInline(heading[2]?.trim() ?? '') });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet === null ? NUMBERED.exec(line) : null;
    const item = bullet ?? numbered;
    if (item !== null) {
      endParagraph();
      const ordered = numbered !== null;
      if (list !== null && list.ordered !== ordered) endList();
      list ??= { ordered, items: [] };
      list.items.push(item[1] ?? '');
      continue;
    }
    if (list !== null && /^\s+/.test(raw)) {
      // An indented line continues the list item above it.
      const items = list.items;
      items[items.length - 1] = `${items[items.length - 1] ?? ''} ${line.trim()}`;
      continue;
    }
    endList();
    paragraph.push(line.trim());
  }
  endParagraph();
  endList();
  return blocks;
}
