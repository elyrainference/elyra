# ElyraEscrow — Robinhood mainnet fork rehearsal (real USDG, no real funds)

Generated: 2026-11-04T18:23:32.824Z  
Fork: chain id 4663, block 106106158 of `https://rpc.mainnet.chain.robinhood.com` (read-only, via DoH proxy `127.0.0.1:8599`), local node `http://127.0.0.1:8557`.  
Token: real USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`. Escrow: committed `artifacts/ElyraEscrow.json` deployed on the fork only. All wallets are throwaway; no mainnet transaction is ever sent (proxy refuses write RPCs).  
Result: **OK** — 14 passed, 0 failed, 0 skipped.

| Step | Result | Gas | What |
|---|---|---|---|
| 0.1 | PASS |  | start read-only DoH proxy → mainnet RPC |
| 0.2 | PASS |  | start `hardhat node --fork` on the proxy |
| A | PASS |  | read real USDG facts on the fork |
| B | PASS |  | find a rich USDG holder and impersonate it on the fork |
| C | PASS | 986030 | deploy ElyraEscrow(real USDG) on the fork |
| D1 | PASS | 65354 | fund throwaway wallets: 100 USDG → consumer (from impersonated holder), 1 ETH gas each |
| D2 | PASS | approve 57976 + deposit 102180 | consumer approve(40) + deposit(40 USDG) |
| D3 | PASS | 108221 | consumer signs cumulative voucher 12.345678 USDG; provider redeems |
| D4 | PASS |  | second redeem of the same voucher reverts, state unchanged |
| D5 | PASS | 59296 | requestWithdraw, early withdraw locked, +1 day, withdraw rest |
| E1 | PASS | 65342 | direct token.transfer(1 unit) to the escrow works; not fee-on-transfer |
| E2 | PASS | deposit(1) 89856, deposit(3e6) 67980 | escrow balance-delta check passes on the real token (1-unit and 3 USDG deposits) |
| E3 | PASS |  | no rebasing/yield accrual: escrow balance + totalSupply constant after 30 days of fork time |
| F | PASS |  | supply-controller burn risk (decreaseSupplyFromAddress on the escrow) |

Gas figures are hardhat EVM gas on the fork (no Arbitrum L1 data fee component).

## Step details

### 0.1 — start read-only DoH proxy → mainnet RPC — PASS

```json
{
  "proxy": "http://127.0.0.1:8599",
  "upstream": "https://rpc.mainnet.chain.robinhood.com",
  "upstreamChainId": "4663",
  "latestBlock": 106106163,
  "pinnedBlock": 106106158,
  "pinnedBlockTime": "2026-11-04T18:21:56.000Z"
}
```

### 0.2 — start `hardhat node --fork` on the proxy — PASS

```json
{
  "pid": 23536,
  "url": "http://127.0.0.1:8557",
  "forkChainId": "4663"
}
```

### A — read real USDG facts on the fork — PASS

```json
{
  "symbol": "USDG",
  "name": "Global Dollar",
  "decimals": 6,
  "totalSupply": "672406853269857 (672406853.269857 USDG)",
  "eip1967Implementation": "0x68184C449E1a8f34fA18d289737129FD27B66f8F",
  "eip1967Admin": "0x0 (none)",
  "proxyCodeBytes": 170,
  "implCodeBytes": 18644,
  "implCodeHash": "0x3a551ac5c744af57e68a1d1431ac403c0f516ffd7d224a75746aee11fc4f3baf",
  "owner": "0xcFA0388f5ddf905FdC08c45c716C15Dc10A14C6F",
  "paused": false,
  "supplyControl": "0xdf5FfF9cb88B3cAb50572FAE73E2EB08599D25D4"
}
```

### B — find a rich USDG holder and impersonate it on the fork — PASS

```json
{
  "blockscout": "HTTP 403 (Cloudflare challenge)",
  "method": "transfer-log scan via proxy",
  "scannedAddresses": 2802,
  "holder": "0x264bd8291fAE1D75DB2c5F573b07faA6715997B5",
  "holderIsContract": false,
  "holderBalance": "15203776519928 (15203776.519928 USDG)",
  "top": [
    {
      "address": "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d",
      "usdg": "103750921.513076",
      "contract": true
    },
    {
      "address": "0x4FdBDaF4800fc28c22a967d23a343aCCE34315a4",
      "usdg": "63581794.826049",
      "contract": true
    },
    {
      "address": "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010",
      "usdg": "51415258.084149",
      "contract": true
    },
    {
      "address": "0x8366a39CC670B4001A1121B8F6A443A643e40951",
      "usdg": "42843710.342557",
      "contract": true
    },
    {
      "address": "0xd4A91E5023406903afF83225186e1d1eD18CA587",
      "usdg": "31762618.373532",
      "contract": true
    }
  ]
}
```

### C — deploy ElyraEscrow(real USDG) on the fork — PASS

```json
{
  "escrow": "0xf2CD654d73FdB4eE10Fe4f24C25dc013D00Cde19",
  "token": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  "artifactCompiler": "solc 0.8.26",
  "domainSeparatorChainId": "4663",
  "deployGasUsed": "986030"
}
```

### D1 — fund throwaway wallets: 100 USDG → consumer (from impersonated holder), 1 ETH gas each — PASS

```json
{
  "consumer": "0x68A7038B46C706160600994d0E6f0880BA8D15cd",
  "provider": "0x2afB11c2dEa6Be9d8F4003fBbC05466db0e8B337",
  "consumerUsdg": "100.0",
  "holderDeltaUnits": "100000000",
  "consumerDeltaUnits": "100000000",
  "note": "real USDG transfer, no fee taken"
}
```

### D2 — consumer approve(40) + deposit(40 USDG) — PASS

```json
{
  "deposits": "40000000",
  "escrowBalance": "40000000",
  "allowanceAfterDeposit": "0",
  "consumerUsdg": "60.0"
}
```

### D3 — consumer signs cumulative voucher 12.345678 USDG; provider redeems — PASS

```json
{
  "providerReceivedUnits": "12345678",
  "deposits": "27654322",
  "escrowBalance": "27654322",
  "claimed": "12345678"
}
```

### D4 — second redeem of the same voucher reverts, state unchanged — PASS

```json
{
  "revert": {
    "raw": "0xc2fa33e5",
    "name": "NotAboveClaimed",
    "args": []
  },
  "stateUnchanged": true
}
```

### D5 — requestWithdraw, early withdraw locked, +1 day, withdraw rest — PASS

```json
{
  "earlyWithdrawRevert": {
    "raw": "0xfb5d3d9d000000000000000000000000000000000000000000000000000000006aecc997",
    "name": "WithdrawLocked",
    "args": [
      "1793902999"
    ]
  },
  "withdrawn": "27654322 (27.654322 USDG)",
  "consumerFinalUnits": "87654322",
  "conservation": "consumer + provider == 100 USDG",
  "providerUnits": "12345678",
  "deposits": "0",
  "escrowBalance": "0"
}
```

### E1 — direct token.transfer(1 unit) to the escrow works; not fee-on-transfer — PASS

```json
{
  "escrowDelta": "1",
  "holderDelta": "1",
  "note": "escrow now holds 1 unrecoverable donated unit (no sweep function); deposits sum unchanged",
  "escrowBalance": "1",
  "depositsSum": "0"
}
```

### E2 — escrow balance-delta check passes on the real token (1-unit and 3 USDG deposits) — PASS

```json
{
  "deposits": "3000001",
  "escrowBalance": "3000002",
  "surplusUnits": "1"
}
```

### E3 — no rebasing/yield accrual: escrow balance + totalSupply constant after 30 days of fork time — PASS

```json
{
  "escrowBalance": [
    "3000002",
    "3000002"
  ],
  "totalSupply": [
    "672406853269857",
    "672406853269857"
  ]
}
```

### F — supply-controller burn risk (decreaseSupplyFromAddress on the escrow) — PASS

```json
{
  "supplyControl": "0xdf5FfF9cb88B3cAb50572FAE73E2EB08599D25D4",
  "controllers": [
    "0xf845a0A05Cbd91Ac15C3E59D126DE5dFbC2aAbb7",
    "0x2fb074FA59c9294c71246825C1c9A0c7782d41a4",
    "0x0d54755f5106BfdB43f7a35f5D49a23F940628d1",
    "0x835e20DA02D830d6074Ca2341e2928f438121691"
  ],
  "canBurnFromAddress_view_firstController": {
    "reverted": {
      "raw": "0x595fac73000000000000000000000000f845a0a05cbd91ac15c3e59d126de5dfbc2aabb7000000000000000000000000f2cd654d73fdb4ee10fe4f24c25dc013d00cde19",
      "name": "CannotBurnFromAddress",
      "args": [
        "0xf845a0A05Cbd91Ac15C3E59D126DE5dFbC2aAbb7",
        "0xf2CD654d73FdB4eE10Fe4f24C25dc013D00Cde19"
      ]
    }
  },
  "canBurnFromEscrow_perController": {
    "0xf845a0A05Cbd91Ac15C3E59D126DE5dFbC2aAbb7": "CannotBurnFromAddress",
    "0x2fb074FA59c9294c71246825C1c9A0c7782d41a4": "CannotBurnFromAddress",
    "0x0d54755f5106BfdB43f7a35f5D49a23F940628d1": "(empty revert)",
    "0x835e20DA02D830d6074Ca2341e2928f438121691": "CannotBurnFromAddress"
  },
  "setup": {
    "consumerDeposit": "13000001",
    "escrowBalanceBeforeBurn": "13000002"
  },
  "burnStaticCallPerController": {
    "0xf845a0A05Cbd91Ac15C3E59D126DE5dFbC2aAbb7": "CannotBurnFromAddress",
    "0x2fb074FA59c9294c71246825C1c9A0c7782d41a4": "CannotBurnFromAddress",
    "0x0d54755f5106BfdB43f7a35f5D49a23F940628d1": "WOULD SUCCEED",
    "0x835e20DA02D830d6074Ca2341e2928f438121691": "CannotBurnFromAddress"
  },
  "controller": "0x0d54755f5106BfdB43f7a35f5D49a23F940628d1",
  "firstControllerNote": "controllers[0] is only used for the reconfiguration scenario when no controller can burn as-is",
  "burnAsRealController": "SUCCEEDED",
  "burnWasHypothetical": false,
  "afterBurn": {
    "burned": "11000000",
    "escrowBalance": "2000002",
    "deposits": "13000001",
    "accountingGapUnits": "10999999",
    "accountingGapUsdg": "10.999999"
  },
  "tokenRevertOnOverTransfer": {
    "raw": "0x356680b7",
    "name": "InsufficientFunds",
    "args": []
  },
  "redeemExceedingBalance": {
    "owed": "5000000",
    "escrowBalance": "2000002",
    "staticCallRevert": {
      "raw": "0x045c4b02",
      "name": "TokenTransferFailed",
      "args": []
    },
    "txMined": false,
    "stateUnchanged": true
  },
  "withdrawFullDeposit": {
    "amount": "13000001",
    "escrowBalance": "2000002",
    "staticCallRevert": {
      "raw": "0x045c4b02",
      "name": "TokenTransferFailed",
      "args": []
    },
    "txMined": false,
    "stateUnchanged": true
  },
  "withdrawUpToRealBalance": {
    "amount": "2000002",
    "ok": true,
    "escrowBalanceAfter": "0",
    "depositsAfter": "10999999"
  },
  "conclusion": "A REAL supply controller (0x0d54755f5106BfdB43f7a35f5D49a23F940628d1) can burn from the escrow as currently configured on mainnet (no reconfiguration needed; per-controller static calls: {\n  \"0xf845a0A05Cbd91Ac15C3E59D126DE5dFbC2aAbb7\": \"CannotBurnFromAddress\",\n  \"0x2fb074FA59c9294c71246825C1c9A0c7782d41a4\": \"CannotBurnFromAddress\",\n  \"0x0d54755f5106BfdB43f7a35f5D49a23F940628d1\": \"WOULD SUCCEED\",\n  \"0x835e20DA02D830d6074Ca2341e2928f438121691\": \"CannotBurnFromAddress\"\n}). After the simulated burn deposits[] exceeded the real escrow balance by 10.999999 USDG; over-balance redeem/withdraw revert atomically with TokenTransferFailed (token revert: InsufficientFunds); amounts up to the remaining balance are paid first-come-first-served; the burned shortfall is unrecoverable and there is no on-chain remedy (documented in ElyraEscrow.sol). The token is additionally upgradeable by its owner (UUPS-style upgradeTo/setFacet), so burn is not the only issuer-side lever."
}
```

## Processes

- fork-proxy (in-process): PID 21764 (stopped at end of run)
- hardhat fork node: PID 23536 (stopped at end of run)
