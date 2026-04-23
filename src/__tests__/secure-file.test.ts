import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { writeUserFile, writeUserFileAtomic } from '../utils/secure-file';

const testDir = path.join(os.tmpdir(), `vara-secure-file-test-${Date.now()}-${process.pid}`);

afterAll(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

function mode(p: string): string {
  return (fs.statSync(p).mode & 0o777).toString(8);
}

describe('writeUserFile', () => {
  it('creates parent directory with mode 0700 when missing', () => {
    const dir = path.join(testDir, 'writeUserFile-a');
    const file = path.join(dir, 'x.txt');
    expect(fs.existsSync(dir)).toBe(false);

    writeUserFile(file, 'hello');

    expect(fs.existsSync(dir)).toBe(true);
    expect(mode(dir)).toBe('700');
  });

  it('writes the file with mode 0600', () => {
    const file = path.join(testDir, 'writeUserFile-b', 'y.txt');
    writeUserFile(file, 'data');
    expect(mode(file)).toBe('600');
    expect(fs.readFileSync(file, 'utf-8')).toBe('data');
  });

  it('reuses existing directory without re-creating', () => {
    const dir = path.join(testDir, 'writeUserFile-c');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const before = fs.statSync(dir).mtimeMs;

    writeUserFile(path.join(dir, 'z.txt'), 'data');

    // Directory still present, permissions intact
    expect(fs.existsSync(dir)).toBe(true);
    expect(mode(dir)).toBe('700');
    // mtimeMs may update because we wrote a new entry; we just verify the dir wasn't removed.
    expect(fs.statSync(dir).mtimeMs).toBeGreaterThanOrEqual(before);
  });

  it('accepts Buffer content', () => {
    const file = path.join(testDir, 'writeUserFile-d', 'bin.bin');
    const buf = Buffer.from([0x00, 0xff, 0x42]);
    writeUserFile(file, buf);
    expect(Buffer.compare(fs.readFileSync(file), buf)).toBe(0);
  });
});

describe('writeUserFileAtomic', () => {
  // The tmp sibling uses `.<pid>.tmp` to avoid races between concurrent
  // writers targeting the same file. Assert no `*.tmp` sibling is left behind
  // after a successful write, regardless of pid.
  function tmpSiblings(filePath: string): string[] {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.startsWith(base + '.') && f.endsWith('.tmp'));
  }

  it('ends with final file at mode 0600 and no .tmp sibling leftover', () => {
    const file = path.join(testDir, 'atomic-a', 'x.json');
    writeUserFileAtomic(file, '{"ok":true}');

    expect(fs.existsSync(file)).toBe(true);
    expect(tmpSiblings(file)).toEqual([]);
    expect(mode(file)).toBe('600');
  });

  it('creates parent directory with mode 0700 when missing', () => {
    const dir = path.join(testDir, 'atomic-b');
    const file = path.join(dir, 'x.json');
    expect(fs.existsSync(dir)).toBe(false);

    writeUserFileAtomic(file, 'data');

    expect(mode(dir)).toBe('700');
  });

  it('replaces existing file on overwrite', () => {
    const file = path.join(testDir, 'atomic-c', 'x.json');
    writeUserFileAtomic(file, 'first');
    writeUserFileAtomic(file, 'second');

    expect(fs.readFileSync(file, 'utf-8')).toBe('second');
    expect(tmpSiblings(file)).toEqual([]);
  });

  it('ensures every ancestor created by the call is 0700 (not just the leaf)', () => {
    // Exercise the regression fix: mkdir recursive with mode only chmods the
    // leaf. The secure-file helper walks ancestors and chmods each one.
    const grandparent = path.join(testDir, 'atomic-d');
    const parent = path.join(grandparent, 'sub');
    const file = path.join(parent, 'x.json');

    writeUserFileAtomic(file, 'data');

    expect(mode(grandparent)).toBe('700');
    expect(mode(parent)).toBe('700');
    expect(mode(file)).toBe('600');
  });
});
