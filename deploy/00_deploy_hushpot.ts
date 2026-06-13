import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

/// Official Sepolia ERC-7984 confidential USDT wrapper used as Hushpot's money layer.
/// Source: Zama confidential-token deployment (cUSDT). Underlying USDT + registry are documented
/// in the README. Override with the CUSDT_ADDRESS env var if Zama rotates the wrapper.
const SEPOLIA_CUSDT = "0x4E7B06D78965594eB5EF5414c357ca21E1554491";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network, ethers } = hre;
  const { deploy, log } = deployments;
  const { deployer } = await getNamedAccounts();

  // Resolve the confidential token the circles transact in.
  //   - Sepolia (and any non-local net): the real cUSDT wrapper (env override allowed).
  //   - Local hardhat/anvil mock chains: deploy a mintable MockERC7984 faucet first.
  let tokenAddress: string;
  const isLocal = network.name === "hardhat" || network.name === "localhost" || network.name === "anvil";

  if (isLocal) {
    const mock = await deploy("MockERC7984", {
      from: deployer,
      args: ["Confidential USDT Mock", "cUSDT", ""],
      log: true,
    });
    tokenAddress = mock.address;
    log(`MockERC7984 (local cUSDT) at ${tokenAddress}`);
  } else {
    tokenAddress = process.env.CUSDT_ADDRESS ?? SEPOLIA_CUSDT;
    if (!ethers.isAddress(tokenAddress)) {
      throw new Error(`Invalid cUSDT address: ${tokenAddress}`);
    }
    log(`Using cUSDT at ${tokenAddress}`);
  }

  const hushpot = await deploy("Hushpot", {
    from: deployer,
    args: [tokenAddress],
    log: true,
  });

  log(`Hushpot deployed at ${hushpot.address}`);
  log(`  network : ${network.name}`);
  log(`  cUSDT   : ${tokenAddress}`);
  log(`  deployer: ${deployer}`);
};

export default func;
func.id = "deploy_hushpot";
func.tags = ["Hushpot"];
