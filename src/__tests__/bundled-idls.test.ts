import { SailsIdlParser } from 'sails-js-parser';
import { Sails } from 'sails-js';
import { VFT_EXTENDED_IDL, VFT_STANDARD_IDL } from '../idl/bundled-idls';

describe('bundled VFT IDLs', () => {
  let parser: SailsIdlParser;

  beforeAll(async () => {
    parser = await SailsIdlParser.new();
  });

  describe('VFT_EXTENDED_IDL (single Vft service)', () => {
    let sails: Sails;

    beforeAll(() => {
      sails = new Sails(parser);
      sails.parseIdl(VFT_EXTENDED_IDL);
    });

    it('parses without error', () => {
      expect(sails.services).toBeDefined();
    });

    it('has a Vft service', () => {
      expect(sails.services['Vft']).toBeDefined();
    });

    it('contains standard query methods', () => {
      const queries = sails.services['Vft'].queries;
      expect(queries['BalanceOf']).toBeDefined();
      expect(queries['Allowance']).toBeDefined();
      expect(queries['TotalSupply']).toBeDefined();
      expect(queries['Decimals']).toBeDefined();
      expect(queries['Name']).toBeDefined();
      expect(queries['Symbol']).toBeDefined();
    });

    it('contains standard function methods', () => {
      const functions = sails.services['Vft'].functions;
      expect(functions['Transfer']).toBeDefined();
      expect(functions['Approve']).toBeDefined();
      expect(functions['TransferFrom']).toBeDefined();
    });

    it('contains Mint and Burn functions', () => {
      const functions = sails.services['Vft'].functions;
      expect(functions['Mint']).toBeDefined();
      expect(functions['Burn']).toBeDefined();
    });
  });

  describe('VFT_STANDARD_IDL (multi-service)', () => {
    let sails: Sails;

    beforeAll(() => {
      sails = new Sails(parser);
      sails.parseIdl(VFT_STANDARD_IDL);
    });

    it('parses without error', () => {
      expect(sails.services).toBeDefined();
    });

    it('has Vft, VftAdmin, and VftMetadata services', () => {
      expect(sails.services['Vft']).toBeDefined();
      expect(sails.services['VftAdmin']).toBeDefined();
      expect(sails.services['VftMetadata']).toBeDefined();
    });

    it('Vft has standard query methods', () => {
      const queries = sails.services['Vft'].queries;
      expect(queries['BalanceOf']).toBeDefined();
      expect(queries['Allowance']).toBeDefined();
      expect(queries['TotalSupply']).toBeDefined();
    });

    it('Vft has standard function methods', () => {
      const functions = sails.services['Vft'].functions;
      expect(functions['Transfer']).toBeDefined();
      expect(functions['Approve']).toBeDefined();
      expect(functions['TransferFrom']).toBeDefined();
    });

    it('VftAdmin has Mint and Burn', () => {
      const functions = sails.services['VftAdmin'].functions;
      expect(functions['Mint']).toBeDefined();
      expect(functions['Burn']).toBeDefined();
    });

    it('VftMetadata has Decimals, Name, Symbol', () => {
      const queries = sails.services['VftMetadata'].queries;
      expect(queries['Decimals']).toBeDefined();
      expect(queries['Name']).toBeDefined();
      expect(queries['Symbol']).toBeDefined();
    });
  });
});
