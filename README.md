# gloam-payroll-cli

Headless private CSV payroll runner and `gloamroll1:` payroll-total proof CLI built on [`@gloamtrade/sdk`](https://www.npmjs.com/package/@gloamtrade/sdk) (`0.9.x`).

Linked from the [Gloam Private Payroll docs](https://www.gloam.trade/docs/payroll#headless) as a community tool for running payroll from a server, terminal, or CI job without a browser.

> **Community tool notice:** Built and maintained by [Olu (`Olalolo22`)](https://github.com/Olalolo22), not by Gloam. Read the code and test on a testnet or with small amounts before running mainnet payroll.

---

## Features

- **EVM Private Payroll** (Robinhood Chain, Tempo, Base, Ethereum, Elysium, BNB Chain + testnets):
  - Same CSV list format as the Gloam web app: `gloamr1.` Gloam addresses, Gloam `@names` (resolved on-chain via `GloamNames`), or blank address for compact `https://gloam.trade/c#...` short claim links. Public `0x` addresses are refused on purpose.
  - Sends through the Gloam relay by default (`relayIntent` + `relayMemo`), or directly from your wallet (`--direct`).
  - **Crash-safe `resume`**: Persists note openings before broadcast (`0600`). Reconciles shield deposits and in-flight rows on-chain, and re-proves any retried `unconfirmed` row with its **exact same** `(payment, change)` outputs so a late mempool confirmation can never double-pay or strand change.
  - **`gloamroll1:` total proofs**: Generates `/verify`-compatible multi-part Groth16 proofs (`payrollParts` even splits over 32-slot circuits so a 33-person run proves `17 + 16`, never `32 + 1`), scoped to a named verifier with an expiry.
- **Solana Private Payroll** (`--network solana` / `solana-devnet` via `@gloamtrade/sdk/solana` and Helius Privacy Rings):
  - Opens the same derived Gloam private account as the web app from `GLOAM_SOLANA_KEY` (base58, JSON array, or Solana CLI keypair path).
  - Pre-checks every recipient's Privacy Rings registration before moving funds, tops up shortfall from your main wallet (unless `--no-add`), paces sends for Gloam's Solana relay, and reconciles in-flight signatures on `resume`.
  - *Privacy note (same as official Gloam):* Solana Privacy Rings hides the asset and amount of each private payment; both private accounts are public, adding money shows the main wallet, proofs use Helius's prover, and `gloamroll1:` total proofs are EVM-only.
- **CI & script ready**: Strict flag parsing, `--json` output on `plan` / `status` / `prove` / `verify-token` / `networks`, safe `status` inspection without printing secrets, and spreadsheet formula-injection neutralization on exported payout CSVs.

---

## Install & Build

Requires **Node.js 20+** and **pnpm**:

```bash
git clone https://github.com/Olalolo22/gloam-payroll-cli.git
cd gloam-payroll-cli
pnpm install
pnpm build
```

Run via `pnpm cli ...`, via the compiled binary `node dist/cli.js ...`, or link `gloam-payroll` globally with `pnpm link --global`.

---

## Quickstart

### EVM Payroll (shielded vaults + `gloamroll1:` proofs)

```bash
# 1. List all live EVM networks, Solana, vaults, assets, and deposit limits
pnpm cli networks

# 2. Dry-run a payroll CSV (resolves @names automatically; pass --offline to skip RPC lookup)
pnpm cli plan sample-payroll.csv --network base-mainnet --asset USDC --max-total 10000

# 3. Execute on testnet or mainnet (sends go through the Gloam relay by default)
GLOAM_PAY_KEY=0x... pnpm cli run sample-payroll.csv --network robinhood

#    Or fund from an existing private note package instead of shielding a fresh deposit:
pnpm cli run sample-payroll.csv --network base-mainnet --asset USDC --funding-note "gloam1...."

# 4. Inspect run progress safely (no secrets printed)
pnpm cli status runs/payroll-....run.json

# 5. Resume after any interruption (reconciles on-chain before retrying; also retries unposted memos)
pnpm cli resume runs/payroll-....run.json

# 6. Generate a gloamroll1 total proof for an auditor or accountant
pnpm cli prove runs/payroll-....run.json --for "Acme Audit" --days 30 --out proof.txt

# 7. Verify a gloamroll1 token locally (add --snark to verify Groth16 pairings)
pnpm cli verify-token proof.txt --snark
```

### Solana Payroll (Helius Privacy Rings)

```bash
# 1. Dry-run a Solana payroll CSV (name,address,amount)
pnpm cli plan solana-team.csv --network solana --asset USDC --max-total 10000

# 2. Execute (GLOAM_SOLANA_KEY accepts base58, JSON byte array, or path to ~/.config/solana/id.json)
GLOAM_SOLANA_KEY=~/.config/solana/id.json pnpm cli run solana-team.csv --network solana --asset USDC

#    Spend existing private balance only (refuse to add from main wallet):
GLOAM_SOLANA_KEY=~/.config/solana/id.json pnpm cli run solana-team.csv --network solana --asset USDC --no-add

# 3. Resume an interrupted Solana run safely
GLOAM_SOLANA_KEY=~/.config/solana/id.json pnpm cli resume runs/payroll-....run.json
```

---

## Supported Networks

Run `pnpm cli networks` (or `--json`) for live addresses and limits straight from `@gloamtrade/sdk`:

| Network | `--network` key | Notes |
| --- | --- | --- |
| Robinhood Chain | `robinhood-mainnet` | `ShieldPoolPayments`, memo board live, `gloamroll1:` proofs |
| Tempo | `tempo-mainnet` | `ShieldPoolPayments`, memo board live, `gloamroll1:` proofs |
| Base | `base-mainnet` | `ShieldPoolPayments`, memo board live, `gloamroll1:` proofs |
| Ethereum | `ethereum-mainnet` | `ShieldPoolPayments`, memo board live, `gloamroll1:` proofs |
| Elysium | `elysium-mainnet` | `ShieldPoolPayments`, memo board live, `gloamroll1:` proofs |
| BNB Chain | `bnb-mainnet` | `ShieldPoolPayments`, memo board live; pass an archive `--rpc` / `GLOAM_RPC` (public BNB RPCs prune logs) |
| Solana | `solana` / `solana-mainnet` | Helius Privacy Rings via `@gloamtrade/sdk/solana` (`SOL`, `USDC`, `USDT`, `ZEC`; no `gloamroll1:` proofs) |
| Testnets | `robinhood`, `tempo`, `base`, `ethereum`, `solana-devnet` | For testing before mainnet runs |

---

## CSV Formats

Comma, semicolon, and tab delimiters are auto-detected from line 1. Header rows are optional. Up to 200 rows per run.

### EVM CSV (`name,gloam_address,amount[,note]`)

```csv
name,gloam_address,amount,note
Ada Obi,gloamr1.PASTE_RECEIVE_TAG,1250,November salary
Yomi Ade,@yomi,980,Design retainer
Tunde Bello,,850,Contractor invoice
```

- **`gloamr1.…`**: Payment note is sealed via P-256 ECDH (`gloam2t.`) and posted to `GloamPayMemo` so it lands automatically in the recipient's Gloam app.
- **`@name`**: Resolved on-chain via `GloamNames` (`0x62c435CE6886fa91e3b0e91500c6dC9219723457` on Robinhood Chain mainnet) to the holder's `gloamr1.` address, with Gloam's reserved/impersonation name blocklist applied.
- **Blank**: Generates a compact `https://gloam.trade/c#...` short claim link in `runs/<id>.payouts.csv`.
- **Public `0x…` address**: Refused on purpose so amounts are never exposed on-chain.

### Solana CSV (`name,address,amount`)

```csv
name,address,amount
Ada Obi,So1anaPrivateAccountAddressHere...,1250
Tunde Bello,AnotherRegisteredPrivateAddress...,980
```

Each recipient must be a registered Gloam private account on Solana Privacy Rings (verified on-chain before any payment is sent).

---

## Commands & Environment Variables

| Command | Purpose |
| --- | --- |
| `plan <csv>` | Validate CSV, resolve `@names`, check limits/caps, print plan (`--json`, `--offline`) |
| `run <csv>` | Execute private payroll on EVM or Solana and write `*.run.json` + `*.payouts.csv` |
| `resume <run.json>` | Reconcile in-flight rows against chain state, finish unpaid rows, retry unposted memos |
| `status <run.json>` | Inspect run progress and row states without exposing secrets (`--json`) |
| `prove <run.json> --for <who>` | Generate a `gloamroll1:` payroll total proof (`--days`, `--out`, `--allow-partial`, `--json`) |
| `verify-token <token\|file>` | Offline-check a `gloamroll1:` bundle (`--snark` for Groth16 pairing check, `--json`) |
| `networks` | List live EVM and Solana networks, vaults, assets, and caps (`--json`) |
| `new-receive-key` | Generate a test `gloamr1.` receive tag and private JWK |

Environment variables:

- `GLOAM_PAY_KEY` — EVM funding/signing private key (`0x…`, not needed when using `--funding-note` + relay).
- `GLOAM_SOLANA_KEY` — Solana main wallet secret (base58, JSON byte array, or keypair file path).
- `GLOAM_NETWORK` / `GLOAM_ASSET` — Default `--network` / `--asset`.
- `GLOAM_RPC` / `GLOAM_RELAY_URL` / `GLOAM_NAMES_RPC` / `GLOAM_SOLANA_URL` — Endpoint overrides.
- `GLOAM_CIRCUITS_CACHE` — Override circuit cache directory (default `~/.cache/gloam/circuits`).

---

## Security & Operational Checklist

- `runs/*.run.json` holds private note openings (`0600`) and `runs/*.payouts.csv` holds bearer claim links (`0600`). Keep both private and never upload them as public CI artifacts.
- Exported CSV cells starting with `=`, `+`, `-`, `@`, `\t`, or `\r` are prefixed with `'` to prevent spreadsheet formula injection.
- Circuit `.wasm`, `.zkey`, and `payroll_total_vkey.json` files are SHA-256 verified against pinned digests and written atomically.
- See [SECURITY.md](./SECURITY.md) for the full threat model and vulnerability reporting.

## Development

```bash
pnpm typecheck
pnpm build
pnpm test
```

## License

[MIT](./LICENSE) © 2026 Olu (`Olalolo22`).
