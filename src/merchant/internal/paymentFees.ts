/**
 * Basis-point denominator of the vault deposit fee. It mirrors
 * `uint96 private constant FEE_DENOMINATOR = 10000` in
 * packages/contracts/evm/src/v2/vault/CurvyVaultV2.sol:29, which is private and so not in the ABI.
 */
export const FEE_DENOMINATOR = 10_000n;

export interface DepositFeeSchedule {
  /** `CurvyVaultV2.depositFee()`, in basis points of the gross deposit. */
  depositFee: bigint;
  /** `perTokenGasFees(tokenId).pendingNoteCommitment`, charged on every shield. */
  pendingNoteCommitment: bigint;
  /** `perTokenGasFees(tokenId).portalDeployment`, charged only on a portal shield. */
  portalDeployment: bigint;
}

/**
 * Net note amount the vault credits for a gross deposit of `grossAmount`, mirroring
 * `CurvyVaultV2._deposit`: `gross - gross * depositFee / 10000 - pendingNoteCommitment
 * (- portalDeployment when isPortalShield)`. Floored at 1 so that a request whose gross
 * amount cannot cover the fees still needs a positive note.
 */
export function minimumNetAmount(grossAmount: bigint, fees: DepositFeeSchedule, portalShield: boolean): bigint {
  const percentageFee = (grossAmount * fees.depositFee) / FEE_DENOMINATOR;
  const gasFees = fees.pendingNoteCommitment + (portalShield ? fees.portalDeployment : 0n);
  const net = grossAmount - percentageFee - gasFees;
  return net < 1n ? 1n : net;
}
