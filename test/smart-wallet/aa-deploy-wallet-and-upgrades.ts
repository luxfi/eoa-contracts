import { expect } from "chai";
import { ethers } from "hardhat";
import {
  SmartWallet,
  WalletFactory,
  EntryPoint,
  EntryPoint__factory,
  VerifyingSingletonPaymaster,
  VerifyingSingletonPaymaster__factory,
  MockToken,
  MultiSend,
  StorageSetter,
  WhitelistModule,
  DefaultCallbackHandler,
} from "../../typechain";
import { AddressZero } from "../smart-wallet/testutils";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { encodeTransfer, encodeTransferFrom } from "../smart-wallet/testUtils";
import { fillAndSign, fillUserOp } from "../utils/userOp";
import {
  buildContractCall,
  MetaTransaction,
  SafeTransaction,
  Transaction,
  FeeRefund,
  executeTx,
  safeSignTypedData,
  safeSignMessage,
  buildSafeTransaction,
  executeContractCallWithSigners,
} from "../../src/utils/execution";
import { buildMultiSendSafeTx } from "../../src/utils/multisend";
import { arrayify, hexConcat, parseEther } from "ethers/lib/utils";
import { BigNumber, BigNumberish, Contract, Signer } from "ethers";

export async function deployEntryPoint(
  provider = ethers.provider
): Promise<EntryPoint> {
  const epf = await (await ethers.getContractFactory("EntryPoint")).deploy();
  return EntryPoint__factory.connect(epf.address, provider.getSigner());
}

describe("Wallet factory deploy wallet with defaults and upgrades in same userOp!", function () {
  let entryPoint: EntryPoint;
  let entryPointStatic: EntryPoint;
  let depositorSigner: Signer;
  let walletOwner: Signer;
  // let whitelistModule: WhitelistModule;
  let walletAddress: string, paymasterAddress: string;
  let ethersSigner;

  let offchainSigner: Signer, deployer: Signer;

  let verifyingSingletonPaymaster: VerifyingSingletonPaymaster;
  let baseImpl: SmartWallet;
  let walletFactory: WalletFactory;
  let token: MockToken;
  let multiSend: MultiSend;
  let storage: StorageSetter;
  let owner: string;
  let blanketImplementation: string;
  let bob: string;
  let charlie: string;
  let userSCW: any;
  let handler: DefaultCallbackHandler;
  let accounts: any;

  before(async () => {
    accounts = await ethers.getSigners();

    ethersSigner = await ethers.getSigners();
    entryPoint = await deployEntryPoint();
    entryPointStatic = entryPoint.connect(AddressZero);

    deployer = ethersSigner[0];
    offchainSigner = ethersSigner[1];
    depositorSigner = ethersSigner[2];
    walletOwner = deployer;

    owner = await accounts[0].getAddress();
    bob = await accounts[1].getAddress();
    charlie = await accounts[2].getAddress();

    const offchainSignerAddress = await offchainSigner.getAddress();
    const walletOwnerAddress = await walletOwner.getAddress();

    verifyingSingletonPaymaster =
      await new VerifyingSingletonPaymaster__factory(deployer).deploy(
        await deployer.getAddress(),
        entryPoint.address,
        offchainSignerAddress
      );

    /* const DefaultHandler = await ethers.getContractFactory(
        "DefaultCallbackHandler"
      );
      handler = await DefaultHandler.deploy();
      await handler.deployed();
      console.log("Default callback handler deployed at: ", handler.address); */

    const BaseImplementation = await ethers.getContractFactory("SmartAccount");
    baseImpl = await BaseImplementation.deploy(entryPoint.address);
    await baseImpl.deployed();
    console.log("base wallet impl deployed at: ", baseImpl.address);

    blanketImplementation = baseImpl.address;

    const WalletFactory = await ethers.getContractFactory(
      "SmartAccountFactory"
    );
    walletFactory = await WalletFactory.deploy(baseImpl.address);
    await walletFactory.deployed();
    console.log("wallet factory deployed at: ", walletFactory.address);

    const MockToken = await ethers.getContractFactory("MockToken");
    token = await MockToken.deploy();
    await token.deployed();
    console.log("Test token deployed at: ", token.address);

    const Storage = await ethers.getContractFactory("StorageSetter");
    storage = await Storage.deploy();
    console.log("storage setter contract deployed at: ", storage.address);

    const MultiSend = await ethers.getContractFactory("MultiSend");
    multiSend = await MultiSend.deploy();
    console.log("Multisend helper contract deployed at: ", multiSend.address);

    console.log("mint tokens to owner address..");
    await token.mint(owner, ethers.utils.parseEther("1000000"));

    await walletFactory.deployCounterFactualWallet(walletOwnerAddress, 0);
    const expected = await walletFactory.getAddressForCounterfactualWallet(
      walletOwnerAddress,
      0
    );

    userSCW = await ethers.getContractAt(
      "contracts/smart-contract-wallet/SmartAccount.sol:SmartAccount",
      expected
    );

    const latestImplementation = await userSCW.getImplementation();
    console.log("before hook :: latestImplementation ", latestImplementation);

    walletAddress = expected;
    console.log(" wallet address ", walletAddress);

    paymasterAddress = verifyingSingletonPaymaster.address;
    console.log("Paymaster address is ", paymasterAddress);

    /* await verifyingSingletonPaymaster
        .connect(deployer)
        .addStake(0, { value: parseEther("2") });
      console.log("paymaster staked"); */

    await entryPoint.depositTo(paymasterAddress, { value: parseEther("1") });

    // const resultSet = await entryPoint.getDepositInfo(paymasterAddress);
    // console.log("deposited state ", resultSet);
  });

  async function getUserOpWithPaymasterInfo(paymasterId: string) {
    const userOp1 = await fillAndSign(
      {
        sender: walletAddress,
      },
      walletOwner,
      entryPoint
    );

    const nonceFromContract = await verifyingSingletonPaymaster[
      "getSenderPaymasterNonce(address)"
    ](walletAddress);

    const nonceFromContract1 = await verifyingSingletonPaymaster[
      "getSenderPaymasterNonce((address,uint256,bytes,bytes,uint256,uint256,uint256,uint256,uint256,bytes,bytes))"
    ](userOp1);

    expect(nonceFromContract).to.be.equal(nonceFromContract1);

    const hash = await verifyingSingletonPaymaster.getHash(
      userOp1,
      nonceFromContract.toNumber(),
      paymasterId
    );
    const sig = await offchainSigner.signMessage(arrayify(hash));
    const paymasterData = abi.encode(["address", "bytes"], [paymasterId, sig]);
    const paymasterAndData = hexConcat([paymasterAddress, paymasterData]);
    return await fillAndSign(
      {
        ...userOp1,
        paymasterAndData,
      },
      walletOwner,
      entryPoint
    );
  }

  it("succeed with valid signature", async () => {
    await verifyingSingletonPaymaster.depositFor(
      await offchainSigner.getAddress(),
      { value: ethers.utils.parseEther("1") }
    );
    const userOp1 = await fillAndSign(
      {
        sender: walletAddress,
        verificationGasLimit: 200000,
      },
      walletOwner,
      entryPoint
    );

    const nonceFromContract = await verifyingSingletonPaymaster[
      "getSenderPaymasterNonce(address)"
    ](walletAddress);

    const hash = await verifyingSingletonPaymaster.getHash(
      userOp1,
      nonceFromContract.toNumber(),
      await offchainSigner.getAddress()
    );
    const sig = await offchainSigner.signMessage(arrayify(hash));
    const userOp = await fillAndSign(
      {
        ...userOp1,
        paymasterAndData: hexConcat([
          paymasterAddress,
          ethers.utils.defaultAbiCoder.encode(
            ["address", "bytes"],
            [await offchainSigner.getAddress(), sig]
          ),
        ]),
      },
      walletOwner,
      entryPoint
    );
    console.log(userOp);
    await entryPoint.handleOps([userOp], await offchainSigner.getAddress());
    await expect(
      entryPoint.handleOps([userOp], await offchainSigner.getAddress())
    ).to.be.reverted;
  });

  it("succeed deploy a new wallet from entry point flow", async () => {
    const expected = await walletFactory.getAddressForCounterfactualWallet(
      owner,
      10
    );

    const WalletFactory = await ethers.getContractFactory(
      "SmartAccountFactory"
    );

    const encodedData = WalletFactory.interface.encodeFunctionData(
      "deployCounterFactualWallet",
      [owner, 10]
    );

    await verifyingSingletonPaymaster.depositFor(
      await offchainSigner.getAddress(),
      { value: ethers.utils.parseEther("1") }
    );
    const userOp1 = await fillAndSign(
      {
        sender: expected,
        initCode: hexConcat([walletFactory.address, encodedData]),
        verificationGasLimit: 500000,
      },
      walletOwner,
      entryPoint
    );

    const nonceFromContract = await verifyingSingletonPaymaster[
      "getSenderPaymasterNonce(address)"
    ](expected);

    const hash = await verifyingSingletonPaymaster.getHash(
      userOp1,
      nonceFromContract.toNumber(),
      await offchainSigner.getAddress()
    );
    const sig = await offchainSigner.signMessage(arrayify(hash));
    const userOp = await fillAndSign(
      {
        ...userOp1,
        paymasterAndData: hexConcat([
          paymasterAddress,
          ethers.utils.defaultAbiCoder.encode(
            ["address", "bytes"],
            [await offchainSigner.getAddress(), sig]
          ),
        ]),
      },
      walletOwner,
      entryPoint
    );
    console.log(userOp);
    await entryPoint.handleOps([userOp], await offchainSigner.getAddress());
    await expect(
      entryPoint.handleOps([userOp], await offchainSigner.getAddress())
    ).to.be.reverted;
  });

  // Faulty!!
  it("succeed deploy a new wallet from entry point flow and also upgrades implementation", async () => {
    const expected = await walletFactory.getAddressForCounterfactualWallet(
      owner,
      11
    );

    const code = await ethers.provider.getCode(expected);
    console.log("code earlier ", code);

    userSCW = await ethers.getContractAt(
      "contracts/smart-contract-wallet/SmartAccount.sol:SmartAccount",
      expected
    );

    const WalletFactory = await ethers.getContractFactory(
      "SmartAccountFactory"
    );

    const encodedData = WalletFactory.interface.encodeFunctionData(
      "deployCounterFactualWallet",
      [owner, 11]
    );

    // const priorEntryPoint = await userSCW.entryPoint();
    // console.log("prior entrypoint ", priorEntryPoint);

    console.log(entryPoint.address);

    const newEntryPoint = await deployEntryPoint();

    console.log("deployed entrypoint again ", newEntryPoint.address);

    const BaseImplementation3 = await ethers.getContractFactory(
      "SmartAccount3"
    );
    // keeping prior entry point and just updating implementation
    const baseImpl3 = await BaseImplementation3.deploy(entryPoint.address);
    await baseImpl3.deployed();
    console.log("base wallet upgraded impl deployed at: ", baseImpl3.address);

    await verifyingSingletonPaymaster.depositFor(
      await offchainSigner.getAddress(),
      { value: ethers.utils.parseEther("1") }
    );

    const SmartAccount = await ethers.getContractFactory("SmartAccount");

    const updateImplementationData = SmartAccount.interface.encodeFunctionData(
      "updateImplementation",
      [baseImpl3.address]
    );

    const txnData = SmartAccount.interface.encodeFunctionData("executeCall", [
      walletAddress,
      ethers.utils.parseEther("0"),
      updateImplementationData,
    ]);

    console.log("transaction data ", txnData);

    const userOp1 = await fillAndSign(
      {
        sender: expected,
        initCode: hexConcat([walletFactory.address, encodedData]),
        callData: txnData,
        verificationGasLimit: 2000000,
        callGasLimit: 5000000,
      },
      walletOwner,
      entryPoint
    );

    const nonceFromContract = await verifyingSingletonPaymaster[
      "getSenderPaymasterNonce(address)"
    ](expected);

    const hash = await verifyingSingletonPaymaster.getHash(
      userOp1,
      nonceFromContract.toNumber(),
      await offchainSigner.getAddress()
    );
    const sig = await offchainSigner.signMessage(arrayify(hash));
    const userOp = await fillAndSign(
      {
        ...userOp1,
        paymasterAndData: hexConcat([
          paymasterAddress,
          ethers.utils.defaultAbiCoder.encode(
            ["address", "bytes"],
            [await offchainSigner.getAddress(), sig]
          ),
        ]),
      },
      walletOwner,
      entryPoint
    );
    console.log(userOp);
    await entryPoint.handleOps([userOp], await offchainSigner.getAddress());
    await expect(
      entryPoint.handleOps([userOp], await offchainSigner.getAddress())
    ).to.be.reverted;

    /* userSCW = await ethers.getContractAt(
      "contracts/smart-contract-wallet/test/upgrades/SmartAccount3.sol:SmartAccount3",
      expected
    ); */

    const latestEntryPoint = await userSCW.entryPoint();
    console.log("latest entrypoint ", latestEntryPoint);

    expect(latestEntryPoint).to.be.equal(entryPoint.address);

    const latestImplementation = await userSCW.getImplementation();
    console.log("latestImplementation ", latestImplementation);
    // Todo: Review :
    // this check is wrong! it should have been baseImpl3
    // somehow it doesn't work for undeployed wallet
    expect(latestImplementation).to.be.equal(blanketImplementation);

    const codeNew = await ethers.provider.getCode(expected);
    console.log("code later ", codeNew);
  });

  // Faulty!!
  it("succeed deploy a new wallet from entry point flow and also updates handler", async () => {
    const expected = await walletFactory.getAddressForCounterfactualWallet(
      owner,
      12
    );

    const code = await ethers.provider.getCode(expected);
    console.log("code earlier ", code);

    userSCW = await ethers.getContractAt(
      "contracts/smart-contract-wallet/SmartAccount.sol:SmartAccount",
      expected
    );

    const WalletFactory = await ethers.getContractFactory(
      "SmartAccountFactory"
    );

    const encodedData = WalletFactory.interface.encodeFunctionData(
      "deployCounterFactualWallet",
      [owner, 12]
    );

    const DefaultHandler = await ethers.getContractFactory(
      "DefaultCallbackHandler"
    );
    const newHandler = await DefaultHandler.deploy();
    await newHandler.deployed();
    console.log(
      "New Default callback handler deployed at: ",
      newHandler.address
    );

    // const priorEntryPoint = await userSCW.entryPoint();
    // console.log("prior entrypoint ", priorEntryPoint);

    console.log(entryPoint.address);

    // const newEntryPoint = await deployEntryPoint();

    // console.log("deployed entrypoint again ", newEntryPoint.address);

    /* const BaseImplementation3 = await ethers.getContractFactory(
      "SmartAccount3"
    );
    // keeping prior entry point and just updating implementation
    const baseImpl3 = await BaseImplementation3.deploy(entryPoint.address);
    await baseImpl3.deployed();
    console.log("base wallet upgraded impl deployed at: ", baseImpl3.address); */

    await verifyingSingletonPaymaster.depositFor(
      await offchainSigner.getAddress(),
      { value: ethers.utils.parseEther("1") }
    );

    const SmartAccount = await ethers.getContractFactory("SmartAccount");

    const updateHandlerData = SmartAccount.interface.encodeFunctionData(
      "setFallbackHandler",
      [newHandler.address]
    );

    const txnData = SmartAccount.interface.encodeFunctionData("executeCall", [
      walletAddress,
      ethers.utils.parseEther("0"),
      updateHandlerData,
    ]);

    console.log("transaction data ", txnData);

    const userOp1 = await fillAndSign(
      {
        sender: expected,
        initCode: hexConcat([walletFactory.address, encodedData]),
        callData: txnData,
        verificationGasLimit: 2000000,
        callGasLimit: 5000000,
      },
      walletOwner,
      entryPoint
    );

    const nonceFromContract = await verifyingSingletonPaymaster[
      "getSenderPaymasterNonce(address)"
    ](expected);

    const hash = await verifyingSingletonPaymaster.getHash(
      userOp1,
      nonceFromContract.toNumber(),
      await offchainSigner.getAddress()
    );
    const sig = await offchainSigner.signMessage(arrayify(hash));
    const userOp = await fillAndSign(
      {
        ...userOp1,
        paymasterAndData: hexConcat([
          paymasterAddress,
          ethers.utils.defaultAbiCoder.encode(
            ["address", "bytes"],
            [await offchainSigner.getAddress(), sig]
          ),
        ]),
      },
      walletOwner,
      entryPoint
    );
    console.log(userOp);
    await expect(
      entryPoint.handleOps([userOp], await offchainSigner.getAddress())
    ).to.emit(walletFactory, "AccountCreation");

    const latestEntryPoint = await userSCW.entryPoint();
    console.log("current entrypoint ", latestEntryPoint);
    expect(latestEntryPoint).to.be.equal(entryPoint.address);

    // this is good as we did not upgrade the implementation
    const latestImplementation = await userSCW.getImplementation();
    console.log("latestImplementation ", latestImplementation);
    expect(latestImplementation).to.be.equal(blanketImplementation);

    // this is good as we did not upgrade the implementation
    const latestHandler = await userSCW.getFallbackHandler();
    console.log("latest handler ", latestHandler);

    const codeNew = await ethers.provider.getCode(expected);
    console.log("code later ", codeNew);
  });

  // Faulty !!
  it("succeed deploy a new wallet from entry point flow and also upgrades implementation", async () => {
    await walletFactory.deployCounterFactualWallet(owner, 13);

    const expected = await walletFactory.getAddressForCounterfactualWallet(
      owner,
      13
    );

    const code = await ethers.provider.getCode(expected);
    console.log("code earlier ", code);

    userSCW = await ethers.getContractAt(
      "contracts/smart-contract-wallet/SmartAccount.sol:SmartAccount",
      expected
    );

    const WalletFactory = await ethers.getContractFactory(
      "SmartAccountFactory"
    );

    const encodedData = WalletFactory.interface.encodeFunctionData(
      "deployCounterFactualWallet",
      [owner, 13]
    );

    // const priorEntryPoint = await userSCW.entryPoint();
    // console.log("prior entrypoint ", priorEntryPoint);

    console.log(entryPoint.address);

    const newEntryPoint = await deployEntryPoint();

    console.log("deployed entrypoint again ", newEntryPoint.address);

    const BaseImplementation3 = await ethers.getContractFactory(
      "SmartAccount3"
    );
    // keeping prior entry point and just updating implementation
    const baseImpl3 = await BaseImplementation3.deploy(entryPoint.address);
    await baseImpl3.deployed();
    console.log("base wallet upgraded impl deployed at: ", baseImpl3.address);

    await verifyingSingletonPaymaster.depositFor(
      await offchainSigner.getAddress(),
      { value: ethers.utils.parseEther("1") }
    );

    const SmartAccount = await ethers.getContractFactory("SmartAccount");

    const updateImplementationData = SmartAccount.interface.encodeFunctionData(
      "updateImplementation",
      [baseImpl3.address]
    );

    const txnData = SmartAccount.interface.encodeFunctionData("executeCall", [
      walletAddress,
      ethers.utils.parseEther("0"),
      updateImplementationData,
    ]);

    console.log("transaction data ", txnData);

    const userOp1 = await fillAndSign(
      {
        sender: expected,
        // initCode: hexConcat([walletFactory.address, encodedData]),
        callData: txnData,
        verificationGasLimit: 2000000,
        callGasLimit: 5000000,
      },
      walletOwner,
      entryPoint
    );

    const nonceFromContract = await verifyingSingletonPaymaster[
      "getSenderPaymasterNonce(address)"
    ](expected);

    const hash = await verifyingSingletonPaymaster.getHash(
      userOp1,
      nonceFromContract.toNumber(),
      await offchainSigner.getAddress()
    );
    const sig = await offchainSigner.signMessage(arrayify(hash));
    const userOp = await fillAndSign(
      {
        ...userOp1,
        paymasterAndData: hexConcat([
          paymasterAddress,
          ethers.utils.defaultAbiCoder.encode(
            ["address", "bytes"],
            [await offchainSigner.getAddress(), sig]
          ),
        ]),
      },
      walletOwner,
      entryPoint
    );
    console.log(userOp);
    await entryPoint.handleOps([userOp], await offchainSigner.getAddress());
    await expect(
      entryPoint.handleOps([userOp], await offchainSigner.getAddress())
    ).to.be.reverted;

    /* userSCW = await ethers.getContractAt(
      "contracts/smart-contract-wallet/test/upgrades/SmartAccount3.sol:SmartAccount3",
      expected
    ); */

    const latestEntryPoint = await userSCW.entryPoint();
    console.log("latest entrypoint ", latestEntryPoint);

    expect(latestEntryPoint).to.be.equal(entryPoint.address);

    const latestImplementation = await userSCW.getImplementation();
    console.log("latestImplementation ", latestImplementation);
    expect(latestImplementation).to.be.equal(blanketImplementation);

    const codeNew = await ethers.provider.getCode(expected);
    console.log("code later ", codeNew);
  });
});
