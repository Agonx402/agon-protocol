import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";

import {
  CURRENT_COMMITMENT_V2_MESSAGE_BYTES,
  PROPOSED_COMMITMENT_V3_TYPICAL_MESSAGE_BYTES,
  findLargestBundleSettlementEntryCount,
  measureIndividualSettlementCapacity,
} from "../scripts/lib/unilateral-settlement-capacity";

describe("Unilateral settlement capacity sizing", function () {
  this.timeout(10_000);
  const programId = new PublicKey("11111111111111111111111111111111");

  it("shows unilateral v3 shrinks individual settlement bytes", () => {
    const current = measureIndividualSettlementCapacity({
      programId,
      messageBytes: CURRENT_COMMITMENT_V2_MESSAGE_BYTES,
    });
    const proposed = measureIndividualSettlementCapacity({
      programId,
      messageBytes: PROPOSED_COMMITMENT_V3_TYPICAL_MESSAGE_BYTES,
    });

    expect(current.fits).to.equal(true);
    expect(proposed.fits).to.equal(true);
    expect(proposed.serializedTxBytes).to.be.lessThan(current.serializedTxBytes);
  });

  it("shows unilateral v3 lets more commitments fit in one v0+ALT bundle", () => {
    const current = findLargestBundleSettlementEntryCount({
      programId,
      messageBytes: CURRENT_COMMITMENT_V2_MESSAGE_BYTES,
    });
    const proposed = findLargestBundleSettlementEntryCount({
      programId,
      messageBytes: PROPOSED_COMMITMENT_V3_TYPICAL_MESSAGE_BYTES,
    });

    expect(current.fits).to.equal(true);
    expect(proposed.fits).to.equal(true);
    expect(proposed.entryCount).to.be.greaterThan(current.entryCount);
  });
});
