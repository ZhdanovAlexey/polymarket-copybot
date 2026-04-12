import { config } from '../src/config.js';

async function main() {
  const { ethers } = await import('ethers');

  const privateKey = config.privateKey;
  if (!privateKey) {
    console.log('No PRIVATE_KEY configured');
    return;
  }

  const wallet = new ethers.Wallet(privateKey);
  const provider = new ethers.providers.JsonRpcProvider(config.polygonRpcUrl);

  const address = wallet.address;
  const maticBalance = ethers.utils.formatEther(await provider.getBalance(address));

  const usdcAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
  const erc20Abi = ['function balanceOf(address) view returns (uint256)'];
  const usdc = new ethers.Contract(usdcAddress, erc20Abi, provider);
  const usdcBalance = ethers.utils.formatUnits(await usdc.balanceOf(address), 6);

  console.log(`Address: ${address}`);
  console.log(`MATIC: ${maticBalance}`);
  console.log(`USDC.e: ${usdcBalance}`);
}

main().catch(console.error);
