import { Command } from 'commander';
import { getApi } from '../services/api';
import { resolveAccount, resolveAddress, AccountOptions } from '../services/account';
import { loadSails } from '../services/sails';
import { output, verbose, CliError, resolveAmount, minimalToVara, addressToHex } from '../utils';

export function registerVftCommand(program: Command): void {
  const vft = program.command('vft').description('VFT (fungible token) operations');

  vft
    .command('balance')
    .description('Query VFT token balance')
    .argument('<tokenProgram>', 'VFT program ID (hex or SS58)')
    .argument('[account]', 'account address to query, hex or SS58 (defaults to configured account)')
    .option('--idl <path>', 'path to local IDL file')
    .action(async (tokenProgram: string, account: string | undefined, options: { idl?: string }) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const tokenProgramHex = addressToHex(tokenProgram);
      const address = await resolveAddress(account, opts);

      const sails = await loadSails(api, { programId: tokenProgramHex, idl: options.idl });

      // Find the VFT service — could be named "Vft", "Service", etc.
      const serviceName = findVftService(sails, 'BalanceOf');

      verbose(`Querying VFT balance for ${address} on ${tokenProgramHex}`);

      const query = sails.services[serviceName].queries['BalanceOf'];
      const result = await query(address).call();

      output({
        tokenProgram: tokenProgramHex,
        account: address,
        balance: String(result),
      });
    });

  vft
    .command('transfer')
    .description('Transfer VFT tokens')
    .argument('<tokenProgram>', 'VFT program ID (hex or SS58)')
    .argument('<to>', 'destination address (hex or SS58)')
    .argument('<amount>', 'amount to transfer')
    .option('--idl <path>', 'path to local IDL file')
    .action(async (tokenProgram: string, to: string, amount: string, options: { idl?: string }) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);
      const toHex = addressToHex(to);

      const sails = await loadSails(api, { programId: addressToHex(tokenProgram), idl: options.idl });
      const serviceName = findVftService(sails, 'Transfer');

      verbose(`Transferring ${amount} tokens to ${toHex}`);

      const func = sails.services[serviceName].functions['Transfer'];
      const txBuilder = func(toHex, BigInt(amount));

      txBuilder.withAccount(account);
      await txBuilder.calculateGas();

      const result = await txBuilder.signAndSend();
      const response = await result.response();

      output({
        txHash: result.txHash,
        blockHash: result.blockHash,
        messageId: result.msgId,
        result: response,
      });
    });

  vft
    .command('approve')
    .description('Approve VFT token spending')
    .argument('<tokenProgram>', 'VFT program ID (hex or SS58)')
    .argument('<spender>', 'spender address (hex or SS58)')
    .argument('<amount>', 'amount to approve')
    .option('--idl <path>', 'path to local IDL file')
    .action(async (tokenProgram: string, spender: string, amount: string, options: { idl?: string }) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);
      const spenderHex = addressToHex(spender);

      const sails = await loadSails(api, { programId: addressToHex(tokenProgram), idl: options.idl });
      const serviceName = findVftService(sails, 'Approve');

      verbose(`Approving ${amount} tokens for ${spenderHex}`);

      const func = sails.services[serviceName].functions['Approve'];
      const txBuilder = func(spenderHex, BigInt(amount));

      txBuilder.withAccount(account);
      await txBuilder.calculateGas();

      const result = await txBuilder.signAndSend();
      const response = await result.response();

      output({
        txHash: result.txHash,
        blockHash: result.blockHash,
        messageId: result.msgId,
        result: response,
      });
    });
}

/**
 * Find the VFT service that contains the given method.
 * VFT programs may name their service differently (Vft, Service, Token, etc.)
 */
function findVftService(sails: import('sails-js').Sails, methodName: string): string {
  for (const [serviceName, service] of Object.entries(sails.services)) {
    if (methodName in service.queries || methodName in service.functions) {
      return serviceName;
    }
  }

  const available = Object.keys(sails.services).join(', ');
  throw new CliError(
    `No service with method "${methodName}" found. Available services: ${available}`,
    'VFT_SERVICE_NOT_FOUND',
  );
}
