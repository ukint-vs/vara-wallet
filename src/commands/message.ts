import { Command } from 'commander';
import { ProgramMetadata } from '@gear-js/api';
import * as fs from 'fs';
import { getApi } from '../services/api';
import { resolveAccount, AccountOptions } from '../services/account';
import { executeTx, TxEvent } from '../services/tx-executor';
import { validateVoucher } from '../services/voucher-validator';
import { output, verbose, CliError, resolveAmount, minimalToVara, addressToHex, classifyProgramError, resolvePayload, tryHexToText } from '../utils';

/**
 * Extract messageId from transaction events using multi-pattern fallback.
 *
 * Event data from toJSON() can be array or object depending on codec version:
 *   MessageQueued:    array → data[0],          object → data.id
 *   UserMessageSent:  array → data[0].id,       object → data.message?.id
 */
export function extractMessageId(events: TxEvent[]): string | null {
  // Try MessageQueued first (program destinations)
  const mqEvent = events.find(
    (e) => e.section === 'gear' && e.method === 'MessageQueued',
  );
  if (mqEvent?.data != null) {
    const d = mqEvent.data as Record<string, unknown>;
    // Array shape: [messageId, source, destination, entry]
    if (Array.isArray(d)) {
      if (typeof d[0] === 'string') return d[0];
    }
    // Object shape: { id, source, destination, entry }
    if (typeof d.id === 'string') return d.id;
  }

  // Fall back to UserMessageSent (user destinations)
  const umsEvent = events.find(
    (e) => e.section === 'gear' && e.method === 'UserMessageSent',
  );
  if (umsEvent?.data != null) {
    const d = umsEvent.data as Record<string, unknown>;
    // Array shape: [{ id, source, destination, payload, value, details }, expiration]
    if (Array.isArray(d) && d[0] && typeof d[0] === 'object') {
      const msg = d[0] as Record<string, unknown>;
      if (typeof msg.id === 'string') return msg.id;
    }
    // Object shape: { message: { id, ... }, expiration }
    if (d.message && typeof d.message === 'object') {
      const msg = d.message as Record<string, unknown>;
      if (typeof msg.id === 'string') return msg.id;
    }
  }

  return null;
}

export function registerMessageCommand(program: Command): void {
  const message = program.command('message').description('Low-level message operations');

  message
    .command('send')
    .description('Send a message to any on-chain actor (program, user, wallet)')
    .argument('<destination>', 'destination address or program ID (hex or SS58)')
    .option('--payload <payload>', 'message payload (hex 0x... or JSON string)', '0x')
    .option('--payload-ascii <text>', 'message payload as plain text (converted to hex)')
    .option('--gas-limit <gas>', 'gas limit (auto-calculated if not set)')
    .option('--value <value>', 'value to send with message (in VARA)', '0')
    .option('--units <units>', 'amount units: human (default, = VARA) or raw')
    .option('--metadata <path>', 'path to .meta.txt file for encoding')
    .option('--voucher <id>', 'voucher ID to pay for the message')
    .action(async (destination: string, options: {
      payload: string;
      payloadAscii?: string;
      gasLimit?: string;
      value: string;
      units?: string;
      metadata?: string;
      voucher?: string;
    }) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);
      const value = resolveAmount(options.value, options.units);

      let meta: ProgramMetadata | undefined;
      if (options.metadata) {
        const metaHex = fs.readFileSync(options.metadata, 'utf-8').trim();
        meta = ProgramMetadata.from(metaHex);
      }

      const destinationHex = addressToHex(destination);
      const payload = resolvePayload(options.payload, options.payloadAscii);

      // Auto-calculate gas if not provided
      let gasLimit: bigint;
      if (options.gasLimit) {
        gasLimit = BigInt(options.gasLimit);
      } else {
        verbose('Calculating gas...');
        const sourceHex = addressToHex(account.address);
        try {
          const gasInfo = await api.program.calculateGas.handle(
            sourceHex,
            destinationHex,
            payload,
            value,
            true,
            meta,
          );
          gasLimit = gasInfo.min_limit.toBigInt();
          verbose(`Gas limit: ${gasLimit}`);
        } catch (err) {
          // `message send` accepts both program and user-account destinations.
          // For user accounts, calculateGas.handle reports "no program at this
          // destination" via a few different gear-node phrasings depending on
          // spec version: explicit "Program not found" (older paths), or, on
          // current Vara mainnet (spec 11000+), an "entered unreachable code:
          // Failed to get last message from the queue" trap. Both mean the
          // same thing: there is no program to estimate gas against, so we
          // fall back to gasLimit=0 and let the system extrinsic carry the
          // value transfer. For everything else (real program panic, transport
          // error), rethrow with structured info.
          const cli = classifyProgramError(err);
          const rawMsg = err instanceof Error ? err.message : String(err);
          const isMissingProgram =
            cli.meta?.reason === 'not_found' ||
            (cli.meta?.reason === 'unreachable' &&
              /Failed to get last message from the queue/i.test(rawMsg));
          if (isMissingProgram) {
            verbose('Destination is not a program, using gas limit 0');
            gasLimit = 0n;
          } else {
            throw cli;
          }
        }
      }

      if (options.voucher) {
        const sourceHex = addressToHex(account.address);
        await validateVoucher(api, sourceHex, options.voucher, destinationHex);
      }

      verbose(`Sending message to ${destinationHex}`);

      const tx = api.message.send({
        destination: destinationHex,
        payload,
        gasLimit,
        value,
      }, meta);

      const finalTx = options.voucher
        ? api.voucher.call(options.voucher, { SendMessage: tx })
        : tx;

      const result = await executeTx(api, finalTx, account);
      const messageId = extractMessageId(result.events);

      output({
        txHash: result.txHash,
        blockHash: result.blockHash,
        blockNumber: result.blockNumber,
        messageId,
        voucherId: options.voucher ?? null,
        events: result.events,
      });
    });

  message
    .command('reply')
    .description('Send a reply to a message in mailbox')
    .argument('<messageId>', 'message ID to reply to (0x...)')
    .option('--payload <payload>', 'reply payload (hex 0x... or JSON string)', '0x')
    .option('--payload-ascii <text>', 'reply payload as plain text (converted to hex)')
    .option('--gas-limit <gas>', 'gas limit (auto-calculated if not set)')
    .option('--value <value>', 'value to send with reply (in VARA)', '0')
    .option('--units <units>', 'amount units: human (default, = VARA) or raw')
    .option('--metadata <path>', 'path to .meta.txt file for encoding')
    .option('--voucher <id>', 'voucher ID to pay for the message')
    .action(async (messageId: string, options: {
      payload: string;
      payloadAscii?: string;
      gasLimit?: string;
      value: string;
      units?: string;
      metadata?: string;
      voucher?: string;
    }) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);
      const value = resolveAmount(options.value, options.units);

      let meta: ProgramMetadata | undefined;
      if (options.metadata) {
        const metaHex = fs.readFileSync(options.metadata, 'utf-8').trim();
        meta = ProgramMetadata.from(metaHex);
      }

      const payload = resolvePayload(options.payload, options.payloadAscii);

      let gasLimit: bigint;
      if (options.gasLimit) {
        gasLimit = BigInt(options.gasLimit);
      } else {
        verbose('Calculating gas...');
        const sourceHex = addressToHex(account.address);
        try {
          const gasInfo = await api.program.calculateGas.reply(
            sourceHex,
            messageId as `0x${string}`,
            payload,
            value,
            true,
            meta,
          );
          gasLimit = gasInfo.min_limit.toBigInt();
        } catch (err) {
          throw classifyProgramError(err);
        }
        verbose(`Gas limit: ${gasLimit}`);
      }

      if (options.voucher) {
        const sourceHex = addressToHex(account.address);
        // programId omitted: reply destination is resolved on-chain from the original message
        await validateVoucher(api, sourceHex, options.voucher);
      }

      verbose(`Sending reply to ${messageId}`);

      const tx = await api.message.sendReply({
        replyToId: messageId as `0x${string}`,
        payload,
        gasLimit,
        value,
      }, meta);

      const finalTx = options.voucher
        ? api.voucher.call(options.voucher, { SendReply: tx })
        : tx;

      const result = await executeTx(api, finalTx, account);

      output({
        txHash: result.txHash,
        blockHash: result.blockHash,
        blockNumber: result.blockNumber,
        voucherId: options.voucher ?? null,
        events: result.events,
      });
    });

  message
    .command('calculate-reply')
    .description('Calculate reply from a program without sending a transaction')
    .argument('<programId>', 'destination program ID (hex or SS58)')
    .option('--payload <payload>', 'message payload (hex 0x... or JSON string)', '0x')
    .option('--payload-ascii <text>', 'message payload as plain text (converted to hex)')
    .option('--value <value>', 'value to simulate (in VARA)', '0')
    .option('--units <units>', 'amount units: human (default, = VARA) or raw')
    .option('--origin <address>', 'origin address for the calculation (hex or SS58)')
    .option('--at <blockHash>', 'block hash to query state at')
    .action(async (programId: string, options: {
      payload: string;
      payloadAscii?: string;
      value: string;
      units?: string;
      origin?: string;
      at?: string;
    }) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const value = resolveAmount(options.value, options.units);

      // Resolve origin - use provided address or account
      let origin: `0x${string}`;
      if (options.origin) {
        origin = addressToHex(options.origin);
      } else {
        try {
          const account = await resolveAccount(opts);
          origin = addressToHex(account.address);
        } catch {
          throw new CliError(
            'Provide --origin address or configure an account for calculate-reply',
            'NO_ORIGIN',
          );
        }
      }

      const programIdHex = addressToHex(programId);
      const payload = resolvePayload(options.payload, options.payloadAscii);
      verbose(`Calculating reply from ${programIdHex}`);

      const replyInfo = await api.message.calculateReply({
        origin,
        destination: programIdHex,
        payload,
        value,
        at: options.at as `0x${string}` | undefined,
      });

      const replyPayloadHex = replyInfo.payload.toHex();
      const payloadAscii = tryHexToText(replyPayloadHex);

      output({
        payload: replyPayloadHex,
        ...(payloadAscii !== undefined && { payloadAscii }),
        value: minimalToVara(replyInfo.value.toBigInt()),
        valueRaw: replyInfo.value.toString(),
        code: replyInfo.code.toString(),
      });
    });
}
