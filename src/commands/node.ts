import { Command } from 'commander';
import { getApi } from '../services/api';
import { output, verbose, minimalToVara } from '../utils';

export function registerNodeCommand(program: Command): void {
  const node = program.command('node').description('Node information');

  node
    .command('info')
    .description('Display connected node information')
    .action(async () => {
      const opts = program.optsWithGlobals() as { ws?: string };
      const api = await getApi(opts.ws);

      verbose('Fetching node info');

      const [chain, nodeName, nodeVersion] = await Promise.all([
        api.runtimeChain,
        api.runtimeVersion,
        api.runtimeVersion,
      ]);

      const existentialDeposit = api.existentialDeposit.toBigInt();

      output({
        chain: chain.toString(),
        name: nodeName.specName.toString(),
        version: nodeVersion.specVersion.toNumber(),
        specVersion: api.specVersion,
        existentialDeposit: minimalToVara(existentialDeposit),
        existentialDepositRaw: existentialDeposit.toString(),
      });
    });
}
