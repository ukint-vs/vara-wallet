import { Command } from 'commander';
import { getApi } from '../services/api';
import { loadSails, describeSailsProgram } from '../services/sails';
import { output, verbose, addressToHex } from '../utils';

export function registerDiscoverCommand(program: Command): void {
  program
    .command('discover')
    .description('Discover program services, methods, and types via Sails IDL')
    .argument('<programId>', 'program ID (hex or SS58)')
    .option('--idl <path>', 'path to local IDL file')
    .action(async (programId: string, options: { idl?: string }) => {
      const opts = program.optsWithGlobals() as { ws?: string };
      const api = await getApi(opts.ws);

      const programIdHex = addressToHex(programId);
      verbose(`Discovering program ${programIdHex}`);

      const sails = await loadSails(api, { programId: programIdHex, idl: options.idl });
      const description = describeSailsProgram(sails);

      output({
        programId: programIdHex,
        services: description,
      });
    });
}
