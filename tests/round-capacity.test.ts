import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import {
  findLargestCycleRound,
  findLargestOverallRound,
  measureClearingRoundCapacity,
} from "../scripts/lib/clearing-round-capacity";

describe("Clearing round capacity sizing", function () {
  this.timeout(30_000);
  const programId = new PublicKey("11111111111111111111111111111111");
  const maxParticipants = 16;

  it("shows the current compact self-contained Ed25519 path fits a 3-party cycle", () => {
    const threeParticipantCycle = measureClearingRoundCapacity({
      programId,
      mode: "current-ed25519",
      participantCount: 3,
      channelCount: 3,
    });

    expect(threeParticipantCycle.fits).to.equal(true);
  });

  it("shows v0 + ALT improves current clearing-round capacity before BLS", () => {
    const currentOverall = findLargestOverallRound({
      programId,
      mode: "current-ed25519",
      maxParticipants,
    });
    const currentV0AltOverall = findLargestOverallRound({
      programId,
      mode: "current-ed25519-v0-alt",
      maxParticipants,
    });

    expect(currentV0AltOverall.fits).to.equal(true);
    expect(currentV0AltOverall.channelCount).to.be.greaterThan(
      currentOverall.channelCount
    );
  });

  it("shows aggregate-signature sizing materially increases round capacity", () => {
    const currentCycle = findLargestCycleRound({
      programId,
      mode: "current-ed25519",
      maxParticipants,
    });
    const blsCycle = findLargestCycleRound({
      programId,
      mode: "hypothetical-bls",
      maxParticipants,
    });
    const currentOverall = findLargestOverallRound({
      programId,
      mode: "current-ed25519",
      maxParticipants,
    });
    const blsOverall = findLargestOverallRound({
      programId,
      mode: "hypothetical-bls",
      maxParticipants,
    });
    const blsV0AltOverall = findLargestOverallRound({
      programId,
      mode: "hypothetical-bls-v0-alt",
      maxParticipants,
    });

    expect(currentCycle.fits).to.equal(true);
    expect(blsCycle.fits).to.equal(true);
    expect(blsCycle.participantCount).to.be.greaterThan(
      currentCycle.participantCount
    );
    expect(blsOverall.fits).to.equal(true);
    expect(blsOverall.channelCount).to.be.greaterThan(
      currentOverall.channelCount
    );
    expect(blsV0AltOverall.channelCount).to.be.greaterThan(
      blsOverall.channelCount
    );
  });
});
