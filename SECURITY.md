# Security Policy

## Scope & Ownership

`gloam-payroll-cli` is an independent community tool built on [`@gloamtrade/sdk`](https://www.npmjs.com/package/@gloamtrade/sdk) and maintained by its author (**Olu / Olalolo22**), not by the Gloam team.

Read the source code and test on a testnet or with small amounts before running mainnet payroll with real funds.

## Secret & File Handling

Running payroll handles sensitive material on your machine or CI runner:

- **`GLOAM_PAY_KEY`** (EVM) and **`GLOAM_SOLANA_KEY`** (Solana): Pass via environment variables or a secret manager — never commit them to git or pass them in shell history where avoidable.
- **`runs/*.run.json`**: Contains unencrypted note secrets (`activeNote.secret`, `paymentSecret`, `changeSecret`, `spendSecret`) needed for crash-safe resume and `gloamroll1:` total proofs. Written atomically with `0600` permissions and excluded in `.gitignore`. **Never commit or upload `*.run.json` as public CI build artifacts.**
- **`runs/*.payouts.csv`**: Contains bearer short claim links (`https://gloam.trade/c#...`) for blank-address payees. Anyone with a claim link can claim those funds until the recipient secures them. Written with `0600` permissions and spreadsheet formula-injection neutralization (`'` prefix on `=`, `+`, `-`, `@`, `\t`, `\r`).
- **Circuit artifacts (`~/.cache/gloam/circuits`)**: Verified against SHA-256 hashes pinned in `@gloamtrade/sdk` (`CIRCUIT_SHA256`) and `src/artifacts.ts` before proving or verifying, and written atomically.

## Reporting a Vulnerability

Please report security issues privately using GitHub Security Advisories:

https://github.com/Olalolo22/gloam-payroll-cli/security/advisories/new

Please do **not** open a public GitHub issue for an undisclosed vulnerability. Include reproduction steps, affected command/network, and impact.

For vulnerabilities in the Gloam contracts, circuits, relay, or `@gloamtrade/sdk` itself, see [gloamtrade/gloam `SECURITY.md`](https://github.com/gloamtrade/gloam/blob/main/SECURITY.md).
