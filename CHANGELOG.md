# Changelog

All notable changes to `gloam-payroll-cli` are documented here.

## 0.2.1 (25 November 2026)

- **Upgraded `@gloamtrade/sdk` to `0.9.1`**: Adds **ZEC** (Zcash bridged to Solana by NEAR's Omni Bridge, 8 decimals) on Solana mainnet across `networks`, `plan`, `run`, and `resume`.
- **Asset notices in `plan` and `networks`**: Displays `asset.note` (such as what stays public when bridging/adding ZEC on Solana) in both text and `--json` output.

## 0.2.0 (23 November 2026)

### Safety & Crash-Recovery Fixes
- **Same-payment re-proving on `resume`**: Retrying an `unconfirmed` EVM row now re-proves the exact same `(spend -> payment, change)` outputs against a fresh Merkle path (matching official Gloam's `samePaymentWitness`) instead of generating new secrets and overwriting an in-flight payment or change note.
- **Shield-deposit crash & revert recovery**: Reconciles an unconfirmed `activeNote` against `commitmentSeen` and receipt status on `resume`, clearing failed/unbroadcast shield attempts cleanly instead of stranding the ledger.
- **RPC lag & network-drop resilience**: Retries Merkle tree sync with backoff after mined transactions, keeps ambiguous relay/network drops `unconfirmed` so `resume` always checks on-chain first, confirms `commitmentSeen` after receipts, and retries unposted `GloamPayMemo` notices on `resume`.
- **Spreadsheet formula-injection protection**: Payout CSV exports now neutralize cells starting with `=`, `+`, `-`, `@`, `\t`, or `\r` with a leading `'` (matching official Gloam).
- **Strict CLI argument parsing**: Switched to Node's built-in `util.parseArgs`, fixing a bug where boolean flags before positional arguments (such as `run --direct list.csv`) consumed filenames, and rejecting mistyped flags loudly.
- **Atomic circuit cache writes**: Downloads into `~/.cache/gloam/circuits` now write to a temp file before atomic rename.
- **Partial-proof guard**: `prove` now refuses unfinished EVM runs unless `--allow-partial` is explicitly passed.

### Parity with Official Gloam & SDK `0.9.0`
- **Gloam `@name` payees**: EVM CSVs now support `@name` recipients (e.g. `@ada`) and `gloam_name` / `gloam name` headers, resolved against `GloamNames` on Robinhood Chain mainnet (`4663`) with official blocked-name protection and explicit refusal of public `0x` wallet addresses.
- **Solana private payroll (`--network solana` / `solana-devnet`)**: Built on `@gloamtrade/sdk/solana` (Helius Privacy Rings) with pre-flight recipient registration checks, automatic balance top-up (or `--no-add`), relay rate-limit pacing, crash-safe `resume` via `solanaTxStatus`, and payout CSV export.
- **Script & CI commands**: Added `status <run.json>`, `networks`, `--json` output mode, `--offline` plan mode, `--version`, compiled `dist/` build, and `gloam-payroll` CLI binary entry.
- **Upgraded `@gloamtrade/sdk`** to `^0.9.0` with dynamic network discovery and clear archive-RPC guidance for BNB Chain `PrunedLogsError`.

### Repository Polish
- Added MIT `LICENSE`, `SECURITY.md`, `CHANGELOG.md`, and GitHub Actions CI (Node 20 & 22).

## 0.1.0 (22 November 2026)

- Initial headless EVM private CSV payroll runner (`plan`, `run`, `resume`, `prove`, `verify-token`, `new-receive-key`) and `gloamroll1:` total-proof CLI upgraded to `@gloamtrade/sdk` `0.8.2`.
