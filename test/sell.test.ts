import * as bsv from "@sensible-contract/bsv";
import { BN } from "@sensible-contract/bsv";
import {
  createNftGenesisTx,
  createNftMetaDataTx,
  createNftMintTx,
  createNftTransferTx,
  createNftUnlockCheckContractTx,
  getNftGenesisInfo,
  getNftGenesisInput,
  getNftInput,
  NftSigner,
} from "@sensible-contract/nft-js";
import { NFT_UNLOCK_CONTRACT_TYPE } from "@sensible-contract/nft-js/lib/contract-factory/nftUnlockContractCheck";
import {
  SIGNER_NUM,
  SIGNER_VERIFY_NUM,
} from "@sensible-contract/nft-js/lib/contract-proto/nft.proto";
import { InputInfo, SatotxSigner } from "@sensible-contract/sdk-core";
import {
  dummyRabinKeypairs,
  MockProvider,
  MockSatotxApi,
} from "@sensible-contract/test-utils";
import { TxComposer } from "@sensible-contract/tx-composer";
import {
  createBuyNftTx,
  createCancelSellNftTx,
  createNftSellContractTx,
  getSellInput,
} from "../src";
const signerNum = SIGNER_NUM;
const signerVerifyNum = SIGNER_VERIFY_NUM;
const satotxSigners: SatotxSigner[] = [];
for (let i = 0; i < signerNum; i++) {
  let { p, q } = dummyRabinKeypairs[i];
  let satotxSigner = new SatotxSigner();
  let mockSatotxApi = new MockSatotxApi(
    BN.fromString(p, 10),
    BN.fromString(q, 10)
  );
  satotxSigner.satotxApi = mockSatotxApi as any;
  satotxSigner.satotxPubKey = mockSatotxApi.satotxPubKey;
  satotxSigners.push(satotxSigner);
}
const signerSelecteds = new Array(signerNum)
  .fill(0)
  .map((v, idx) => idx)
  // .sort((a, b) => Math.random() - 0.5)
  .slice(0, signerVerifyNum);
let wallets: {
  privateKey: bsv.PrivateKey;
  publicKey: string;
  address: string;
}[] = [];
for (let i = 0; i < 4; i++) {
  let privateKey = new bsv.PrivateKey();
  wallets.push({
    privateKey,
    publicKey: privateKey.publicKey.toString(),
    address: privateKey.toAddress("mainnet").toString(),
  });
}
function signSigHashList(txHex: string, sigHashList: InputInfo[]) {
  const tx = new bsv.Transaction(txHex);
  let sigList = sigHashList.map((v) => {
    let privateKey = wallets.find(
      (w) => w.address.toString() == v.address
    ).privateKey;
    let sighash = bsv.Transaction.Sighash.sighash(
      tx,
      v.sighashType,
      v.inputIndex,
      new bsv.Script(v.scriptHex),
      new bsv.crypto.BN(v.satoshis)
    ).toString("hex");

    var sig = bsv.crypto.ECDSA.sign(
      Buffer.from(sighash, "hex"),
      privateKey,
      "little"
    )
      .set({
        nhashtype: v.sighashType,
      })
      .toString();
    return {
      sig,
      publicKey: privateKey.toPublicKey().toString(),
    };
  });
  return sigList;
}

let [FeePayer, CoffeeShop, Alice, Bob] = wallets;
// console.log(`
// FeePayer:   ${FeePayer.address.toString()}
// CoffeeShop: ${CoffeeShop.address.toString()}
// Alice:      ${Alice.address.toString()}
// Bob:        ${Bob.address.toString()}
// `);

let mockProvider = new MockProvider();
async function genDummyFeeUtxos(satoshis: number, count: number = 1) {
  let feeTx = new bsv.Transaction();
  let unitSatoshis = Math.ceil(satoshis / count);
  let satoshisArray = [];

  for (let i = 0; i < count; i++) {
    if (satoshis < unitSatoshis) {
      satoshisArray.push(satoshis);
    } else {
      satoshisArray.push(unitSatoshis);
    }
    satoshis -= unitSatoshis;
  }
  for (let i = 0; i < count; i++) {
    feeTx.addOutput(
      new bsv.Transaction.Output({
        script: bsv.Script.buildPublicKeyHashOut(FeePayer.address),
        satoshis: satoshisArray[i],
      })
    );
  }
  let utxos = [];
  for (let i = 0; i < count; i++) {
    utxos.push({
      txId: feeTx.id,
      outputIndex: i,
      satoshis: satoshisArray[i],
      address: FeePayer.address.toString(),
    });
  }
  await mockProvider.broadcast(feeTx.serialize(true));
  return utxos;
}
function cleanBsvUtxos() {
  mockProvider.cleanBsvUtxos();
}

describe("Nft Test", () => {
  describe("basic test ", () => {
    let provider: MockProvider;
    let nftSigner: NftSigner;
    let codehash: string;
    let genesis: string;
    let sensibleId: string;
    let opreturnData = "";
    let g_nftSellContract: any;
    let g_nftInput: any;
    before(async () => {
      provider = mockProvider;

      nftSigner = new NftSigner({
        signerSelecteds,
        signerConfigs: satotxSigners.map((v) => ({
          satotxApiPrefix: "",
          satotxPubKey: v.satotxPubKey.toString("hex"),
        })),
      });
      nftSigner.signers = satotxSigners;
      provider.cleanCacheds();
    });

    afterEach(() => {});
    it("genesis Nft should be ok", async () => {
      let utxos = await genDummyFeeUtxos(100000001);
      let { txComposer } = await createNftGenesisTx({
        nftSigner,
        genesisPublicKey: CoffeeShop.publicKey,
        totalSupply: "3",
        utxos,
      });
      let sigResults = signSigHashList(
        txComposer.getRawHex(),
        txComposer.getInputInfos()
      );
      txComposer.unlock(sigResults);
      let _res = getNftGenesisInfo(nftSigner, txComposer.getRawHex());
      await provider.broadcast(txComposer.getRawHex());
      // Utils.dumpTx(_res.tx);
      genesis = _res.genesis;
      codehash = _res.codehash;
      sensibleId = _res.sensibleId;
    });
    it("mint Nft should be ok", async () => {
      let { genesisInput, genesisContract } = await getNftGenesisInput(
        provider,
        {
          codehash,
          genesis,
          sensibleId,
        }
      );

      let utxoMaxCount = 3;
      let fee1 = createNftMetaDataTx.estimateFee({
        metaData: { name: "pig", description: "", image: "" },
        utxoMaxCount,
      });
      let fee2 = createNftMintTx.estimateFee({
        genesisInput,
        utxoMaxCount: 1,
      });
      let utxos = await genDummyFeeUtxos(fee1 + fee2, utxoMaxCount);

      let nftMetaDataRet = await createNftMetaDataTx({
        utxos,
        metaData: { name: "pig", description: "", image: "" },
      });
      nftMetaDataRet.txComposer.unlock(
        signSigHashList(
          nftMetaDataRet.txComposer.getRawHex(),
          nftMetaDataRet.txComposer.getInputInfos()
        )
      );

      utxos = [nftMetaDataRet.txComposer.getChangeUtxo()];

      let { txComposer } = await createNftMintTx({
        nftSigner,
        genesisInput,
        genesisContract,
        receiverAddress: CoffeeShop.address.toString(),
        metaTxId: nftMetaDataRet.txComposer.getTxId(),
        metaOutputIndex: 0,
        utxos,
      });
      let sigResults = signSigHashList(
        txComposer.getRawHex(),
        txComposer.getInputInfos()
      );
      txComposer.unlock(sigResults);

      await provider.broadcast(nftMetaDataRet.txComposer.getRawHex());
      await provider.broadcast(txComposer.getRawHex());
    });
    it("sell Nft should be ok", async () => {
      // cleanBsvUtxos();
      let utxoMaxCount = 3;

      let _res = await provider.getNftUtxoDetail(codehash, genesis, "0");
      let nftUtxo = _res as any;
      let nftInput = await getNftInput(provider, {
        codehash,
        genesis,
        nftUtxo,
      });
      g_nftInput = nftInput;

      let fee1 = createNftSellContractTx.estimateFee({ utxoMaxCount });
      let fee2 = createNftTransferTx.estimateFee({ nftInput, utxoMaxCount: 1 });
      let fee = fee1 + fee2;
      let utxos = await genDummyFeeUtxos(fee, utxoMaxCount);

      let nftSellRet = await createNftSellContractTx({
        nftInput,
        satoshisPrice: 10000,
        utxos,
        opreturnData,
      });
      nftSellRet.txComposer.unlock(
        signSigHashList(
          nftSellRet.txComposer.getRawHex(),
          nftSellRet.txComposer.getInputInfos()
        )
      );
      g_nftSellContract = nftSellRet.nftSellContract;
      utxos = [nftSellRet.txComposer.getChangeUtxo()];

      let { txComposer } = await createNftTransferTx({
        nftSigner,
        nftInput,
        receiverAddress: nftSellRet.sellAddress,
        utxos,
      });
      let sigResults = signSigHashList(
        txComposer.getRawHex(),
        txComposer.getInputInfos()
      );
      txComposer.unlock(sigResults);

      await provider.broadcast(nftSellRet.txComposer.getRawHex());
      await provider.broadcast(txComposer.getRawHex());
    });

    it.skip("cancel sell should be ok", async () => {
      // cleanBsvUtxos();
      let utxoMaxCount = 3;

      let _res = await provider.getNftUtxoDetail(codehash, genesis, "0");
      let nftUtxo = _res as any;
      let nftInput = await getNftInput(provider, {
        codehash,
        genesis,
        nftUtxo,
      });

      let tokenIndex = "0";
      let sellUtxo = (
        await provider.getNftSellUtxoDetail(codehash, genesis, tokenIndex, {
          ready: true,
        })
      ).map((v) => ({
        txId: v.txid,
        outputIndex: v.vout,
        sellerAddress: v.address,
        satoshisPrice: v.price,
      }))[0];

      let { sellInput, nftSellContract } = await getSellInput(provider, {
        codehash,
        genesis,
        tokenIndex,
        sellUtxo,
      });

      let nftUnlockType = NFT_UNLOCK_CONTRACT_TYPE.OUT_6;

      let fee1 = createNftUnlockCheckContractTx.estimateFee({
        nftUnlockType,
        utxoMaxCount,
      });
      let fee2 = createCancelSellNftTx.estimateFee({
        nftInput,
        utxoMaxCount: 1,
      });
      let fee = fee1 + fee2;

      let utxos = await genDummyFeeUtxos(fee, utxoMaxCount);

      let nftSellTxComposer = new TxComposer(
        new bsv.Transaction(sellInput.txHex)
      );
      let unlockCheckRet = await createNftUnlockCheckContractTx({
        nftUnlockType,
        codehash,
        nftID: nftInput.nftID,
        utxos,
      });

      unlockCheckRet.txComposer.unlock(
        signSigHashList(
          unlockCheckRet.txComposer.getRawHex(),
          unlockCheckRet.txComposer.getInputInfos()
        )
      );

      utxos = [unlockCheckRet.txComposer.getChangeUtxo()];

      let { txComposer } = await createCancelSellNftTx({
        nftSigner,
        nftInput,
        nftSellContract,
        nftSellTxComposer,
        nftUnlockCheckContract: unlockCheckRet.unlockCheckContract,
        nftUnlockCheckTxComposer: unlockCheckRet.txComposer,
        utxos,
        opreturnData,
      });

      txComposer.unlock(
        signSigHashList(txComposer.getRawHex(), txComposer.getInputInfos())
      );

      txComposer.checkFeeRate();

      await provider.broadcast(unlockCheckRet.txComposer.getRawHex());
      await provider.broadcast(txComposer.getRawHex());
    });

    it("buy nft should be ok", async () => {
      // cleanBsvUtxos();
      let utxoMaxCount = 3;

      let _res = await provider.getNftUtxoDetail(codehash, genesis, "0");
      let nftUtxo = _res as any;
      let nftInput = await getNftInput(provider, {
        codehash,
        genesis,
        nftUtxo,
      });

      let tokenIndex = "0";
      let sellUtxo = (
        await provider.getNftSellUtxoDetail(codehash, genesis, tokenIndex, {
          ready: true,
        })
      ).map((v) => ({
        txId: v.txid,
        outputIndex: v.vout,
        sellerAddress: v.address,
        satoshisPrice: v.price,
      }))[0];

      let { sellInput, nftSellContract } = await getSellInput(provider, {
        codehash,
        genesis,
        tokenIndex,
        sellUtxo,
      });

      let nftUnlockType = NFT_UNLOCK_CONTRACT_TYPE.OUT_6;

      let fee1 = createNftUnlockCheckContractTx.estimateFee({
        nftUnlockType,
        utxoMaxCount,
      });
      let fee2 = createBuyNftTx.estimateFee({
        nftInput,
        sellInput,
        utxoMaxCount: 1,
      });
      let fee = fee1 + fee2;

      let utxos = await genDummyFeeUtxos(fee, utxoMaxCount);

      let nftSellTxComposer = new TxComposer(
        new bsv.Transaction(sellInput.txHex)
      );

      let unlockCheckRet = await createNftUnlockCheckContractTx({
        nftUnlockType,
        codehash,
        nftID: nftInput.nftID,
        utxos,
      });

      unlockCheckRet.txComposer.unlock(
        signSigHashList(
          unlockCheckRet.txComposer.getRawHex(),
          unlockCheckRet.txComposer.getInputInfos()
        )
      );
      utxos = [unlockCheckRet.txComposer.getChangeUtxo()];

      let { txComposer } = await createBuyNftTx({
        nftSigner,
        nftInput,
        nftSellContract,
        nftSellTxComposer,
        nftUnlockCheckContract: unlockCheckRet.unlockCheckContract,
        nftUnlockCheckTxComposer: unlockCheckRet.txComposer,
        utxos,
        opreturnData,
      });

      txComposer.unlock(
        signSigHashList(txComposer.getRawHex(), txComposer.getInputInfos())
      );

      txComposer.checkFeeRate();

      await provider.broadcast(unlockCheckRet.txComposer.getRawHex());
      await provider.broadcast(txComposer.getRawHex());
    });
  });
});
