import { extractMessageId } from '../message';
import type { TxEvent } from '../../services/tx-executor';

describe('extractMessageId', () => {
  describe('MessageQueued event', () => {
    it('extracts from array shape: [messageId, source, destination, entry]', () => {
      const events: TxEvent[] = [
        { section: 'system', method: 'ExtrinsicSuccess', data: {} },
        {
          section: 'gear',
          method: 'MessageQueued',
          data: ['0xabc123', '0xsource', '0xdest', 'Init'],
        },
      ];
      expect(extractMessageId(events)).toBe('0xabc123');
    });

    it('extracts from object shape: { id, source, destination, entry }', () => {
      const events: TxEvent[] = [
        {
          section: 'gear',
          method: 'MessageQueued',
          data: { id: '0xabc123', source: '0xsource', destination: '0xdest', entry: 'Init' },
        },
      ];
      expect(extractMessageId(events)).toBe('0xabc123');
    });
  });

  describe('UserMessageSent event (fallback)', () => {
    it('extracts from array shape: [{ id, ... }, expiration]', () => {
      const events: TxEvent[] = [
        { section: 'system', method: 'ExtrinsicSuccess', data: {} },
        {
          section: 'gear',
          method: 'UserMessageSent',
          data: [
            {
              id: '0xmsg456',
              source: '0xsource',
              destination: '0xdest',
              payload: '0x00',
              value: 0,
              details: null,
            },
            null,
          ],
        },
      ];
      expect(extractMessageId(events)).toBe('0xmsg456');
    });

    it('extracts from object shape: { message: { id, ... }, expiration }', () => {
      const events: TxEvent[] = [
        {
          section: 'gear',
          method: 'UserMessageSent',
          data: {
            message: {
              id: '0xmsg456',
              source: '0xsource',
              destination: '0xdest',
              payload: '0x00',
              value: 0,
              details: null,
            },
            expiration: null,
          },
        },
      ];
      expect(extractMessageId(events)).toBe('0xmsg456');
    });
  });

  it('prefers MessageQueued over UserMessageSent', () => {
    const events: TxEvent[] = [
      {
        section: 'gear',
        method: 'MessageQueued',
        data: ['0xfromMQ', '0xsource', '0xdest', 'Handle'],
      },
      {
        section: 'gear',
        method: 'UserMessageSent',
        data: [{ id: '0xfromUMS', source: '0x', destination: '0x', payload: '0x', value: 0, details: null }, null],
      },
    ];
    expect(extractMessageId(events)).toBe('0xfromMQ');
  });

  it('returns null when neither event is present', () => {
    const events: TxEvent[] = [
      { section: 'system', method: 'ExtrinsicSuccess', data: {} },
      { section: 'balances', method: 'Transfer', data: ['0xa', '0xb', 1000] },
    ];
    expect(extractMessageId(events)).toBeNull();
  });

  it('returns null for empty events array', () => {
    expect(extractMessageId([])).toBeNull();
  });

  it('returns null when event data has unexpected shape', () => {
    const events: TxEvent[] = [
      {
        section: 'gear',
        method: 'MessageQueued',
        data: 'unexpected_string',
      },
    ];
    expect(extractMessageId(events)).toBeNull();
  });
});
