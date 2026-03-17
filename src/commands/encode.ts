import { Command } from 'commander';
import { ProgramMetadata } from '@gear-js/api';
import * as fs from 'fs';
import { getApi } from '../services/api';
import { loadSails } from '../services/sails';
import { output, verbose, CliError } from '../utils';

export function registerEncodeCommand(program: Command): void {
  program
    .command('encode')
    .description('Encode a payload using metadata or Sails IDL')
    .argument('<type>', 'type name or index to encode')
    .argument('<value>', 'JSON value to encode')
    .option('--metadata <path>', 'path to .meta.txt file')
    .option('--idl <path>', 'path to Sails IDL file')
    .option('--program <id>', 'program ID (for IDL-based encoding)')
    .option('--method <service/method>', 'Service/Method for Sails encoding')
    .action(async (type: string, value: string, options: {
      metadata?: string;
      idl?: string;
      program?: string;
      method?: string;
    }) => {
      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(value);
      } catch {
        parsedValue = value;
      }

      if (options.idl && options.method) {
        // Sails IDL encoding
        const opts = program.optsWithGlobals() as { ws?: string };
        const api = await getApi(opts.ws);
        const programId = options.program || '0x0000000000000000000000000000000000000000000000000000000000000000';

        const sails = await loadSails(api, { programId, idl: options.idl });

        const parts = options.method.split('/');
        if (parts.length !== 2) {
          throw new CliError('--method must be "Service/Method" format', 'INVALID_METHOD_FORMAT');
        }
        const [serviceName, methodName] = parts;
        const service = sails.services[serviceName];
        if (!service) {
          throw new CliError(`Service "${serviceName}" not found`, 'SERVICE_NOT_FOUND');
        }

        const func = service.functions[methodName] || service.queries[methodName];
        if (!func) {
          throw new CliError(`Method "${methodName}" not found in "${serviceName}"`, 'METHOD_NOT_FOUND');
        }

        const args = Array.isArray(parsedValue) ? parsedValue : [parsedValue];
        const encoded = func.encodePayload(...args);

        output({ encoded });
      } else if (options.metadata) {
        // Legacy metadata encoding
        verbose('Encoding with metadata');
        const metaHex = fs.readFileSync(options.metadata, 'utf-8').trim();
        const meta = ProgramMetadata.from(metaHex);

        const typeIndex = parseInt(type, 10);
        const encoded = meta.createType(typeIndex, parsedValue);

        output({ encoded: encoded.toHex() });
      } else {
        throw new CliError(
          'Provide --metadata or --idl with --method for encoding',
          'MISSING_ENCODING_SOURCE',
        );
      }
    });

  program
    .command('decode')
    .description('Decode a hex payload using metadata or Sails IDL')
    .argument('<type>', 'type name or index to decode')
    .argument('<hex>', 'hex-encoded payload (0x...)')
    .option('--metadata <path>', 'path to .meta.txt file')
    .option('--idl <path>', 'path to Sails IDL file')
    .option('--program <id>', 'program ID (for IDL-based decoding)')
    .option('--method <service/method>', 'Service/Method for Sails decoding')
    .action(async (type: string, hex: string, options: {
      metadata?: string;
      idl?: string;
      program?: string;
      method?: string;
    }) => {
      if (options.idl && options.method) {
        const opts = program.optsWithGlobals() as { ws?: string };
        const api = await getApi(opts.ws);
        const programId = options.program || '0x0000000000000000000000000000000000000000000000000000000000000000';

        const sails = await loadSails(api, { programId, idl: options.idl });

        const parts = options.method.split('/');
        if (parts.length !== 2) {
          throw new CliError('--method must be "Service/Method" format', 'INVALID_METHOD_FORMAT');
        }
        const [serviceName, methodName] = parts;
        const service = sails.services[serviceName];
        if (!service) {
          throw new CliError(`Service "${serviceName}" not found`, 'SERVICE_NOT_FOUND');
        }

        const func = service.functions[methodName] || service.queries[methodName];
        if (!func) {
          throw new CliError(`Method "${methodName}" not found in "${serviceName}"`, 'METHOD_NOT_FOUND');
        }

        const decoded = func.decodeResult(hex as `0x${string}`);

        output({ decoded });
      } else if (options.metadata) {
        verbose('Decoding with metadata');
        const metaHex = fs.readFileSync(options.metadata, 'utf-8').trim();
        const meta = ProgramMetadata.from(metaHex);

        const typeIndex = parseInt(type, 10);
        const decoded = meta.createType(typeIndex, hex);

        output({ decoded: decoded.toJSON() });
      } else {
        throw new CliError(
          'Provide --metadata or --idl with --method for decoding',
          'MISSING_DECODING_SOURCE',
        );
      }
    });
}
