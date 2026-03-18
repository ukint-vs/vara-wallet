import type { UserMessageSent } from '@gear-js/api';
import {
  validateEventName,
  validateFromBlock,
  createEventCounter,
  parseDuration,
  formatUserMessageSent,
  emitSystemEvent,
  emitAndPersist,
  safeCallback,
} from '../shared';
import { CliError } from '../../../utils';

// Mock outputNdjson to capture output
const mockOutputNdjson = jest.fn();
jest.mock('../../../utils', () => {
  const actual = jest.requireActual('../../../utils');
  return {
    ...actual,
    outputNdjson: (...args: unknown[]) => mockOutputNdjson(...args),
    verbose: jest.fn(),
  };
});

// Mock insertEvent
const mockInsertEvent = jest.fn();
jest.mock('../../../services/event-store', () => ({
  insertEvent: (...args: unknown[]) => mockInsertEvent(...args),
}));

beforeEach(() => {
  mockOutputNdjson.mockClear();
  mockInsertEvent.mockClear();
});

describe('validateEventName', () => {
  it('accepts valid gear event names', () => {
    expect(validateEventName('UserMessageSent')).toBe('UserMessageSent');
    expect(validateEventName('MessageQueued')).toBe('MessageQueued');
    expect(validateEventName('ProgramChanged')).toBe('ProgramChanged');
  });

  it('rejects invalid event names', () => {
    expect(() => validateEventName('FakeEvent')).toThrow(CliError);
    expect(() => validateEventName('')).toThrow(CliError);
  });
});

describe('validateFromBlock', () => {
  it('accepts valid block numbers', () => {
    expect(validateFromBlock('0')).toBe(0);
    expect(validateFromBlock('100')).toBe(100);
    expect(validateFromBlock('999999')).toBe(999999);
  });

  it('rejects invalid values', () => {
    expect(() => validateFromBlock('-1')).toThrow(CliError);
    expect(() => validateFromBlock('abc')).toThrow(CliError);
    expect(() => validateFromBlock('')).toThrow(CliError);
  });
});

describe('createEventCounter', () => {
  it('returns false when no limit is set', () => {
    const counter = createEventCounter(undefined);
    expect(counter.increment()).toBe(false);
    expect(counter.increment()).toBe(false);
    expect(counter.increment()).toBe(false);
  });

  it('returns true when limit is reached', () => {
    const counter = createEventCounter(3);
    expect(counter.increment()).toBe(false);
    expect(counter.increment()).toBe(false);
    expect(counter.increment()).toBe(true); // 3rd event hits limit
  });

  it('handles limit of 1', () => {
    const counter = createEventCounter(1);
    expect(counter.increment()).toBe(true);
  });
});

describe('parseDuration', () => {
  it('parses seconds', () => {
    expect(parseDuration('30s')).toBe(30000);
  });

  it('parses minutes', () => {
    expect(parseDuration('5m')).toBe(300000);
  });

  it('parses hours', () => {
    expect(parseDuration('1h')).toBe(3600000);
  });

  it('parses days', () => {
    expect(parseDuration('7d')).toBe(604800000);
  });

  it('rejects invalid formats', () => {
    expect(() => parseDuration('abc')).toThrow(CliError);
    expect(() => parseDuration('10')).toThrow(CliError);
    expect(() => parseDuration('10x')).toThrow(CliError);
    expect(() => parseDuration('')).toThrow(CliError);
  });
});

describe('emitSystemEvent', () => {
  it('outputs system event as NDJSON', () => {
    const before = Date.now();
    emitSystemEvent('subscribed', { subscription: 'blocks' });
    const after = Date.now();

    expect(mockOutputNdjson).toHaveBeenCalledTimes(1);
    const arg = mockOutputNdjson.mock.calls[0][0];
    expect(arg.type).toBe('system');
    expect(arg.event).toBe('subscribed');
    expect(arg.subscription).toBe('blocks');
    expect(arg.timestamp).toBeGreaterThanOrEqual(before);
    expect(arg.timestamp).toBeLessThanOrEqual(after);
  });
});

describe('emitAndPersist', () => {
  it('outputs NDJSON and persists when persist=true', () => {
    const data = { type: 'block', number: 1 };
    const eventInsert = { type: 'block', data };

    emitAndPersist(data, true, eventInsert);

    expect(mockOutputNdjson).toHaveBeenCalledWith(data);
    expect(mockInsertEvent).toHaveBeenCalledWith(eventInsert);
  });

  it('outputs NDJSON but skips persist when persist=false', () => {
    const data = { type: 'block', number: 1 };

    emitAndPersist(data, false, { type: 'block', data });

    expect(mockOutputNdjson).toHaveBeenCalledWith(data);
    expect(mockInsertEvent).not.toHaveBeenCalled();
  });
});

describe('safeCallback', () => {
  it('calls the wrapped function normally', () => {
    const fn = jest.fn();
    const safe = safeCallback(fn);
    safe('test');
    expect(fn).toHaveBeenCalledWith('test');
  });

  it('catches errors without rethrowing', () => {
    const fn = jest.fn(() => {
      throw new Error('boom');
    });
    const safe = safeCallback(fn);
    expect(() => safe('test')).not.toThrow();
  });
});

describe('formatUserMessageSent', () => {
  it('extracts fields from event data', () => {
    const mockEvent = {
      data: {
        message: {
          id: { toHex: () => '0xabc' },
          source: { toHex: () => '0x111' },
          destination: { toHex: () => '0x222' },
          payload: { toHex: () => '0xdeadbeef' },
          value: { toString: () => '1000' },
          details: { isSome: false },
        },
      },
    };

    const result = formatUserMessageSent(mockEvent as unknown as UserMessageSent);
    expect(result).toEqual({
      messageId: '0xabc',
      source: '0x111',
      destination: '0x222',
      payload: '0xdeadbeef',
      value: '1000',
      details: null,
    });
  });

  it('extracts reply details when present', () => {
    const mockEvent = {
      data: {
        message: {
          id: { toHex: () => '0xabc' },
          source: { toHex: () => '0x111' },
          destination: { toHex: () => '0x222' },
          payload: { toHex: () => '0x00' },
          value: { toString: () => '0' },
          details: {
            isSome: true,
            unwrap: () => ({
              to: { toHex: () => '0xreply' },
              code: { toString: () => 'Success' },
            }),
          },
        },
      },
    };

    const result = formatUserMessageSent(mockEvent as unknown as UserMessageSent);
    expect(result.details).toEqual({
      replyTo: '0xreply',
      code: 'Success',
    });
  });
});
