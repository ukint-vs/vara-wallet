import { SailsIdlParser } from 'sails-js-parser';
import { Sails } from 'sails-js';
import { DEX_FACTORY_IDL, DEX_PAIR_IDL } from '../idl/bundled-idls';

describe('bundled DEX IDLs', () => {
  let parser: SailsIdlParser;

  beforeAll(async () => {
    parser = await SailsIdlParser.new();
  });

  describe('DEX_FACTORY_IDL', () => {
    let sails: Sails;

    beforeAll(() => {
      sails = new Sails(parser);
      sails.parseIdl(DEX_FACTORY_IDL);
    });

    it('parses without error', () => {
      expect(sails.services).toBeDefined();
    });

    it('has a Factory service', () => {
      expect(sails.services['Factory']).toBeDefined();
    });

    it('contains factory query methods', () => {
      const queries = sails.services['Factory'].queries;
      expect(queries['GetPair']).toBeDefined();
      expect(queries['Pairs']).toBeDefined();
      expect(queries['FeeTo']).toBeDefined();
    });

    it('contains factory function methods', () => {
      const functions = sails.services['Factory'].functions;
      expect(functions['CreatePair']).toBeDefined();
      expect(functions['ChangeFeeTo']).toBeDefined();
    });

    it('GetPair accepts two actor_id arguments', () => {
      const getPair = sails.services['Factory'].queries['GetPair'];
      expect(getPair.args).toHaveLength(2);
    });

    it('validator matches GetPair', () => {
      const validator = (s: Sails) => {
        for (const service of Object.values(s.services)) {
          if ('GetPair' in service.queries) return true;
        }
        return false;
      };
      expect(validator(sails)).toBe(true);
    });
  });

  describe('DEX_PAIR_IDL', () => {
    let sails: Sails;

    beforeAll(() => {
      sails = new Sails(parser);
      sails.parseIdl(DEX_PAIR_IDL);
    });

    it('parses without error', () => {
      expect(sails.services).toBeDefined();
    });

    it('has Pair and Vft services', () => {
      expect(sails.services['Pair']).toBeDefined();
      expect(sails.services['Vft']).toBeDefined();
    });

    it('Pair has swap function methods', () => {
      const functions = sails.services['Pair'].functions;
      expect(functions['SwapExactTokensForTokens']).toBeDefined();
      expect(functions['SwapTokensForExactTokens']).toBeDefined();
    });

    it('Pair has liquidity function methods', () => {
      const functions = sails.services['Pair'].functions;
      expect(functions['AddLiquidity']).toBeDefined();
      expect(functions['RemoveLiquidity']).toBeDefined();
    });

    it('Pair has query methods', () => {
      const queries = sails.services['Pair'].queries;
      expect(queries['GetAmountOut']).toBeDefined();
      expect(queries['GetAmountIn']).toBeDefined();
      expect(queries['GetReserves']).toBeDefined();
      expect(queries['GetTokens']).toBeDefined();
      expect(queries['CalculateRemoveLiquidity']).toBeDefined();
      expect(queries['CalculateProtocolFee']).toBeDefined();
      expect(queries['CalculateLpUserFee']).toBeDefined();
    });

    it('Vft has standard token methods', () => {
      const queries = sails.services['Vft'].queries;
      const functions = sails.services['Vft'].functions;
      expect(queries['BalanceOf']).toBeDefined();
      expect(queries['Allowance']).toBeDefined();
      expect(queries['Decimals']).toBeDefined();
      expect(functions['Transfer']).toBeDefined();
      expect(functions['Approve']).toBeDefined();
    });

    it('validator matches SwapExactTokensForTokens', () => {
      const validator = (s: Sails) => {
        for (const service of Object.values(s.services)) {
          if ('SwapExactTokensForTokens' in service.functions) return true;
        }
        return false;
      };
      expect(validator(sails)).toBe(true);
    });
  });
});
