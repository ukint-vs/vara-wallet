/**
 * Verifies that the lazy parser cache in sails.ts does not permanently
 * wedge on a transient init failure. See recommendation #1 from the PR
 * review for context.
 */

// Count init calls across the whole test file; reset between tests.
let v2InitCalls = 0;
let v2FailOnCall: number | null = null;
let v1NewCalls = 0;
let v1FailOnCall: number | null = null;

jest.mock('sails-js/parser', () => ({
  SailsIdlParser: class {
    async init(): Promise<void> {
      v2InitCalls += 1;
      if (v2FailOnCall !== null && v2InitCalls === v2FailOnCall) {
        throw new Error(`mock v2 init failure (call ${v2InitCalls})`);
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    parse(_idl: string): unknown {
      return { program: { name: 'Noop', ctors: [], services: [], types: [] }, services: [] };
    }
  },
}));

jest.mock('sails-js-parser', () => {
  class MockV1Parser {
    static async new(): Promise<MockV1Parser> {
      v1NewCalls += 1;
      if (v1FailOnCall !== null && v1NewCalls === v1FailOnCall) {
        throw new Error(`mock v1 new failure (call ${v1NewCalls})`);
      }
      return new MockV1Parser();
    }
  }
  return { SailsIdlParser: MockV1Parser };
});

// Stub the Sails class so parseIdl + services don't blow up on the mock
// parser's empty output. We don't exercise v1 parsing behavior here.
jest.mock('sails-js', () => {
  const actual = jest.requireActual<object>('sails-js');
  return {
    ...actual,
    Sails: class {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
      constructor(_parser: any) {}
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      parseIdl(_idl: string): void {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
      setApi(_api: any): void {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
      setProgramId(_id: any): void {}
      services: Record<string, unknown> = {};
      ctors: Record<string, unknown> = {};
    },
    SailsProgram: class {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
      constructor(_doc: any) {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
      setApi(_api: any): void {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
      setProgramId(_id: any): void {}
      services: Record<string, unknown> = {};
      ctors: Record<string, unknown> | null = null;
    },
  };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseIdlFileV1, parseIdlFileV2, _resetParserCache } from '../services/sails';

function writeIdl(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vara-parser-cache-'));
  const filePath = path.join(dir, 'test.idl');
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

describe('parser cache recovers from init failure', () => {
  beforeEach(() => {
    v2InitCalls = 0;
    v2FailOnCall = null;
    v1NewCalls = 0;
    v1FailOnCall = null;
    _resetParserCache();
  });

  it('v2: rejected init() does not poison the cache', async () => {
    const idlPath = writeIdl('!@sails: 1.0.0-beta.1\nservice S@0x00 {}');
    v2FailOnCall = 1;

    // First call: init() throws, parseIdlFileV2 should surface the error.
    await expect(parseIdlFileV2(idlPath)).rejects.toThrow(/mock v2 init failure/);
    expect(v2InitCalls).toBe(1);

    // Second call: init() succeeds, parser should be reinitialized.
    v2FailOnCall = null;
    await expect(parseIdlFileV2(idlPath)).resolves.toBeDefined();
    expect(v2InitCalls).toBe(2);
  });

  it('v2: successful init() is cached and not repeated', async () => {
    const idlPath = writeIdl('!@sails: 1.0.0-beta.1\nservice S@0x00 {}');

    await parseIdlFileV2(idlPath);
    await parseIdlFileV2(idlPath);
    await parseIdlFileV2(idlPath);

    expect(v2InitCalls).toBe(1);
  });

  it('v1: rejected new() does not poison the cache', async () => {
    const idlPath = writeIdl('service S {};');
    v1FailOnCall = 1;

    await expect(parseIdlFileV1(idlPath)).rejects.toThrow(/mock v1 new failure/);
    expect(v1NewCalls).toBe(1);

    v1FailOnCall = null;
    await expect(parseIdlFileV1(idlPath)).resolves.toBeDefined();
    expect(v1NewCalls).toBe(2);
  });

  it('v1: successful new() is cached and not repeated', async () => {
    const idlPath = writeIdl('service S {};');

    await parseIdlFileV1(idlPath);
    await parseIdlFileV1(idlPath);

    expect(v1NewCalls).toBe(1);
  });
});
