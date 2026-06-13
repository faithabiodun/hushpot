// Zama relayer-SDK wrapper: WASM init, instance creation, encrypted inputs, and decryption.
// All FHE plumbing lives here so the React layer only deals with bigints and handles.

import { initSDK, createInstance, SepoliaConfig, type FhevmInstance } from "@zama-fhe/relayer-sdk/web";
import { ethers } from "ethers";

let instance: FhevmInstance | null = null;
let initPromise: Promise<FhevmInstance> | null = null;

/// Initialise the SDK (loads the TFHE/KMS WASM once) and create a Sepolia-configured instance.
export async function getFheInstance(): Promise<FhevmInstance> {
  if (instance) return instance;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await initSDK(); // loads WASM
    const eth = (window as unknown as { ethereum?: unknown }).ethereum;
    // SepoliaConfig omits `network`; supply the injected EIP-1193 provider.
    const config = { ...SepoliaConfig, network: eth } as Parameters<typeof createInstance>[0];
    const created = await createInstance(config);
    instance = created;
    return created;
  })();

  return initPromise;
}

/// Encrypt a single euint64 value bound to (contract, user). Returns the input handle + proof.
/// The handle binds to ONE contract — Hushpot — which calls FHE.fromExternal itself.
export async function encryptU64(
  contractAddress: string,
  userAddress: string,
  value: bigint,
): Promise<{ handle: string; proof: string }> {
  const fhe = await getFheInstance();
  const input = fhe.createEncryptedInput(contractAddress, userAddress);
  input.add64(value);
  const enc = await input.encrypt();
  return {
    handle: ethers.hexlify(enc.handles[0]),
    proof: ethers.hexlify(enc.inputProof),
  };
}

/// Public-decrypt a single handle (e.g. the winner index after resolveRound). Returns the clear
/// value plus the ABI-encoded cleartexts and KMS proof needed by finalizeRound on-chain.
export async function publicDecryptOne(handle: string): Promise<{
  clear: bigint;
  decryptionProof: string;
}> {
  const fhe = await getFheInstance();
  const res = await fhe.publicDecrypt([handle]);
  const clear = res.clearValues[handle as `0x${string}`];
  return {
    clear: typeof clear === "bigint" ? clear : BigInt(clear as unknown as number),
    decryptionProof: res.decryptionProof,
  };
}

/// User-decrypt a handle the caller is ACL-authorised for (e.g. the pot, once they've won, or their
/// own cUSDT balance). Uses an EIP-712 signature over a freshly generated keypair.
export async function userDecryptU64(
  handle: string,
  contractAddress: string,
  signer: ethers.Signer,
): Promise<bigint> {
  const fhe = await getFheInstance();
  const userAddress = await signer.getAddress();

  const keypair = fhe.generateKeypair();
  const startTimestamp = Math.floor(Date.now() / 1000).toString();
  const durationDays = "1";
  const contracts = [contractAddress];

  const eip712 = fhe.createEIP712(keypair.publicKey, contracts, Number(startTimestamp), Number(durationDays));
  const signature = await (signer as ethers.JsonRpcSigner).signTypedData(
    eip712.domain,
    // ethers wants a mutable TypedDataField[]; the SDK types it readonly.
    { UserDecryptRequestVerification: [...eip712.types.UserDecryptRequestVerification] },
    eip712.message,
  );

  const results = await fhe.userDecrypt(
    [{ handle, contractAddress }],
    keypair.privateKey,
    keypair.publicKey,
    signature.replace(/^0x/, ""),
    contracts,
    userAddress,
    Number(startTimestamp),
    Number(durationDays),
  );

  const value = (results as Record<string, unknown>)[handle];
  return typeof value === "bigint" ? value : BigInt(value as number);
}

/// True if a handle is the all-zero (uninitialised) ciphertext — useful before any pot is funded.
export function isZeroHandle(handle: string): boolean {
  return /^0x0+$/.test(handle);
}
