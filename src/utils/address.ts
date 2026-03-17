import { decodeAddress } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';
import { CliError } from './errors';

/** Normalize SS58 or hex address to 0x-prefixed hex. */
export function addressToHex(input: string): `0x${string}` {
  try {
    return u8aToHex(decodeAddress(input)) as `0x${string}`;
  } catch {
    throw new CliError(
      `Invalid address: "${input}". Expected hex (0x...) or SS58 address.`,
      'INVALID_ADDRESS',
    );
  }
}
