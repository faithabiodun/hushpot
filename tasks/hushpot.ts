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

    // The wrapper is an FHE contract; the fhevm plugin hooks the call and must be initialized first
    // (otherwise: "The Hardhat Fhevm plugin is not initialized").
    await hre.fhevm.initializeCLIApi();

    // Sepolia cUSDT wrapper (proxy) and its underlying mock USDT, discovered on-chain.
    const CUSDT = "0x4E7B06D78965594eB5EF5414c357ca21E1554491";
    const UNDERLYING = "0xa7dA08FafDC9097Cc0E7D4f113A61e31d7e8e9b0";
    const DECIMALS = 6;

    const [signer] = await ethers.getSigners();
    const signerAddr = await signer.getAddress();
    const to = (args.to as string) || signerAddr;
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
    console.log(`signer    : ${signerAddr}`);
    console.log(`recipient : ${to}`);
    console.log(`amount    : ${args.amount} cUSDT (${amount} base units)`);

    // wrap(to, amount) pulls the underlying from msg.sender (the signer) and credits the encrypted
    // balance to `to`. So the USDT must be minted to the SIGNER, not to `to`.
    console.log("1/3 minting mock USDT to the signer…");
    await (await usdt.mint(signerAddr, amount)).wait();
    console.log(`    signer USDT balance: ${ethers.formatUnits(await usdt.balanceOf(signerAddr), DECIMALS)}`);

    // The mock mimics Tether's approve guard (can't change a non-zero allowance to another non-zero
    // value), so reset to 0 first when there's a stale allowance.
    console.log("2/3 approving the wrapper…");
    const current: bigint = await usdt.allowance(signerAddr, CUSDT);
    if (current !== 0n && current < amount) {
      await (await usdt.approve(CUSDT, 0)).wait();
    }
    if (current < amount) {
      await (await usdt.approve(CUSDT, amount)).wait();
    }

    console.log("3/3 wrapping into confidential cUSDT (credited to the recipient)…");
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
