import { task } from "hardhat/config";

/// Print the deployed Hushpot + cUSDT addresses for the current network.
task("hushpot:address", "Prints the deployed Hushpot and cUSDT addresses", async (_args, hre) => {
  const { deployments } = hre;
  const hushpot = await deployments.getOrNull("Hushpot");
  if (!hushpot) {
    console.log(`No Hushpot deployment found on ${hre.network.name}. Run: npx hardhat deploy --network ${hre.network.name}`);
    return;
  }
  console.log(`network : ${hre.network.name}`);
  console.log(`Hushpot : ${hushpot.address}`);
  const token = await deployments.getOrNull("MockERC7984");
  if (token) console.log(`cUSDT*  : ${token.address} (local mock)`);
});

/// Print a circle's public parameters and round state.
task("hushpot:circle", "Prints a circle's public state")
  .addParam("id", "Circle id")
  .setAction(async (args, hre) => {
    const { deployments, ethers } = hre;
    const dep = await deployments.get("Hushpot");
    const hushpot = await ethers.getContractAt("Hushpot", dep.address);
    const c = await hushpot.getCircle(args.id);
    const states = ["OPEN", "BIDDING", "RESOLVING", "SETTLED"];
    console.log({
      members: c.members,
      contribution: c.contribution.toString(),
      collateral: c.collateral.toString(),
      feeBps: Number(c.feeBps),
      totalRounds: Number(c.totalRounds),
      currentRound: Number(c.currentRound),
      roundDeadline: Number(c.roundDeadline),
      state: states[Number(c.state)],
      active: c.active,
      completed: c.completed,
    });
  });
