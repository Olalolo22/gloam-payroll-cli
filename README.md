# gloam-payroll-cli

Headless private CSV payroll runner and `gloamroll1:` payroll-total proof CLI built on [`@gloamtrade/sdk`](https://www.npmjs.com/package/@gloamtrade/sdk) (`0.8.2`).

Runs private team payroll from a server, terminal, or CI pipeline using the same shielded pool, relay, `GloamPayMemo` board, short claim links, and `/verify`-compatible `gloamroll1:` proofs as the Gloam web app — with no contract changes and no custom crypto.

## What it does

- **`plan <csv>`** — Parses a Gloam payroll CSV (`name,gloam_address,amount[,note]`), validates `gloamr1.` receive tags, checks deposit limits and `--max-total` caps, and prints the note-chain and `payroll_total` Groth16 part split (`payrollParts`) with no private key required.
- **`run <csv>`** — Funds the shielded pool via `buildShieldBoundIntent` (or spends an existing `--funding-note`), syncs the pool Merkle tree incrementally with `createTreeSync` + `gloamLeafSeed`, chains private sends via `buildPrivateSendIntent({ paySeed })` through the Gloam relay (`relayIntent` + `relayMemo`) or a direct wallet (`--direct`), seals `gloam2t.` tickets for `gloamr1.` payees, generates compact `https://gloam.trade/c#...` short claim links for blank-address rows, and exports a payout CSV.
- **`resume <run.json>`** — Crash-safe recovery. Every row's spend nullifier, payment commitment, change note, and delivery code are written atomically (`0600`) **before** broadcast. On resume, any `unconfirmed` row is reconciled against `commitmentSeen` and `isSpent` on the pool contract so a dropped relay or RPC never double-pays or loses change.
- **`prove <run.json> --for "Auditor"`** — Generates a `gloamroll1:<base64>` payroll total proof bundle using `@gloamtrade/sdk`'s `buildPayrollWitness`, `payrollParts` (even splits over 32-slot circuits so a 33-person run proves `17 + 16`, never `32 + 1`), `circuitArtifactFiles("payroll_total", ...)`, and `proofContext`. Paste the output directly into `https://www.gloam.trade/verify`.
- **`verify-token <token|file>`** — Decodes and checks a `gloamroll1:` token locally (`proofContext`, `payrollPaymentsHash`, duplicate commitment/nullifier checks, summed counts/totals, plus optional `--snark` Groth16 verification via `verifyGroth16`).

## Quickstart

```bash
pnpm install
pnpm typecheck
pnpm test

# 1. Dry-run a payroll CSV (defaults to Robinhood Chain testnet; no key needed)
pnpm cli plan sample-payroll.csv

# 2. Dry-run against Tempo mainnet USDC.e with a safety cap
pnpm cli plan sample-payroll.csv --network tempo-mainnet --asset USDC.e --max-total 10000

# 3. Execute on testnet (set GLOAM_PAY_KEY to fund the shield deposit; sends go through the Gloam relay by default)
GLOAM_PAY_KEY=0x... pnpm cli run sample-payroll.csv --network robinhood

# 4. Resume after an interrupted run (checks pool state before retrying any unconfirmed row)
pnpm cli resume runs/payroll-....run.json

# 5. Generate a gloamroll1 total proof for an auditor or accountant
pnpm cli prove runs/payroll-....run.json --for "Acme Audit" --days 30 --out proof.txt

# 6. Verify a gloamroll1 token locally (add --snark to verify Groth16 proofs against payroll_total_vkey.json)
pnpm cli verify-token proof.txt --snark
```

## CSV format

Matches the Gloam web app (`name,gloam_address,amount,note`). Comma, semicolon, and tab delimiters are auto-detected from line 1:

```csv
name,gloam_address,amount,note
Ada Obi,gloamr1.PASTE_RECEIVE_TAG,1250,November salary
Tunde Bello,,980,Contractor invoice
```

- **With `gloam_address` (`gloamr1....`)**: payment note is sealed via P-256 ECDH (`gloam2t.`) and posted to `GloamPayMemo` where deployed (`relayMemo`).
- **Blank `gloam_address`**: payer generates a 16-byte `paySeed` and outputs a ~30-character `https://gloam.trade/c#...` short claim link.

## Crash safety and key handling

- Run state files (`runs/*.run.json`) and payout exports (`runs/*.payouts.csv`) are written atomically with `0600` permissions and excluded in `.gitignore`.
- Funding note and change note secrets are persisted before every `shieldBound` or `transfer` submission.
- If the relay returns an uncertain error (`RELAY_MAYBE_SENT`), the row stays `unconfirmed` so `resume` queries `commitmentSeen(paymentCommitment)` and `isSpent(spendNullifier)` before retrying.
- Circuit files are hash-checked against `@gloamtrade/sdk`'s pinned `CIRCUIT_SHA256` before proving.
