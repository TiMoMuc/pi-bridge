import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const blueprintScript = path.join(
  repoRoot,
  '__blueprint__/.agent/skills/session-log-parser/parse-session.py',
);
const blueprintDoc = path.join(
  repoRoot,
  '__blueprint__/.agent/skills/session-log-parser/SKILL.md',
);

const tempDirs: string[] = [];

function makeSessionFile(lines: object[]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-log-parser-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'sample.jsonl');
  writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n'));
  return file;
}

function runParser(file: string, ...args: string[]) {
  return execFileSync('python3', [blueprintScript, file, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('session-log-parser blueprint skill', () => {
  it('renders a causal focus view for assistant/tool chronology', () => {
    const file = makeSessionFile([
      { type: 'session', id: 's1', timestamp: '2026-05-06T10:00:00.000Z', cwd: '/workspace' },
      { type: 'model_change', provider: 'github-copilot', modelId: 'gpt-5.4', timestamp: '2026-05-06T10:00:00.000Z' },
      { type: 'message', timestamp: '2026-05-06T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Findest du Maße im Bild?' }] } },
      {
        type: 'message',
        timestamp: '2026-05-06T10:00:02.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Ich öffne das Bild und prüfe die sichtbaren Maße.' },
            { type: 'toolCall', name: 'read', arguments: { path: '/workspace/2.png' } },
          ],
        },
      },
      {
        type: 'message',
        timestamp: '2026-05-06T10:00:03.000Z',
        message: {
          role: 'toolResult',
          toolName: 'read',
          content: [{ type: 'text', text: 'data:image/png;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }],
        },
      },
      {
        type: 'message',
        timestamp: '2026-05-06T10:00:04.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Ich sehe Maße, bin aber bei der Zuordnung noch unsicher.' }] },
      },
    ]);

    const output = runParser(file, '--around', '2', '--window', '1');

    expect(output).toContain('[1] USER');
    expect(output).toContain('[2] ASSIST');
    expect(output).toContain('(Thinking) Ich öffne das Bild und prüfe die sichtbaren Maße.');
    expect(output).toContain('(ToolCall: read) args: {"path":"/workspace/2.png"}');
    expect(output).toContain('[3] TOOL');
    expect(output).not.toContain('[4] ASSIST');
  });

  it('folds noisy payloads by default instead of dumping them raw', () => {
    const file = makeSessionFile([
      { type: 'session', id: 's2', timestamp: '2026-05-06T10:00:00.000Z', cwd: '/workspace' },
      { type: 'message', timestamp: '2026-05-06T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'show me the tool result' }] } },
      {
        type: 'message',
        timestamp: '2026-05-06T10:00:02.000Z',
        message: {
          role: 'toolResult',
          toolName: 'read',
          content: [{ type: 'text', text: 'data:image/png;base64,BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' }],
        },
      },
    ]);

    const output = runParser(file);

    expect(output).toContain('OMITTED: data-uri payload');
    expect(output).not.toContain('base64,BBBBBBBB');
  });

  it('ships a valid bundled skill description in the blueprint', () => {
    const doc = readFileSync(blueprintDoc, 'utf8');

    expect(doc).toContain('name: session-log-parser');
    expect(doc).toContain('description:');
    expect(doc).toContain('python parse-session.py');
  });
});
