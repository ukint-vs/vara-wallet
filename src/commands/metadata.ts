import { Command } from 'commander';
import { output } from '../utils';
import {
  listMetadataCache,
  clearMetadataCache,
  getMetadataCacheDir,
} from '../services/metadata-cache';

/**
 * `vara-wallet metadata <list|clear>`
 *
 * Operational parity with `vara-wallet idl <list|remove|clear>`. The
 * runtime metadata cache lives at `~/.vara-wallet/metadata-cache/` and
 * is auto-managed (load on connect, save if missing, prune to N=3 most
 * recent per chain). These subcommands let users inspect and reset it
 * without poking at files directly.
 */
export function registerMetadataCommand(program: Command): void {
  const metadata = program
    .command('metadata')
    .description('Runtime metadata cache management');

  metadata
    .command('list')
    .description('List cached runtime metadata entries')
    .action(() => {
      output(listMetadataCache());
    });

  metadata
    .command('clear')
    .description('Remove all cached runtime metadata entries')
    .action(() => {
      const result = clearMetadataCache();
      output({ ...result, cacheDir: getMetadataCacheDir() });
    });
}
