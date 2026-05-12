type SignalTextStyleKind = "BOLD" | "ITALIC" | "STRIKETHROUGH" | "MONOSPACE";

export interface SignalTextStyle {
  start: number;
  length: number;
  style: SignalTextStyleKind;
}

export interface FormattedMessage {
  text: string;
  textStyles: SignalTextStyle[];
}

export function serializeStyle(style: SignalTextStyle): string {
  return `${style.start}:${style.length}:${style.style}`;
}

export function markdownToSignal(markdown: string): FormattedMessage {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const output: string[] = [];
  const styles: SignalTextStyle[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (isFence(line)) {
      const blockLines: string[] = [];
      i += 1;
      while (i < lines.length && !isFence(lines[i])) {
        blockLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length && isFence(lines[i])) {
        i += 1;
      }

      const blockText = blockLines.join("\n");
      const start = output.join("").length;
      output.push(blockText);
      if (blockText.length > 0) {
        styles.push({ start, length: blockText.length, style: "MONOSPACE" });
      }
      if (i < lines.length) output.push("\n");
      continue;
    }

    const lineStart = output.join("").length;
    const rendered = renderLine(line);
    output.push(rendered.text);
    for (const style of rendered.textStyles) {
      styles.push({
        start: lineStart + style.start,
        length: style.length,
        style: style.style,
      });
    }
    if (rendered.lineStyle) {
      styles.push({
        start: lineStart,
        length: rendered.text.length,
        style: rendered.lineStyle,
      });
    }

    i += 1;
    if (i < lines.length) output.push("\n");
  }

  return { text: output.join(""), textStyles: styles.filter((style) => style.length > 0) };
}

interface RenderedLine extends FormattedMessage {
  lineStyle?: SignalTextStyleKind;
}

function renderLine(line: string): RenderedLine {
  const heading = line.match(/^(#{1,6})\s+(.*)$/);
  if (heading) {
    const inline = renderInline(heading[2]);
    return { ...inline, lineStyle: "BOLD" };
  }

  const list = line.match(/^(\s*)[-*]\s+(.*)$/);
  if (list) {
    const prefix = `${list[1]}• `;
    const inline = renderInline(list[2]);
    return {
      text: prefix + inline.text,
      textStyles: inline.textStyles.map((style) => ({
        ...style,
        start: style.start + prefix.length,
      })),
    };
  }

  return renderInline(line);
}

function renderInline(input: string): FormattedMessage {
  let i = 0;
  let text = "";
  const styles: SignalTextStyle[] = [];

  while (i < input.length) {
    const link = parseLink(input, i);
    if (link) {
      const renderedLabel = renderInline(link.label);
      const linkText = normalizeLinkText(renderedLabel.text, link.url);
      const start = text.length;
      text += linkText;
      for (const style of renderedLabel.textStyles) {
        styles.push({ ...style, start: start + style.start });
      }
      i = link.nextIndex;
      continue;
    }

    const segment =
      parseStyledSegment(input, i, "`", "MONOSPACE", false) ??
      parseStyledSegment(input, i, "**", "BOLD") ??
      parseStyledSegment(input, i, "__", "ITALIC") ??
      parseStyledSegment(input, i, "~~", "STRIKETHROUGH") ??
      parseStyledSegment(input, i, "*", "BOLD") ??
      parseStyledSegment(input, i, "_", "ITALIC");

    if (segment) {
      const start = text.length;
      text += segment.text;
      styles.push({ start, length: segment.text.length, style: segment.style });
      for (const style of segment.textStyles) {
        styles.push({ ...style, start: start + style.start });
      }
      i = segment.nextIndex;
      continue;
    }

    text += input[i];
    i += 1;
  }

  return { text, textStyles: styles.filter((style) => style.length > 0) };
}

function parseStyledSegment(
  input: string,
  start: number,
  marker: string,
  style: SignalTextStyleKind,
  recursive = true,
): { text: string; textStyles: SignalTextStyle[]; style: SignalTextStyleKind; nextIndex: number } | null {
  if (!input.startsWith(marker, start)) return null;

  const contentStart = start + marker.length;
  const end = input.indexOf(marker, contentStart);
  if (end === -1) return null;

  const content = input.slice(contentStart, end);
  if (!content) return null;

  const rendered = recursive ? renderInline(content) : { text: content, textStyles: [] };
  return {
    text: rendered.text,
    textStyles: rendered.textStyles,
    style,
    nextIndex: end + marker.length,
  };
}

function parseLink(
  input: string,
  start: number,
): { label: string; url: string; nextIndex: number } | null {
  if (input[start] !== "[") return null;

  const labelEnd = input.indexOf("]", start + 1);
  if (labelEnd === -1 || input[labelEnd + 1] !== "(") return null;

  const urlEnd = input.indexOf(")", labelEnd + 2);
  if (urlEnd === -1) return null;

  return {
    label: input.slice(start + 1, labelEnd),
    url: input.slice(labelEnd + 2, urlEnd),
    nextIndex: urlEnd + 1,
  };
}

function normalizeLinkText(label: string, url: string): string {
  return normalizeUrlish(label) === normalizeUrlish(url) ? label : `${label} (${url})`;
}

function normalizeUrlish(value: string): string {
  return value.trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function isFence(line: string): boolean {
  return /^\s*```/.test(line);
}
