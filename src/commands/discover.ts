import { Command } from 'commander';
import { getApi } from '../services/api';
import { loadSails, describeSailsProgram } from '../services/sails';
import { output, verbose } from '../utils';

export function registerDiscoverCommand(program: Command): void {
  program
    .command('discover')
    .description('Discover program services, methods, and types via Sails IDL')
    .argument('<programId>', 'program ID (0x...)')
    .option('--idl <path>', 'path to local IDL file')
    .action(async (programId: string, options: { idl?: string }) => {
      const opts = program.optsWithGlobals() as { ws?: string };
      const api = await getApi(opts.ws);

      verbose(`Discovering program ${programId}`);

      const sails = await loadSails(api, { programId, idl: options.idl });
      const description = describeSailsProgram(sails);

      output({
        programId,
        services: description,
      });
    });
}
