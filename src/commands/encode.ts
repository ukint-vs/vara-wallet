import { Command } from 'commander';
import { ProgramMetadata } from '@gear-js/api';
import * as fs from 'fs';
import { getApi } from '../services/api';
import { loadSailsAuto, parseIdlFileAuto, isSailsV2, suggestMethod, suggestService, type LoadedSails } from '../services/sails';
import { output, verbose, CliError, tryHexToText, coerceArgsAuto, loadArgsJson } from '../utils';

export function registerEncodeCommand(program: Command): void {
  program
    .command('encode')
    .description('Encode a payload using metadata or Sails IDL')
    .argument('<type>', 'type name or index to encode')
    .argument('[value]', 'JSON value to encode (omit when using --args-file)')
    .option('--args-file <path>', 'read JSON value from file (use - for stdin)')
    .option('--metadata <path>', 'path to .meta.txt file')
    .option('--idl <path>', 'path to Sails IDL file')
    .option('--program <id>', 'program ID (for IDL-based encoding)')
    .option('--method <service/method>', 'Service/Method for Sails encoding')
    .action(async (type: string, value: string | undefined, options: {
      argsFile?: string;
      metadata?: string;
      idl?: string;
      program?: string;
      method?: string;
    }) => {
      // Mutual exclusion: positional value + --args-file. The CLI surface
      // is "pick one source for the JSON value to encode."
      if (value !== undefined && options.argsFile !== undefined) {
        throw new CliError(
          'Cannot use the positional value and --args-file together; pick one. ' +
          '(positional for inline JSON, --args-file for file path or - for stdin)',
          'INVALID_ARGS_SOURCE',
        );
      }

      let parsedValue: unknown;
      if (options.argsFile !== undefined) {
        // Strict JSON via the shared helper. No string fallback — callers
        // using --args-file are passing a JSON document, not a bare scalar.
        parsedValue = loadArgsJson({ argsFile: options.argsFile });
      } else if (value !== undefined) {
        // Backward-compat: positional value tries JSON, falls back to raw
        // string so `vara-wallet encode text "hello"` works without quoting.
        try {
          parsedValue = JSON.parse(value);
        } catch {
          parsedValue = value;
        }
      } else {
        throw new CliError(
          'Provide a value (positional) or --args-file <path>',
          'MISSING_ENCODING_INPUT',
        );
      }

      if (options.idl && options.method) {
        // Sails IDL encoding — works offline when no --program is given.
        // Auto-detects IDL v1 vs v2.
        let sails: LoadedSails;
        if (options.program) {
          const opts = program.optsWithGlobals() as { ws?: string };
          const api = await getApi(opts.ws);
          sails = await loadSailsAuto(api, { programId: options.program, idl: options.idl });
        } else {
          sails = await parseIdlFileAuto(options.idl);
        }

        const parts = options.method.split('/');
        if (parts.length !== 2) {
          throw new CliError('--method must be "Service/Method" format', 'INVALID_METHOD_FORMAT');
        }
        const [serviceName, methodName] = parts;
        const service = sails.services[serviceName];
        if (!service) {
          const hint = suggestService(sails, serviceName);
          const prefix = hint ? `Did you mean: ${hint}/${methodName}? ` : '';
          throw new CliError(`${prefix}Service "${serviceName}" not found`, 'SERVICE_NOT_FOUND');
        }

        const func = service.functions[methodName] || service.queries[methodName];
        if (!func) {
          const hint = suggestMethod(sails, serviceName, methodName);
          const prefix = hint ? `Did you mean: ${hint}? ` : '';
          throw new CliError(`${prefix}Method "${methodName}" not found in "${serviceName}"`, 'METHOD_NOT_FOUND');
        }

        // Reject named-arg objects ({"address": "0x..."}) here — Sails
        // methods take positional args. Scalars (strings, numbers) are
        // legitimately wrapped to [value] for single-arg methods, so only
        // plain objects are rejected; arrays and scalars pass through.
        if (
          parsedValue !== null &&
          typeof parsedValue === 'object' &&
          !Array.isArray(parsedValue)
        ) {
          const preview = JSON.stringify(parsedValue) ?? String(parsedValue);
          const truncated = preview.length > 100 ? preview.slice(0, 100) + '...' : preview;
          throw new CliError(
            `Args must be a JSON array of positional values or a scalar, e.g. ["0x..."]. ` +
            `Got object: ${truncated}`,
            'INVALID_ARGS_FORMAT',
          );
        }
        const rawArgs = Array.isArray(parsedValue) ? parsedValue : [parsedValue];
        const args = coerceArgsAuto(rawArgs, func.args, sails, serviceName);
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
      // Standalone text decoding — no metadata or IDL required
      if (type === 'text') {
        const text = tryHexToText(hex);
        if (text === undefined) {
          // Fall back to raw UTF-8 decode even if not strict ASCII printable
          const stripped = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
          if (stripped.length === 0 || stripped.length % 2 !== 0) {
            throw new CliError('Invalid hex string for text decoding', 'INVALID_HEX');
          }
          const raw = Buffer.from(stripped, 'hex').toString('utf-8');
          output({ decoded: raw, note: 'Contains non-printable or non-ASCII characters' });
          return;
        }
        output({ decoded: text });
        return;
      }

      if (options.idl && options.method) {
        const opts = program.optsWithGlobals() as { ws?: string };
        const api = await getApi(opts.ws);
        const programId = options.program || '0x0000000000000000000000000000000000000000000000000000000000000000';

        const sails = await loadSailsAuto(api, { programId, idl: options.idl });

        const parts = options.method.split('/');
        if (parts.length !== 2) {
          throw new CliError('--method must be "Service/Method" format', 'INVALID_METHOD_FORMAT');
        }
        const [serviceName, methodName] = parts;
        const service = sails.services[serviceName];
        if (!service) {
          const hint = suggestService(sails, serviceName);
          const prefix = hint ? `Did you mean: ${hint}/${methodName}? ` : '';
          throw new CliError(`${prefix}Service "${serviceName}" not found`, 'SERVICE_NOT_FOUND');
        }

        const func = service.functions[methodName] || service.queries[methodName];
        if (!func) {
          const hint = suggestMethod(sails, serviceName, methodName);
          const prefix = hint ? `Did you mean: ${hint}? ` : '';
          throw new CliError(`${prefix}Method "${methodName}" not found in "${serviceName}"`, 'METHOD_NOT_FOUND');
        }

        let decoded: unknown;
        try {
          decoded = func.decodeResult(hex as `0x${string}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // v2 decodeResult expects a 16-byte SailsMessageHeader prefix at the
          // start of the bytes (see sails-js v1.0.0-beta.1 sails-idl-v2.ts).
          // Surface the hint only when we know the IDL is v2 — v1 users
          // would find the header reference misleading.
          const hint = isSailsV2(sails)
            ? '\nIf this is a v2 reply, ensure the hex includes the 16-byte SailsMessageHeader prefix that reply messages carry.'
            : '';
          throw new CliError(
            `Failed to decode payload: ${msg}${hint}`,
            'DECODE_ERROR',
          );
        }

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
