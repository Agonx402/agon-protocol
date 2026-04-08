import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";

import {
  CURRENT_COMMITMENT_V4_TYPICAL_MESSAGE_BYTES,
  findLargestBundleSettlementEntryCount,
  LEGACY_COMMITMENT_V2_MESSAGE_BYTES,
  measureIndividualSettlementCapacity,
} from "../scripts/lib/unilateral-settlement-capacity";

describe("Unilateral settlement capacity sizing", function () {
  this.timeout(10_000);
  const programId = new PublicKey("11111111111111111111111111111111");

  it("shows current unilateral v4 shrinks individual settlement bytes versus legacy v2", () => {
    const legacy = measureIndividualSettlementCapacity({
      programId,
      messageBytes: LEGACY_COMMITMENT_V2_MESSAGE_BYTES,
    });
    const current = measureIndividualSettlementCapacity({
      programId,
      messageBytes: CURRENT_COMMITMENT_V4_TYPICAL_MESSAGE_BYTES,
    });

    expect(legacy.fits).to.equal(true);
    expect(current.fits).to.equal(true);
    expect(current.serializedTxBytes).to.be.lessThan(legacy.serializedTxBytes);
  });

  it("shows current unilateral v4 lets more commitments fit in one v0+ALT bundle than legacy v2", () => {
    const legacy = findLargestBundleSettlementEntryCount({
      programId,
      messageBytes: LEGACY_COMMITMENT_V2_MESSAGE_BYTES,
    });
    const current = findLargestBundleSettlementEntryCount({
      programId,
      messageBytes: CURRENT_COMMITMENT_V4_TYPICAL_MESSAGE_BYTES,
    });

    expect(legacy.fits).to.equal(true);
    expect(current.fits).to.equal(true);
    expect(current.entryCount).to.be.greaterThan(legacy.entryCount);
  });
});
