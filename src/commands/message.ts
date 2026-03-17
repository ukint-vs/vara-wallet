import { Command } from 'commander';
import { ProgramMetadata } from '@gear-js/api';
import { decodeAddress } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';
import * as fs from 'fs';
import { getApi } from '../services/api';
import { resolveAccount, AccountOptions } from '../services/account';
import { executeTx } from '../services/tx-executor';
import { output, verbose, CliError, resolveAmount, minimalToVara } from '../utils';

export function registerMessageCommand(program: Command): void {
  const message = program.command('message').description('Low-level message operations');

  message
    .command('send')
    .description('Send a message to a program')
    .argument('<programId>', 'destination program ID (0x...)')
    .option('--payload <payload>', 'message payload (hex 0x... or JSON string)', '0x')
    .option('--gas-limit <gas>', 'gas limit (auto-calculated if not set)')
    .option('--value <value>', 'value to send with message (in VARA)', '0')
    .option('--units <units>', 'amount units: vara (default) or raw')
    .option('--metadata <path>', 'path to .meta.txt file for encoding')
    .action(async (programId: string, options: {
      payload: string;
      gasLimit?: string;
      value: string;
      units?: string;
      metadata?: string;
    }) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);
      const isRaw = options.units === 'raw';
      const value = resolveAmount(options.value, isRaw);

      let meta: ProgramMetadata | undefined;
      if (options.metadata) {
        const metaHex = fs.readFileSync(options.metadata, 'utf-8').trim();
        meta = ProgramMetadata.from(metaHex);
      }

      const payload = options.payload;

      // Auto-calculate gas if not provided
      let gasLimit: bigint;
      if (options.gasLimit) {
        gasLimit = BigInt(options.gasLimit);
      } else {
        verbose('Calculating gas...');
        const sourceHex = u8aToHex(decodeAddress(account.address));
        const gasInfo = await api.program.calculateGas.handle(
          sourceHex as `0x${string}`,
          programId as `0x${string}`,
          payload,
          value,
          true,
          meta,
        );
        gasLimit = gasInfo.min_limit.toBigInt();
        verbose(`Gas limit: ${gasLimit}`);

        if (gasLimit === 0n) {
          const blockGasLimit = api.blockGasLimit.toBigInt();
          verbose(`Gas calc returned 0, using block gas limit: ${blockGasLimit}`);
          gasLimit = blockGasLimit;
        }
      }

      verbose(`Sending message to ${programId}`);

      const tx = api.message.send({
        destination: programId as `0x${string}`,
        payload,
        gasLimit,
        value,
      }, meta);

      const result = await executeTx(api, tx, account);

      // Extract message ID from MessageQueued event
      // Event data is an array: [messageId, source, destination, entry]
      const mqEvent = result.events.find(
        (e) => e.section === 'gear' && e.method === 'MessageQueued',
      );
      const mqData = mqEvent?.data;
      const messageId = Array.isArray(mqData) ? mqData[0] : undefined;

      output({
        txHash: result.txHash,
        blockHash: result.blockHash,
        messageId: messageId || null,
        events: result.events,
      });
    });

  message
    .command('reply')
    .description('Send a reply to a message in mailbox')
    .argument('<messageId>', 'message ID to reply to (0x...)')
    .option('--payload <payload>', 'reply payload (hex 0x... or JSON string)', '0x')
    .option('--gas-limit <gas>', 'gas limit (auto-calculated if not set)')
    .option('--value <value>', 'value to send with reply (in VARA)', '0')
    .option('--units <units>', 'amount units: vara (default) or raw')
    .option('--metadata <path>', 'path to .meta.txt file for encoding')
    .action(async (messageId: string, options: {
      payload: string;
      gasLimit?: string;
      value: string;
      units?: string;
      metadata?: string;
    }) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);
      const isRaw = options.units === 'raw';
      const value = resolveAmount(options.value, isRaw);

      let meta: ProgramMetadata | undefined;
      if (options.metadata) {
        const metaHex = fs.readFileSync(options.metadata, 'utf-8').trim();
        meta = ProgramMetadata.from(metaHex);
      }

      const payload = options.payload;

      let gasLimit: bigint;
      if (options.gasLimit) {
        gasLimit = BigInt(options.gasLimit);
      } else {
        verbose('Calculating gas...');
        const sourceHex = u8aToHex(decodeAddress(account.address));
        const gasInfo = await api.program.calculateGas.reply(
          sourceHex as `0x${string}`,
          messageId as `0x${string}`,
          payload,
          value,
          true,
          meta,
        );
        gasLimit = gasInfo.min_limit.toBigInt();
        verbose(`Gas limit: ${gasLimit}`);
      }

      verbose(`Sending reply to ${messageId}`);

      const tx = await api.message.sendReply({
        replyToId: messageId as `0x${string}`,
        payload,
        gasLimit,
        value,
      }, meta);

      const result = await executeTx(api, tx, account);

      output({
        txHash: result.txHash,
        blockHash: result.blockHash,
        events: result.events,
      });
    });

  message
    .command('calculate-reply')
    .description('Calculate reply from a program without sending a transaction')
    .argument('<programId>', 'destination program ID (0x...)')
    .option('--payload <payload>', 'message payload (hex 0x... or JSON string)', '0x')
    .option('--value <value>', 'value to simulate (in VARA)', '0')
    .option('--units <units>', 'amount units: vara (default) or raw')
    .option('--origin <address>', 'origin address for the calculation')
    .option('--at <blockHash>', 'block hash to query state at')
    .action(async (programId: string, options: {
      payload: string;
      value: string;
      units?: string;
      origin?: string;
      at?: string;
    }) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const isRaw = options.units === 'raw';
      const value = resolveAmount(options.value, isRaw);

      // Resolve origin - use provided address or account
      let origin: string;
      if (options.origin) {
        origin = options.origin;
      } else {
        try {
          const account = await resolveAccount(opts);
          origin = account.address;
        } catch {
          throw new CliError(
            'Provide --origin address or configure an account for calculate-reply',
            'NO_ORIGIN',
          );
        }
      }

      verbose(`Calculating reply from ${programId}`);

      const replyInfo = await api.message.calculateReply({
        origin,
        destination: programId,
        payload: options.payload,
        value,
        at: options.at as `0x${string}` | undefined,
      });

      output({
        payload: replyInfo.payload.toHex(),
        value: minimalToVara(replyInfo.value.toBigInt()),
        valueRaw: replyInfo.value.toString(),
        code: replyInfo.code.toString(),
      });
    });
}
