# gloam-payroll-cli

Headless private CSV payroll runner and `gloamroll1:` payroll-total proof CLI built on [`@gloamtrade/sdk`](https://www.npmjs.com/package/@gloamtrade/sdk) (`0.8.1`).

Gloam's web app already runs private payroll in the browser, and `gloamtrade/gloam` ships ten runnable CLI/agent examples (`pay-x402`, `pay-bot`, `mpp-gloam`, etc.), but none for headless team payroll or generating `/verify`-compatible `gloamroll1:` total proofs from a server or CI pipeline. This tool fills that gap without touching any contract or introducing custom crypto.

## What it does

- **`plan <csv>`** — Parses a Gloam payroll CSV (`name,gloam_address,amount[,note]`), validates `gloamr1.` receive tags, checks deposit limits and `--max-total` caps, and prints the exact note-chain and `payroll_total` Groth16 part split (`payrollParts`) with zero private keys required.
- **`run <csv>`** — Funds the shielded pool via `buildShieldBoundIntent` (or spends an existing `--funding-note`), syncs the pool Merkle tree incrementally with `createTreeSync` + `gloamLeafSeed`, chains private transfers row-by-row through the Gloam relay (`relayIntent` + `relayMemo`) or a direct wallet (`--direct`), seals `gloam2t.` tickets for `gloamr1.` payees, generates compact `https://gloam.trade/c#...` short claim links for blank-address rows, and exports a clean payout CSV.
- **`resume <run.json>`** — Crash-safe recovery. Every row's spend nullifier, payment commitment, change note, and delivery code are written atomically (`0600`) **before** broadcast. On resume, any `unconfirmed` row is checked against `commitmentSeen` and `isSpent` on the pool contract so a dropped relay or RPC never double-pays or loses change.
- **`prove <run.json> --for "Auditor"`** — Generates a `gloamroll1:<base64>` payroll total proof bundle using `@gloamtrade/sdk`'s `buildPayrollWitness`, `payrollParts` (even splits over 32-slot circuits so a 33-person run proves `17 + 16`, never `32 + 1`), and `proofContext`. Paste the output directly into `https://www.gloam.trade/verify`.
- **`verify-token <token|file>`** — Decodes and checks a `gloamroll1:` token locally (`proofContext`, `payrollPaymentsHash`, duplicate commitment/nullifier check, summed counts/totals, plus optional `--snark` Groth16 verification via `verifyGroth16`).

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
- If the relay returns an uncertain error (`RELAY_MAYBE_SENT`), the row remains `unconfirmed` so `resume` queries `commitmentSeen(paymentCommitment)` and `isSpent(spendNullifier)` before taking action.

## SDK notes from building this on `@gloamtrade/sdk@0.8.1`

Four small friction points encountered while building a headless payroll consumer purely on top of `@gloamtrade/sdk`:

1. **`CIRCUIT_SHA256` / `circuitArtifactFiles` omit `payroll_total` (and `funds`) and vkeys.** The SDK exports `buildPayrollWitness`, `payrollParts`, `payrollPaymentsHash`, `readPayrollSignals`, and `verifyGroth16` (whose JSDoc cites `payroll`), but `constants.ts` only pins `shield`, `transfer`, `unshield`, and `receipt` wasm/zkey hashes. Headless callers currently have to mirror `payroll_total` hashes from `app/src/lib/proofs/artifacts.ts` (see [`src/artifacts.ts`](src/artifacts.ts)).
2. **`buildPrivateSendIntent` does not forward `paySeed` to `buildTransferWitness`.** `witness.ts` accepts `paySeed` so claim links compress to ~30-char `0x1f` short links (`encodeShortClaim`), but `PrivateSendIntentParams` in `builders.ts` omits it. Calling `buildTransferWitness` directly (as in [`src/runner.ts`](src/runner.ts)) recovers short links.
3. **`gloamroll1:` envelope encoding/decoding lives only in `app/src/lib/proofs/index.ts`.** Exporting the `v: 1` proof envelope encoder/decoder (for `gloamfunds1:`, `gloampay1:`, `gloamroll1:`, `gloambal1:`) from `@gloamtrade/sdk` would let CLI/CI tools emit `/verify`-ready tokens without duplicating the schema.
4. **Prover option naming differs across builders.** `buildShieldBoundIntent` takes `prover`, while `buildPrivateSendIntent` and `buildUnshieldIntent` take `prove`.
