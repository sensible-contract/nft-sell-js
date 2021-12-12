import { Provider, Utxo } from "@sensible-contract/abstract-provider";
import * as bsv from "@sensible-contract/bsv";
import { BN } from "@sensible-contract/bsv";
import { NftInput, NftSigner } from "@sensible-contract/nft-js";
import { NftFactory } from "@sensible-contract/nft-js/lib/contract-factory/nft";
import {
  NftUnlockContractCheck,
  NftUnlockContractCheckFactory,
  NFT_UNLOCK_CONTRACT_TYPE,
} from "@sensible-contract/nft-js/lib/contract-factory/nftUnlockContractCheck";
import * as nftProto from "@sensible-contract/nft-js/lib/contract-proto/nft.proto";
import { ContractUtil } from "@sensible-contract/nft-js/lib/contractUtil";
import {
  getRabinDatas,
  PLACE_HOLDER_PUBKEY,
  PLACE_HOLDER_SIG,
  Prevouts,
  SizeTransaction,
  Utils,
} from "@sensible-contract/sdk-core";
import {
  Bytes,
  PubKey,
  Ripemd160,
  Sig,
  SigHashPreimage,
  toHex,
} from "@sensible-contract/sdk-core/lib/scryptlib";
import { TxComposer } from "@sensible-contract/tx-composer";
import {
  NftSell,
  NftSellFactory,
  NFT_SELL_OP,
} from "./contract-factory/nftSell";
const Signature = bsv.crypto.Signature;
export const sighashType = Signature.SIGHASH_ALL | Signature.SIGHASH_FORKID;

type SellUtxo = {
  txId: string;
  outputIndex: number;
  sellerAddress: string;
  satoshisPrice: number;
};
type SellInput = {
  txId: string;
  outputIndex: number;
  sellerAddress: bsv.Address;
  satoshisPrice: number;
  lockingScript?: bsv.Script;
  txHex?: string;

  codehash: string;
  genesis: string;
  tokenIndex: string;
};

export async function getSellInput(
  provider: Provider,
  {
    codehash,
    genesis,
    tokenIndex,
    sellUtxo,
  }: {
    codehash: string;
    genesis: string;
    tokenIndex: string;
    sellUtxo: SellUtxo;
  }
) {
  let txHex = await provider.getRawTx(sellUtxo.txId);

  let tx = new bsv.Transaction(txHex);
  let lockingScript = tx.outputs[sellUtxo.outputIndex].script;
  let sellInput: SellInput = {
    txId: sellUtxo.txId,
    outputIndex: sellUtxo.outputIndex,
    sellerAddress: new bsv.Address(sellUtxo.sellerAddress, provider.network),
    satoshisPrice: sellUtxo.satoshisPrice,
    txHex,
    lockingScript,
    codehash,
    genesis,
    tokenIndex,
  };

  let nftSellContract = NftSellFactory.createContract(
    new Ripemd160(toHex(sellInput.sellerAddress.hashBuffer)),
    sellInput.satoshisPrice,
    new Bytes(ContractUtil.tokenCodeHash),
    new Bytes(toHex(nftProto.getNftID(sellInput.lockingScript.toBuffer())))
  );
  nftSellContract.setFormatedDataPart({
    codehash: sellInput.codehash,
    genesis: sellInput.genesis,
    tokenIndex: BN.fromString(sellInput.tokenIndex, 10),
    sellerAddress: toHex(sellInput.sellerAddress.hashBuffer),
    satoshisPrice: BN.fromNumber(sellInput.satoshisPrice),
    nftID: toHex(nftProto.getNftID(sellInput.lockingScript.toBuffer())),
  });
  return { sellInput, nftSellContract };
}

export async function createNftSellContractTx({
  nftInput,
  satoshisPrice,
  opreturnData,
  utxos,
  changeAddress,
}: {
  nftInput: NftInput;
  satoshisPrice: number;
  opreturnData?: any;
  utxos: Utxo[];
  changeAddress?: string;
}): Promise<{
  nftSellContract: NftSell;
  txComposer: TxComposer;
  sellAddress: string;
}> {
  if (!changeAddress) {
    changeAddress = utxos[0].address;
  }

  if (utxos.length > 3) {
    throw new Error(
      "Bsv utxos should be no more than 3 in this operation, please merge it first "
    );
  }

  let network = new bsv.Address(utxos[0].address).network.alias;

  let nftSellContract = NftSellFactory.createContract(
    new Ripemd160(toHex(nftInput.nftAddress.hashBuffer)),
    satoshisPrice,
    new Bytes(ContractUtil.tokenCodeHash),
    new Bytes(nftInput.nftID)
  );
  nftSellContract.setFormatedDataPart({
    codehash: nftInput.codehash,
    genesis: nftInput.genesis,
    tokenIndex: BN.fromString(nftInput.tokenIndex, 10),
    sellerAddress: toHex(nftInput.nftAddress.hashBuffer),
    satoshisPrice: BN.fromNumber(satoshisPrice),
    nftID: nftInput.nftID,
  });

  const txComposer = new TxComposer();

  const p2pkhInputIndexs = utxos.map((utxo) => {
    const inputIndex = txComposer.appendP2PKHInput(utxo);
    txComposer.addInputInfo({
      inputIndex,
      address: utxo.address.toString(),
      sighashType,
    });
    return inputIndex;
  });

  const nftSellOutputIndex = txComposer.appendOutput({
    lockingScript: nftSellContract.lockingScript,
    satoshis: txComposer.getDustThreshold(
      nftSellContract.lockingScript.toBuffer().length
    ),
  });

  if (opreturnData) {
    txComposer.appendOpReturnOutput(opreturnData);
  }

  let changeOutputIndex = txComposer.appendChangeOutput(changeAddress);

  let sellAddress = new bsv.Address(
    Utils.getScriptHashBuf(nftSellContract.lockingScript.toBuffer()),
    network
  ).toString();

  return {
    nftSellContract,
    txComposer,
    sellAddress,
  };
}

createNftSellContractTx.estimateFee = function ({
  utxoMaxCount = 10,
  opreturnData,
}: {
  utxoMaxCount?: number;
  opreturnData?: any;
}) {
  let p2pkhInputNum = utxoMaxCount;

  let stx = new SizeTransaction();

  for (let i = 0; i < p2pkhInputNum; i++) {
    stx.addP2PKHInput();
  }
  stx.addOutput(NftSellFactory.getLockingScriptSize());
  if (opreturnData) {
    stx.addOpReturnOutput(
      bsv.Script.buildSafeDataOut(opreturnData).toBuffer().length
    );
  }
  stx.addP2PKHOutput();

  return stx.getFee();
};

export async function createCancelSellNftTx({
  nftSigner,
  nftInput,
  nftSellContract,
  nftSellTxComposer,

  nftUnlockCheckContract,
  nftUnlockCheckTxComposer,

  opreturnData,
  utxos,
  changeAddress,
}: {
  nftSigner: NftSigner;
  nftInput: NftInput;

  nftSellContract: NftSell;
  nftSellTxComposer: TxComposer;

  nftUnlockCheckContract: NftUnlockContractCheck;
  nftUnlockCheckTxComposer: TxComposer;

  opreturnData?: any;
  utxos?: any[];
  changeAddress?: string;
}) {
  if (!changeAddress) {
    changeAddress = utxos[0].address;
  }

  if (utxos.length > 3) {
    throw new Error(
      "Bsv utxos should be no more than 3 in this operation, please merge it first "
    );
  }

  let network = new bsv.Address(utxos[0].address).network.alias;

  let sellerAddress = bsv.Address.fromPublicKeyHash(
    Buffer.from(nftSellContract.getFormatedDataPart().sellerAddress, "hex"),
    network as any
  );

  let nftSellUtxo = {
    txId: nftSellTxComposer.getTxId(),
    outputIndex: 0,
    satoshis: nftSellTxComposer.getOutput(0).satoshis,
    lockingScript: nftSellTxComposer.getOutput(0).script,
  };

  let unlockCheckUtxo = {
    txId: nftUnlockCheckTxComposer.getTxId(),
    outputIndex: 0,
    satoshis: nftUnlockCheckTxComposer.getOutput(0).satoshis,
    lockingScript: nftUnlockCheckTxComposer.getOutput(0).script,
  };

  let {
    rabinDatas,
    checkRabinData,
    rabinPubKeyIndexArray,
    rabinPubKeyVerifyArray,
  } = await getRabinDatas(nftSigner.signers, nftSigner.signerSelecteds, [
    nftInput.satotxInfo,
  ]);

  const txComposer = new TxComposer();
  let prevouts = new Prevouts();

  const nftSellInputIndex = txComposer.appendInput(nftSellUtxo);
  prevouts.addVout(nftSellUtxo.txId, nftSellUtxo.outputIndex);
  txComposer.addInputInfo({
    inputIndex: nftSellInputIndex,
    address: sellerAddress.toString(),
    sighashType,
  });
  const nftInputIndex = txComposer.appendInput(nftInput);
  prevouts.addVout(nftInput.txId, nftInput.outputIndex);

  const p2pkhInputIndexs = utxos.map((utxo) => {
    const inputIndex = txComposer.appendP2PKHInput(utxo);
    prevouts.addVout(utxo.txId, utxo.outputIndex);
    txComposer.addInputInfo({
      inputIndex,
      address: utxo.address.toString(),
      sighashType,
    });
    return inputIndex;
  });

  const unlockCheckInputIndex = txComposer.appendInput(unlockCheckUtxo);
  prevouts.addVout(unlockCheckUtxo.txId, unlockCheckUtxo.outputIndex);

  //tx addOutput nft
  const nftScriptBuf = nftInput.lockingScript.toBuffer();
  let dataPartObj = nftProto.parseDataPart(nftScriptBuf);
  dataPartObj.nftAddress = toHex(sellerAddress.hashBuffer);
  const lockingScriptBuf = nftProto.updateScript(nftScriptBuf, dataPartObj);
  const nftOutputIndex = txComposer.appendOutput({
    lockingScript: bsv.Script.fromBuffer(lockingScriptBuf),
    satoshis: txComposer.getDustThreshold(lockingScriptBuf.length),
  });

  //tx addOutput OpReturn
  let opreturnScriptHex = "";
  if (opreturnData) {
    const opreturnOutputIndex = txComposer.appendOpReturnOutput(opreturnData);
    opreturnScriptHex = txComposer
      .getOutput(opreturnOutputIndex)
      .script.toHex();
  }

  //The first round of calculations get the exact size of the final transaction, and then change again
  //Due to the change, the script needs to be unlocked again in the second round
  //let the fee to be exact in the second round
  for (let c = 0; c < 2; c++) {
    txComposer.clearChangeOutput();
    const changeOutputIndex = txComposer.appendChangeOutput(changeAddress);

    const nftContract = NftFactory.createContract(
      nftSigner.unlockContractCodeHashArray
    );
    let dataPartObj = nftProto.parseDataPart(nftInput.lockingScript.toBuffer());
    nftContract.setFormatedDataPart(dataPartObj);
    const unlockingContract = nftContract.unlock({
      txPreimage: new SigHashPreimage(txComposer.getPreimage(nftInputIndex)),
      prevouts: new Bytes(prevouts.toHex()),
      rabinMsg: rabinDatas[0].rabinMsg,
      rabinPaddingArray: rabinDatas[0].rabinPaddingArray,
      rabinSigArray: rabinDatas[0].rabinSigArray,
      rabinPubKeyIndexArray,
      rabinPubKeyVerifyArray,
      rabinPubKeyHashArray: nftSigner.rabinPubKeyHashArray,
      prevNftAddress: new Bytes(toHex(nftInput.preNftAddress.hashBuffer)),
      checkInputIndex: unlockCheckInputIndex,
      checkScriptTx: new Bytes(nftUnlockCheckTxComposer.getRawHex()),
      checkScriptTxOutIndex: 0,
      lockContractInputIndex: nftSellInputIndex,
      lockContractTx: new Bytes(nftSellTxComposer.getRawHex()),
      lockContractTxOutIndex: nftSellUtxo.outputIndex,
      operation: nftProto.NFT_OP_TYPE.UNLOCK_FROM_CONTRACT,
    });

    txComposer
      .getInput(nftInputIndex)
      .setScript(unlockingContract.toScript() as bsv.Script);

    let otherOutputs = Buffer.alloc(0);
    txComposer.getTx().outputs.forEach((output, index) => {
      if (index != nftOutputIndex) {
        let outputBuf = output.toBufferWriter().toBuffer();
        let lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32LE(outputBuf.length);
        otherOutputs = Buffer.concat([otherOutputs, lenBuf, outputBuf]);
      }
    });
    let unlockCall = nftUnlockCheckContract.unlock({
      txPreimage: new SigHashPreimage(
        txComposer.getPreimage(unlockCheckInputIndex)
      ),
      nftInputIndex,
      nftScript: new Bytes(nftInput.lockingScript.toHex()),
      prevouts: new Bytes(prevouts.toHex()),
      rabinMsg: checkRabinData.rabinMsg,
      rabinPaddingArray: checkRabinData.rabinPaddingArray,
      rabinSigArray: checkRabinData.rabinSigArray,
      rabinPubKeyIndexArray,
      rabinPubKeyVerifyArray,
      rabinPubKeyHashArray: nftSigner.rabinPubKeyHashArray,
      nOutputs: txComposer.getTx().outputs.length,
      nftOutputIndex,
      nftOutputAddress: new Bytes(toHex(sellerAddress.hashBuffer)),
      nftOutputSatoshis: txComposer.getOutput(nftOutputIndex).satoshis,
      otherOutputArray: new Bytes(toHex(otherOutputs)),
    });

    txComposer
      .getInput(unlockCheckInputIndex)
      .setScript(unlockCall.toScript() as bsv.Script);

    let unlockCall2 = nftSellContract.unlock({
      txPreimage: new SigHashPreimage(
        txComposer.getPreimage(
          nftSellInputIndex,
          Signature.SIGHASH_SINGLE | Signature.SIGHASH_FORKID
        )
      ),
      nftScript: new Bytes(nftInput.lockingScript.toHex()),
      senderPubKey: new PubKey(
        nftInput.publicKey
          ? toHex(nftInput.publicKey.toBuffer())
          : PLACE_HOLDER_PUBKEY
      ),
      senderSig: new Sig(PLACE_HOLDER_SIG),
      nftOutputSatoshis: txComposer.getOutput(nftOutputIndex).satoshis,
      op: NFT_SELL_OP.CANCEL,
    });

    txComposer
      .getInput(nftSellInputIndex)
      .setScript(unlockCall2.toScript() as bsv.Script);
  }

  return {
    txComposer,
  };
}

createCancelSellNftTx.estimateFee = function ({
  nftInput,
  opreturnData,
  utxoMaxCount = 10,
}: {
  nftInput: NftInput;
  opreturnData?: any;
  utxoMaxCount?: number;
}) {
  let p2pkhInputNum = utxoMaxCount;
  if (p2pkhInputNum > 3) {
    throw new Error("Bsv utxos should be no more than 3 in this operation.");
  }

  let genesisScript = nftInput.preNftAddress.hashBuffer.equals(
    Buffer.alloc(20, 0)
  )
    ? new Bytes(nftInput.preLockingScript.toHex())
    : new Bytes("");

  let stx = new SizeTransaction();

  stx.addInput(
    NftSellFactory.calUnlockingScriptSize(NFT_SELL_OP.CANCEL),
    stx.getDustThreshold(NftSellFactory.getLockingScriptSize())
  );

  stx.addInput(
    NftFactory.calUnlockingScriptSize(
      p2pkhInputNum,
      genesisScript,
      NftSellFactory.createDummyTx().getRawHex(),
      opreturnData,
      nftProto.NFT_OP_TYPE.UNLOCK_FROM_CONTRACT
    ),
    nftInput.satoshis
  );

  for (let i = 0; i < p2pkhInputNum; i++) {
    stx.addP2PKHInput();
  }

  let otherOutputsLen = 0;
  if (opreturnData) {
    otherOutputsLen =
      otherOutputsLen +
      4 +
      8 +
      4 +
      bsv.Script.buildSafeDataOut(opreturnData).toBuffer().length;
  }

  otherOutputsLen = otherOutputsLen + 4 + 8 + 4 + 25;

  let otherOutputs = new Bytes(toHex(Buffer.alloc(otherOutputsLen, 0)));

  stx.addInput(
    NftUnlockContractCheckFactory.calUnlockingScriptSize(
      NFT_UNLOCK_CONTRACT_TYPE.OUT_6,
      stx.inputs.length + 1,
      otherOutputs
    ),
    stx.getDustThreshold(
      NftUnlockContractCheckFactory.getLockingScriptSize(
        NFT_UNLOCK_CONTRACT_TYPE.OUT_6
      )
    )
  );

  stx.addOutput(NftFactory.getLockingScriptSize());

  if (opreturnData) {
    stx.addOpReturnOutput(
      bsv.Script.buildSafeDataOut(opreturnData).toBuffer().length
    );
  }

  stx.addP2PKHOutput();

  return stx.getFee();
};

export async function createBuyNftTx({
  nftSigner,
  nftInput,

  nftSellContract,
  nftSellTxComposer,

  nftUnlockCheckContract,
  nftUnlockCheckTxComposer,

  opreturnData,
  utxos,
  changeAddress,
}: {
  nftSigner: NftSigner;
  nftInput: NftInput;

  nftSellContract: NftSell;
  nftSellTxComposer: TxComposer;

  nftUnlockCheckContract: NftUnlockContractCheck;
  nftUnlockCheckTxComposer: TxComposer;

  buyerPublicKey?: string;
  opreturnData?: any;
  utxos?: Utxo[];
  changeAddress?: string;
}) {
  if (!changeAddress) {
    changeAddress = utxos[0].address;
  }

  if (utxos.length > 3) {
    throw new Error(
      "Bsv utxos should be no more than 3 in this operation, please merge it first "
    );
  }

  let network = new bsv.Address(utxos[0].address).network.alias;
  let nftAddress = new bsv.Address(utxos[0].address, network);

  let nftSellUtxo = {
    txId: nftSellTxComposer.getTxId(),
    outputIndex: 0,
    satoshis: nftSellTxComposer.getOutput(0).satoshis,
    lockingScript: nftSellTxComposer.getOutput(0).script,
  };

  let unlockCheckUtxo = {
    txId: nftUnlockCheckTxComposer.getTxId(),
    outputIndex: 0,
    satoshis: nftUnlockCheckTxComposer.getOutput(0).satoshis,
    lockingScript: nftUnlockCheckTxComposer.getOutput(0).script,
  };

  let {
    rabinDatas,
    checkRabinData,
    rabinPubKeyIndexArray,
    rabinPubKeyVerifyArray,
  } = await getRabinDatas(nftSigner.signers, nftSigner.signerSelecteds, [
    nftInput.satotxInfo,
  ]);

  const txComposer = new TxComposer();
  let prevouts = new Prevouts();

  const nftSellInputIndex = txComposer.appendInput(nftSellUtxo);
  prevouts.addVout(nftSellUtxo.txId, nftSellUtxo.outputIndex);

  const nftInputIndex = txComposer.appendInput(nftInput);
  prevouts.addVout(nftInput.txId, nftInput.outputIndex);

  const p2pkhInputIndexs = utxos.map((utxo) => {
    const inputIndex = txComposer.appendP2PKHInput(utxo);
    prevouts.addVout(utxo.txId, utxo.outputIndex);
    txComposer.addInputInfo({
      inputIndex,
      address: utxo.address.toString(),
      sighashType,
    });
    return inputIndex;
  });

  const unlockCheckInputIndex = txComposer.appendInput(unlockCheckUtxo);
  prevouts.addVout(unlockCheckUtxo.txId, unlockCheckUtxo.outputIndex);

  let sellerAddress = bsv.Address.fromPublicKeyHash(
    Buffer.from(
      nftSellContract.constuctParams.senderAddress.value as string,
      "hex"
    ),
    network as any
  );
  let sellerSatoshis = nftSellContract.constuctParams.bsvRecAmount;
  //tx addOutput sell
  txComposer.appendP2PKHOutput({
    address: sellerAddress,
    satoshis: sellerSatoshis,
  });

  //tx addOutput nft
  const nftScriptBuf = nftInput.lockingScript.toBuffer();
  let dataPartObj = nftProto.parseDataPart(nftScriptBuf);
  dataPartObj.nftAddress = toHex(nftAddress.hashBuffer);
  const lockingScriptBuf = nftProto.updateScript(nftScriptBuf, dataPartObj);
  const nftOutputIndex = txComposer.appendOutput({
    lockingScript: bsv.Script.fromBuffer(lockingScriptBuf),
    satoshis: txComposer.getDustThreshold(lockingScriptBuf.length),
  });

  //tx addOutput OpReturn
  let opreturnScriptHex = "";
  if (opreturnData) {
    const opreturnOutputIndex = txComposer.appendOpReturnOutput(opreturnData);
    opreturnScriptHex = txComposer
      .getOutput(opreturnOutputIndex)
      .script.toHex();
  }

  //The first round of calculations get the exact size of the final transaction, and then change again
  //Due to the change, the script needs to be unlocked again in the second round
  //let the fee to be exact in the second round

  for (let c = 0; c < 2; c++) {
    txComposer.clearChangeOutput();
    const changeOutputIndex = txComposer.appendChangeOutput(changeAddress);

    const nftContract = NftFactory.createContract(
      nftSigner.unlockContractCodeHashArray
    );
    let dataPartObj = nftProto.parseDataPart(nftInput.lockingScript.toBuffer());
    nftContract.setFormatedDataPart(dataPartObj);
    const unlockingContract = nftContract.unlock({
      txPreimage: new SigHashPreimage(txComposer.getPreimage(nftInputIndex)),
      prevouts: new Bytes(prevouts.toHex()),
      rabinMsg: rabinDatas[0].rabinMsg,
      rabinPaddingArray: rabinDatas[0].rabinPaddingArray,
      rabinSigArray: rabinDatas[0].rabinSigArray,
      rabinPubKeyIndexArray,
      rabinPubKeyVerifyArray,
      rabinPubKeyHashArray: nftSigner.rabinPubKeyHashArray,
      prevNftAddress: new Bytes(toHex(nftInput.preNftAddress.hashBuffer)),
      checkInputIndex: unlockCheckInputIndex,
      checkScriptTx: new Bytes(nftUnlockCheckTxComposer.getRawHex()),
      checkScriptTxOutIndex: 0,
      lockContractInputIndex: nftSellInputIndex,
      lockContractTx: new Bytes(nftSellTxComposer.getRawHex()),
      lockContractTxOutIndex: nftSellUtxo.outputIndex,
      operation: nftProto.NFT_OP_TYPE.UNLOCK_FROM_CONTRACT,
    });

    txComposer
      .getInput(nftInputIndex)
      .setScript(unlockingContract.toScript() as bsv.Script);

    let otherOutputs = Buffer.alloc(0);
    txComposer.getTx().outputs.forEach((output, index) => {
      if (index != nftOutputIndex) {
        let outputBuf = output.toBufferWriter().toBuffer();
        let lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32LE(outputBuf.length);
        otherOutputs = Buffer.concat([otherOutputs, lenBuf, outputBuf]);
      }
    });
    let unlockCall = nftUnlockCheckContract.unlock({
      txPreimage: new SigHashPreimage(
        txComposer.getPreimage(unlockCheckInputIndex)
      ),
      nftInputIndex,
      nftScript: new Bytes(nftInput.lockingScript.toHex()),
      prevouts: new Bytes(prevouts.toHex()),
      rabinMsg: checkRabinData.rabinMsg,
      rabinPaddingArray: checkRabinData.rabinPaddingArray,
      rabinSigArray: checkRabinData.rabinSigArray,
      rabinPubKeyIndexArray,
      rabinPubKeyVerifyArray,
      rabinPubKeyHashArray: nftSigner.rabinPubKeyHashArray,
      nOutputs: txComposer.getTx().outputs.length,
      nftOutputIndex,
      nftOutputAddress: new Bytes(toHex(nftAddress.hashBuffer)),
      nftOutputSatoshis: txComposer.getOutput(nftOutputIndex).satoshis,
      otherOutputArray: new Bytes(toHex(otherOutputs)),
    });
    txComposer
      .getInput(unlockCheckInputIndex)
      .setScript(unlockCall.toScript() as bsv.Script);

    let unlockCall2 = nftSellContract.unlock({
      txPreimage: new SigHashPreimage(
        txComposer.getPreimage(
          nftSellInputIndex,
          Signature.SIGHASH_SINGLE | Signature.SIGHASH_FORKID
        )
      ),
      op: NFT_SELL_OP.SELL,
    });
    txComposer
      .getInput(nftSellInputIndex)
      .setScript(unlockCall2.toScript() as bsv.Script);
  }

  return {
    txComposer,
  };
}

createBuyNftTx.estimateFee = function ({
  nftInput,
  sellInput,
  opreturnData,
  utxoMaxCount = 10,
}: {
  nftInput: NftInput;
  sellInput: SellInput;
  opreturnData?: any;
  utxoMaxCount?: number;
}) {
  let p2pkhInputNum = utxoMaxCount;
  if (p2pkhInputNum > 3) {
    throw new Error("Bsv utxos should be no more than 3 in this operation.");
  }

  let genesisScript = nftInput.preNftAddress.hashBuffer.equals(
    Buffer.alloc(20, 0)
  )
    ? new Bytes(nftInput.preLockingScript.toHex())
    : new Bytes("");

  let stx = new SizeTransaction();

  stx.addInput(
    NftSellFactory.calUnlockingScriptSize(NFT_SELL_OP.SELL),
    stx.getDustThreshold(NftSellFactory.getLockingScriptSize())
  );

  stx.addInput(
    NftFactory.calUnlockingScriptSize(
      p2pkhInputNum,
      genesisScript,
      NftSellFactory.createDummyTx().getRawHex(),
      opreturnData,
      nftProto.NFT_OP_TYPE.UNLOCK_FROM_CONTRACT
    ),
    nftInput.satoshis
  );

  for (let i = 0; i < p2pkhInputNum; i++) {
    stx.addP2PKHInput();
  }

  let otherOutputsLen = 0;
  if (opreturnData) {
    otherOutputsLen =
      otherOutputsLen +
      4 +
      8 +
      4 +
      bsv.Script.buildSafeDataOut(opreturnData).toBuffer().length;
  }

  otherOutputsLen = otherOutputsLen + 4 + 8 + 4 + 25;

  let otherOutputs = new Bytes(toHex(Buffer.alloc(otherOutputsLen, 0)));

  stx.addInput(
    NftUnlockContractCheckFactory.calUnlockingScriptSize(
      NFT_UNLOCK_CONTRACT_TYPE.OUT_6,
      stx.inputs.length + 1,
      otherOutputs
    ),
    stx.getDustThreshold(
      NftUnlockContractCheckFactory.getLockingScriptSize(
        NFT_UNLOCK_CONTRACT_TYPE.OUT_6
      )
    )
  );

  stx.addOutput(NftFactory.getLockingScriptSize());

  if (opreturnData) {
    stx.addOpReturnOutput(
      bsv.Script.buildSafeDataOut(opreturnData).toBuffer().length
    );
  }

  stx.addP2PKHOutput();

  return stx.getFee() + sellInput.satoshisPrice;
};
