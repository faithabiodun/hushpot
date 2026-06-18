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

/// Fund an address with confidential cUSDT on Sepolia by minting the underlying
/// mock USDT, approving the wrapper, and wrapping it. The wrapper is Zama's
/// ConfidentialWrapperV3 at the cUSDT proxy; wrap(to, amount) deposits the
/// plaintext ERC-20 amount and credits an encrypted (confidential) balance.
task("hushpot:get-cusdt", "Mints mock USDT and wraps it into confidential cUSDT")
  .addOptionalParam("amount", "Human cUSDT amount to obtain (6 decimals)", "1000")
  .addOptionalParam("to", "Recipient address (defaults to the first signer)")
  .setAction(async (args, hre) => {
    const { ethers } = hre;

    // Sepolia cUSDT wrapper (proxy) and its underlying mock USDT, discovered on-chain.
    const CUSDT = "0x4E7B06D78965594eB5EF5414c357ca21E1554491";
    const UNDERLYING = "0xa7dA08FafDC9097Cc0E7D4f113A61e31d7e8e9b0";
    const DECIMALS = 6;

    const [signer] = await ethers.getSigners();
    const to = (args.to as string) || (await signer.getAddress());
    const amount = ethers.parseUnits(args.amount, DECIMALS);

    const usdt = new ethers.Contract(
      UNDERLYING,
      [
        "function mint(address,uint256)",
        "function approve(address,uint256) returns (bool)",
        "function allowance(address,address) view returns (uint256)",
        "function balanceOf(address) view returns (uint256)",
      ],
      signer,
    );
    const wrapper = new ethers.Contract(CUSDT, ["function wrap(address,uint256)"], signer);

    console.log(`network   : ${hre.network.name}`);
    console.log(`signer    : ${await signer.getAddress()}`);
    console.log(`recipient : ${to}`);
    console.log(`amount    : ${args.amount} cUSDT (${amount} base units)`);

    console.log("1/3 minting mock USDT…");
    await (await usdt.mint(to, amount)).wait();
    console.log(`    USDT balance: ${ethers.formatUnits(await usdt.balanceOf(to), DECIMALS)}`);

    console.log("2/3 approving the wrapper…");
    await (await usdt.approve(CUSDT, amount)).wait();

    console.log("3/3 wrapping into confidential cUSDT…");
    await (await wrapper.wrap(to, amount)).wait();

    console.log("done. cUSDT is confidential, so the balance is encrypted on-chain.");
    console.log(`Confirm in the wallet/app once connected. cUSDT: ${CUSDT}`);
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
