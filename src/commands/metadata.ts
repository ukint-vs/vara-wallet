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

  // terraform-style: bare invocation previews; --yes commits. Mirrors `idl clear`.
  metadata
    .command('clear')
    .description('Remove all cached runtime metadata entries (terraform-style: bare invocation previews; --yes commits)')
    .option('--yes', 'actually remove the entries (without --yes, only previews what would be removed)')
    .action((options: { yes?: boolean }) => {
      const cacheDir = getMetadataCacheDir();
      if (!options.yes) {
        const wouldRemove = listMetadataCache().map((e) => e.key);
        output({
          wouldRemove,
          cacheDir,
          hint: 'vara-wallet metadata clear --yes to proceed',
        });
        return;
      }
      const result = clearMetadataCache();
      output({ ...result, cacheDir });
    });
}
