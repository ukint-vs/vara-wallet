/**
 * Bundled VFT IDL strings for fallback resolution.
 *
 * These cover the two standard VFT interfaces used across the Vara ecosystem
 * (vara-amm, gear-bridges, vft-studio, invariant, etc.).
 *
 * Resolution order: try VFT_EXTENDED_IDL first (single-service, more common),
 * then VFT_STANDARD_IDL (multi-service superset).
 */

/**
 * Extended VFT IDL — single Vft service with mint/burn/roles/metadata.
 * Source: vara-amm extended_vft.idl
 */
export const VFT_EXTENDED_IDL = `constructor {
  New : (name: str, symbol: str, decimals: u8);
};

service Vft {
  Burn : (from: actor_id, value: u256) -> bool;
  GrantAdminRole : (to: actor_id) -> null;
  GrantBurnerRole : (to: actor_id) -> null;
  GrantMinterRole : (to: actor_id) -> null;
  Mint : (to: actor_id, value: u256) -> bool;
  RevokeAdminRole : (from: actor_id) -> null;
  RevokeBurnerRole : (from: actor_id) -> null;
  RevokeMinterRole : (from: actor_id) -> null;
  Approve : (spender: actor_id, value: u256) -> bool;
  Transfer : (to: actor_id, value: u256) -> bool;
  TransferFrom : (from: actor_id, to: actor_id, value: u256) -> bool;
  query Admins : () -> vec actor_id;
  query Burners : () -> vec actor_id;
  query Minters : () -> vec actor_id;
  query Allowance : (owner: actor_id, spender: actor_id) -> u256;
  query BalanceOf : (account: actor_id) -> u256;
  query Decimals : () -> u8;
  query Name : () -> str;
  query Symbol : () -> str;
  query TotalSupply : () -> u256;

  events {
    Minted: struct {
      to: actor_id,
      value: u256,
    };
    Burned: struct {
      from: actor_id,
      value: u256,
    };
    Approval: struct {
      owner: actor_id,
      spender: actor_id,
      value: u256,
    };
    Transfer: struct {
      from: actor_id,
      to: actor_id,
      value: u256,
    };
  }
};
`;

/**
 * Standard VFT IDL — multi-service with separate VftAdmin, VftMetadata, etc.
 * Source: vara-amm vft-vara.idl
 */
export const VFT_STANDARD_IDL = `constructor {
  New : ();
};

service Vft {
  Approve : (spender: actor_id, value: u256) -> bool;
  Transfer : (to: actor_id, value: u256) -> bool;
  TransferFrom : (from: actor_id, to: actor_id, value: u256) -> bool;
  query Allowance : (owner: actor_id, spender: actor_id) -> u256;
  query BalanceOf : (account: actor_id) -> u256;
  query TotalSupply : () -> u256;

  events {
    Approval: struct {
      owner: actor_id,
      spender: actor_id,
      value: u256,
    };
    Transfer: struct {
      from: actor_id,
      to: actor_id,
      value: u256,
    };
  }
};

service VftAdmin {
  AppendAllowancesShard : (capacity: u32) -> null;
  AppendBalancesShard : (capacity: u32) -> null;
  ApproveFrom : (owner: actor_id, spender: actor_id, value: u256) -> bool;
  Burn : (from: actor_id, value: u256) -> null;
  Exit : (inheritor: actor_id) -> null;
  Mint : (to: actor_id, value: u256) -> null;
  Pause : () -> null;
  Resume : () -> null;
  SetAdmin : (admin: actor_id) -> null;
  SetBurner : (burner: actor_id) -> null;
  SetExpiryPeriod : (period: u32) -> null;
  SetMinimumBalance : (value: u256) -> null;
  SetMinter : (minter: actor_id) -> null;
  SetPauser : (pauser: actor_id) -> null;
  query Admin : () -> actor_id;
  query Burner : () -> actor_id;
  query IsPaused : () -> bool;
  query Minter : () -> actor_id;
  query Pauser : () -> actor_id;

  events {
    AdminChanged: actor_id;
    BurnerChanged: actor_id;
    MinterChanged: actor_id;
    PauserChanged: actor_id;
    BurnerTookPlace;
    MinterTookPlace;
    ExpiryPeriodChanged: u32;
    MinimumBalanceChanged: u256;
    Exited: actor_id;
    Paused;
    Resumed;
  }
};

service VftExtension {
  AllocateNextAllowancesShard : () -> bool;
  AllocateNextBalancesShard : () -> bool;
  RemoveExpiredAllowance : (owner: actor_id, spender: actor_id) -> bool;
  TransferAll : (to: actor_id) -> bool;
  TransferAllFrom : (from: actor_id, to: actor_id) -> bool;
  query AllowanceOf : (owner: actor_id, spender: actor_id) -> opt struct { u256, u32 };
  query Allowances : (cursor: u32, len: u32) -> vec struct { struct { actor_id, actor_id }, struct { u256, u32 } };
  query BalanceOf : (account: actor_id) -> opt u256;
  query Balances : (cursor: u32, len: u32) -> vec struct { actor_id, u256 };
  query ExpiryPeriod : () -> u32;
  query MinimumBalance : () -> u256;
  query UnusedValue : () -> u256;
};

service VftMetadata {
  query Decimals : () -> u8;
  query Name : () -> str;
  query Symbol : () -> str;
};

service VftNativeExchange {
  Burn : (value: u256) -> null;
  BurnAll : () -> null;
  Mint : () -> null;
};
`;

/** All bundled IDLs in resolution order (try first = most common) */
export const BUNDLED_VFT_IDLS = [VFT_EXTENDED_IDL, VFT_STANDARD_IDL];

// ---------------------------------------------------------------------------
// DEX (vara-amm) IDLs
// ---------------------------------------------------------------------------

/**
 * DEX Factory IDL — manages trading pair creation and registry.
 * Source: vara-amm factory.idl
 */
export const DEX_FACTORY_IDL = `type Config = struct {
  gas_for_token_ops: u64,
  gas_for_reply_deposit: u64,
  reply_timeout: u32,
  gas_for_pair_creation: u64,
};

constructor {
  New : (pair_id: code_id, admin: actor_id, fee_to: actor_id, config: Config);
};

service Factory {
  ChangeFeeTo : (fee_to: actor_id) -> null;
  CreatePair : (token0: actor_id, token1: actor_id) -> null;
  query FeeTo : () -> actor_id;
  query GetPair : (token0: actor_id, token1: actor_id) -> actor_id;
  query Pairs : () -> vec struct { struct { actor_id, actor_id }, actor_id };

  events {
    PairCreated: struct {
      token0: actor_id,
      token1: actor_id,
      pair_address: actor_id,
    };
  }
};
`;

/**
 * DEX Pair IDL — handles swaps, liquidity, and LP token (Vft service).
 * Source: vara-amm pair.idl
 */
export const DEX_PAIR_IDL = `type Config = struct {
  gas_for_token_ops: u64,
  gas_for_reply_deposit: u64,
  reply_timeout: u32,
  gas_for_full_tx: u64,
};

type MessageStatus = enum {
  SendingMsgToLockTokenA,
  TokenALocked: bool,
  SendingMsgToLockTokenB,
  TokenBLocked: bool,
  SendingMessageToReturnTokensA,
  TokensAReturnComplete: bool,
  SendingMsgToTransferTokenIn,
  TokenInTransfered: bool,
  SendingMsgToTransferTokenOut,
  TokenOutTransfered: bool,
  SendingMessageToReturnTokenIn,
  TokenInReturnComplete: bool,
  SendingMsgToUnlockTokenA,
  TokenAUnlocked: bool,
  SendingMsgToUnlockTokenB,
  TokenBUnlocked: bool,
};

constructor {
  New : (config: Config, token0: actor_id, token1: actor_id, fee_to: actor_id);
};

service Pair {
  AddLiquidity : (amount_a_desired: u256, amount_b_desired: u256, amount_a_min: u256, amount_b_min: u256, deadline: u64) -> null;
  RemoveLiquidity : (liquidity: u256, amount_a_min: u256, amount_b_min: u256, deadline: u64) -> null;
  SwapExactTokensForTokens : (amount_in: u256, amount_out_min: u256, is_token0_to_token1: bool, deadline: u64) -> null;
  SwapTokensForExactTokens : (amount_out: u256, amount_in_max: u256, is_token0_to_token1: bool, deadline: u64) -> null;
  query CalculateLpUserFee : (user: actor_id) -> u256;
  query CalculateProtocolFee : () -> u256;
  query CalculateRemoveLiquidity : (liquidity: u256) -> struct { u256, u256 };
  query GetAmountIn : (amount_out: u256, is_token0_to_token1: bool) -> u256;
  query GetAmountOut : (amount_in: u256, is_token0_to_token1: bool) -> u256;
  query GetReserves : () -> struct { u256, u256 };
  query GetTokens : () -> struct { actor_id, actor_id };
  query Lock : () -> bool;
  query MsgsInMsgTracker : () -> vec struct { message_id, MessageStatus };

  events {
    LiquidityAdded: struct {
      user_id: actor_id,
      amount_a: u256,
      amount_b: u256,
      liquidity: u256,
    };
    Swap: struct {
      user_id: actor_id,
      amount_in: u256,
      amount_out: u256,
      is_token0_to_token1: bool,
    };
    LiquidityRemoved: struct {
      user_id: actor_id,
      amount_a: u256,
      amount_b: u256,
      liquidity: u256,
    };
  }
};

service Vft {
  GrantAdminRole : (to: actor_id) -> null;
  GrantBurnerRole : (to: actor_id) -> null;
  GrantMinterRole : (to: actor_id) -> null;
  RevokeAdminRole : (from: actor_id) -> null;
  RevokeBurnerRole : (from: actor_id) -> null;
  RevokeMinterRole : (from: actor_id) -> null;
  Approve : (spender: actor_id, value: u256) -> bool;
  Transfer : (to: actor_id, value: u256) -> bool;
  TransferFrom : (from: actor_id, to: actor_id, value: u256) -> bool;
  query Admins : () -> vec actor_id;
  query Burners : () -> vec actor_id;
  query Minters : () -> vec actor_id;
  query Allowance : (owner: actor_id, spender: actor_id) -> u256;
  query BalanceOf : (account: actor_id) -> u256;
  query Decimals : () -> u8;
  query Name : () -> str;
  query Symbol : () -> str;
  query TotalSupply : () -> u256;

  events {
    Minted: struct {
      to: actor_id,
      value: u256,
    };
    Burned: struct {
      from: actor_id,
      value: u256,
    };
    Approval: struct {
      owner: actor_id,
      spender: actor_id,
      value: u256,
    };
    Transfer: struct {
      from: actor_id,
      to: actor_id,
      value: u256,
    };
  }
};
`;

/** Bundled DEX Factory IDLs */
export const BUNDLED_DEX_FACTORY_IDLS = [DEX_FACTORY_IDL];

/** Bundled DEX Pair IDLs */
export const BUNDLED_DEX_PAIR_IDLS = [DEX_PAIR_IDL];
