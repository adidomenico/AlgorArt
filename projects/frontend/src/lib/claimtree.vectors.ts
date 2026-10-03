/**
 * Committed claim-tree test vectors — DO NOT EDIT. Regenerate with:
 * `python3 scripts/generate-claimtree-vectors.py` (from projects/frontend).
 *
 * Each step drives docs/claim-tree-protocol-reference.py through a fixed pledge/null scenario. `backerAddress`
 * is the Algorand address of `backerPubkey` (checksum-validated by the spec); amounts/raised are decimal strings
 * so they survive JSON without precision loss. `frontier` is the pre-append frontier the pledge call takes;
 * `path` is the pre-null path the refund call takes.
 */
export interface ClaimTreeVectorExpect {
  n: number
  root: string
  raised: string
}
export interface ClaimTreeVectorAppendStep {
  op: 'append'
  backerPubkey: string
  backerAddress: string
  amount: string
  txid: string
  expect: ClaimTreeVectorExpect
  frontier: string[]
}
export interface ClaimTreeVectorNullStep {
  op: 'null'
  k: number
  amount: string
  path: { siblings: string[]; top: string | null; lower: string[] }
  expect: ClaimTreeVectorExpect
}
export type ClaimTreeVectorStep = ClaimTreeVectorAppendStep | ClaimTreeVectorNullStep
export interface ClaimTreeVectorMeta {
  hash: string
  generator: string
  leaf: string
}
export const CLAIM_TREE_VECTORS: { meta: ClaimTreeVectorMeta; steps: ClaimTreeVectorStep[] } = {
  meta: {
    hash: 'sha512_256',
    generator: 'scripts/generate-claimtree-vectors.py (deterministic seeds, no randomness)',
    leaf: 'H(0x01 \u2016 backer \u2016 amount-be64 \u2016 txid)',
  },
  steps: [
    {
      op: 'append',
      backerPubkey: 'a0ba2b0876d1b9f01080216f05340e1ee52104a2843b1f4ed288efc613b9ac3f',
      backerAddress: 'UC5CWCDW2G47AEEAEFXQKNAOD3SSCBFCQQ5R6TWSRDX4ME5ZVQ7QFHJUWE',
      amount: '3000000',
      txid: '0728e22dd0f3dcd0991511740b1193cd84c34b98feecadc6487678ac9d255ab7',
      expect: {
        n: 1,
        root: 'd75e9467ab3256dca9a18551a7383242bd0dc206913d9ddfafd70aae13a3758a',
        raised: '3000000',
      },
      frontier: [],
    },
    {
      op: 'append',
      backerPubkey: '4d5e2cc7a10a8b29d4863110a3930844a496fa6861cdf181f4956a1a4397025e',
      backerAddress: 'JVPCZR5BBKFSTVEGGEIKHEYIISSJN6TIMHG7DAPUSVVBUQ4XAJPDI7B66E',
      amount: '1000000',
      txid: '01b0f0757b8392e8f94b8757a3c9326295b2e15caa7309ea981acd48af39c290',
      expect: {
        n: 2,
        root: 'f8edd58d7aef28c162957f37369790b50be0f673bb790a4d7584f3660d49e52e',
        raised: '4000000',
      },
      frontier: ['d75e9467ab3256dca9a18551a7383242bd0dc206913d9ddfafd70aae13a3758a'],
    },
    {
      op: 'append',
      backerPubkey: 'a0ba2b0876d1b9f01080216f05340e1ee52104a2843b1f4ed288efc613b9ac3f',
      backerAddress: 'UC5CWCDW2G47AEEAEFXQKNAOD3SSCBFCQQ5R6TWSRDX4ME5ZVQ7QFHJUWE',
      amount: '2000000',
      txid: '4e175faf128685d254e0e4073c579a6b18fe54c66d7b66249633f1aa4887bdec',
      expect: {
        n: 3,
        root: '37f944b51ce9c0b62ac4e2421d7eefbfad2a2a7beca01d1fe4cad697229c962c',
        raised: '6000000',
      },
      frontier: ['f8edd58d7aef28c162957f37369790b50be0f673bb790a4d7584f3660d49e52e'],
    },
    {
      op: 'append',
      backerPubkey: '4712135f269a590ca9db772fd39ef3e271db137a09ff223d8e1a79dc15131231',
      backerAddress: 'I4JBGXZGTJMQZKO3O4X5HHXT4JY5WE32BH7SEPMODJ45YFITCIYR2F2S3Y',
      amount: '1000000',
      txid: '37536372e367e0c6f3ff7dab6de88254a052e869dec1f1e1d7b6101231afeab4',
      expect: {
        n: 4,
        root: 'a6ad2e4ca5504054ba93c6005094ab764d455dd24204618041f334ee79c8a503',
        raised: '7000000',
      },
      frontier: [
        '3740244876bd6b5fb11fcf080a470f0f995eb719f5ff1db5837612a90c1eeab0',
        'f8edd58d7aef28c162957f37369790b50be0f673bb790a4d7584f3660d49e52e',
      ],
    },
    {
      op: 'append',
      backerPubkey: 'cbd575f13e58c5ef7cd2d8cbed9bccd0f3dd343086ab0c7d499b2e79c964abe4',
      backerAddress: 'ZPKXL4J6LDC667GS3DF63G6M2DZ52NBQQ2VQY7KJTMXHTSLEVPSCNOGZB4',
      amount: '5000000',
      txid: '3f378891f542dbb6cd0590ef2dacd8382546416cb2cb9059ef6e4b1056e56de5',
      expect: {
        n: 5,
        root: 'ca70697c41319f831e5de9189ab8c4d3742c12bd88f7da6bc4467f6f97810280',
        raised: '12000000',
      },
      frontier: ['a6ad2e4ca5504054ba93c6005094ab764d455dd24204618041f334ee79c8a503'],
    },
    {
      op: 'append',
      backerPubkey: '39908b0dd7c482b3966e8076e7c94603a127ad5a6493bb3ed78b1d9da1b24638',
      backerAddress: 'HGIIWDOXYSBLHFTOQB3OPSKGAOQSPLK2MSJ3WPWXRMOZ3INSIY4ACP5P34',
      amount: '500',
      txid: '40172f845f0d4f0deae2331fa2e5e21e109b875766fc61aa84984c014b2cb107',
      expect: {
        n: 6,
        root: '914ea4485f2f5554562b68a7e9ba459d4bd47ecbfb3b460f23f4edc58dc41f73',
        raised: '12000500',
      },
      frontier: [
        '1f718f755cb80ec2fa8896348eea96c1696035619b78e9cd3ed74aae3f6e8746',
        'a6ad2e4ca5504054ba93c6005094ab764d455dd24204618041f334ee79c8a503',
      ],
    },
    {
      op: 'append',
      backerPubkey: '9a4353fd67e0a1fe74770941c52304dc34baff71ca610326755be253e26c2f9a',
      backerAddress: 'TJBVH7LH4CQ745DXBFA4KIYE3Q2LV73RZJQQGJTVLPRFHYTMF6NJJVUXWU',
      amount: '7000000',
      txid: '728a6e46215572a6f6f8d7d0a8bb91d79015e18d93aa55ddfb7f20a1f43472c0',
      expect: {
        n: 7,
        root: '555addbaee1a53255d3d860a9649ab8adac10a7a0365358be038d51fd499b254',
        raised: '19000500',
      },
      frontier: [
        '1f070632a5f79d42a10069a658c04b3b2788abdec620b4829dee529a1a5b775e',
        'a6ad2e4ca5504054ba93c6005094ab764d455dd24204618041f334ee79c8a503',
      ],
    },
    {
      op: 'append',
      backerPubkey: '877a929266f51e3cd5a04b6ac1bdbc85e8737d4e4f57124e0e4def287ecda73b',
      backerAddress: 'Q55JFETG6UPDZVNAJNVMDPN4QXUHG7KOJ5LRETQOJXXSQ7WNU45WVUNW2Y',
      amount: '250000',
      txid: 'c9cf0222d08543ec8c680661030c73d85db1a11ad28480f2b0128bb691ebe9a6',
      expect: {
        n: 8,
        root: 'b5b66a6b4037cda637c4f15c5dbe0365a8e90e9d95356046bd7120b92c8bfc75',
        raised: '19250500',
      },
      frontier: [
        '29ab362278c0346ac1c02df2a3392a67418e43c24272bc9174dc9409a634054e',
        '1f070632a5f79d42a10069a658c04b3b2788abdec620b4829dee529a1a5b775e',
        'a6ad2e4ca5504054ba93c6005094ab764d455dd24204618041f334ee79c8a503',
      ],
    },
    {
      op: 'null',
      k: 5,
      amount: '500',
      path: {
        siblings: [
          '1f718f755cb80ec2fa8896348eea96c1696035619b78e9cd3ed74aae3f6e8746',
          'ce7e2d33df646601c417bab5c1c9507f651a60c0e1dc0e40343f6b442b515293',
          'a6ad2e4ca5504054ba93c6005094ab764d455dd24204618041f334ee79c8a503',
        ],
        top: null,
        lower: [],
      },
      expect: {
        n: 8,
        root: 'b584d0070ccb8ed0585821427c139aba5463154ddb049cf61f53b7767ff0128b',
        raised: '19250000',
      },
    },
    {
      op: 'null',
      k: 0,
      amount: '3000000',
      path: {
        siblings: [
          'd37ed5b849f1461012ed1d1485f5b0f00e6c496794a173a379e52a18286a26b4',
          'd6ebd44de62b3059a70eedb8bba3d64c95e38b7201f05374a392d315c84b3adb',
          '6dd9fb7117b4956b01e50d1cceffd918989fb9e406a72e7e063a69dbd983cb38',
        ],
        top: null,
        lower: [],
      },
      expect: {
        n: 8,
        root: '90070eae6cd67fd5d871b36b0a89204913827ab4ca6af2c9d9ada208ae7c1f6e',
        raised: '16250000',
      },
    },
    {
      op: 'null',
      k: 7,
      amount: '250000',
      path: {
        siblings: [
          '29ab362278c0346ac1c02df2a3392a67418e43c24272bc9174dc9409a634054e',
          'af01420b993a7e88f807020e3ae9b8af6f8f833e037c808e65bc8ad43125e95d',
          '7c1151c09b2f64b207244b02c253543bc31d81f51aa2907f7e20b7cba3777a42',
        ],
        top: null,
        lower: [],
      },
      expect: {
        n: 8,
        root: '5ba9bf94cff62948423233f2b00f846e6acb332d2b2b0541ac3663b01a39edc7',
        raised: '16000000',
      },
    },
    {
      op: 'null',
      k: 3,
      amount: '1000000',
      path: {
        siblings: [
          '3740244876bd6b5fb11fcf080a470f0f995eb719f5ff1db5837612a90c1eeab0',
          '161e448ce68b7de60deaef93984d2b8b610bfae9c50d8b8b9b68624394fbfde5',
          'e8f09a66b1839cc8dd467aecbb2a336ab9dd039c754ecb5c6814b1c1fcca103b',
        ],
        top: null,
        lower: [],
      },
      expect: {
        n: 8,
        root: '19e41f3476c6fe2f8e99bd76f81dd11810545357755b5970c14e57885d6c2be5',
        raised: '15000000',
      },
    },
    {
      op: 'append',
      backerPubkey: 'fff665c8db08e1ceb59e39ed6f05800f27fe0b32aff4352de67fb47d9e4fa34e',
      backerAddress: '773GLSG3BDQ45NM6HHWW6BMAB4T74CZSV72DKLPGP62H3HSPUNHFJOBH3E',
      amount: '1000000',
      txid: '93676cfc5e7dcf0dfbd503dd2c13f8bca29a7de543bc7755de6fe0dc895a563b',
      expect: {
        n: 9,
        root: '891c7682d5b9dfdac737060ab005b42fa5af4b207ea4b61383fe87ac3d2b8441',
        raised: '16000000',
      },
      frontier: ['19e41f3476c6fe2f8e99bd76f81dd11810545357755b5970c14e57885d6c2be5'],
    },
    {
      op: 'append',
      backerPubkey: '9298efa85dab71e9701eb0e28220f0c6a83d5a3115cbb8d2f239c082e3e2f7e9',
      backerAddress: 'SKMO7KC5VNY6S4A6WDRIEIHQY2UD2WRRCXF3RUXSHHAIFY7C67U2MCGE3E',
      amount: '4000000',
      txid: '8633fb1a367f926fb15d0627ec8c9fd6c909acc1dee5eea78d4cb995c4ee8346',
      expect: {
        n: 10,
        root: 'bc8c12494c46d3a90c85322018050bd83be60231d9bc182a90f06ea815b3cf8b',
        raised: '20000000',
      },
      frontier: [
        '4c8b1c7cc925cc330cbbfb72ca5cde316b7c10c5dcf7146c85258ef7337e4165',
        '19e41f3476c6fe2f8e99bd76f81dd11810545357755b5970c14e57885d6c2be5',
      ],
    },
    {
      op: 'null',
      k: 9,
      amount: '4000000',
      path: {
        siblings: ['4c8b1c7cc925cc330cbbfb72ca5cde316b7c10c5dcf7146c85258ef7337e4165'],
        top: '19e41f3476c6fe2f8e99bd76f81dd11810545357755b5970c14e57885d6c2be5',
        lower: [],
      },
      expect: {
        n: 10,
        root: 'a9fdf32fa71638fc6ea8d4d977d115bead30e408e517992fa6a4515240ce526d',
        raised: '16000000',
      },
    },
    {
      op: 'null',
      k: 1,
      amount: '1000000',
      path: {
        siblings: [
          '0000000000000000000000000000000000000000000000000000000000000000',
          'f61a6a5526f59b7cc30a640a4ba5f93781b63dabf74c3944330c2e868c670789',
          'e8f09a66b1839cc8dd467aecbb2a336ab9dd039c754ecb5c6814b1c1fcca103b',
        ],
        top: null,
        lower: ['a2da203b620021c999a857933724529f228e58a96fc6eacdadc1da4f48e4afbf'],
      },
      expect: {
        n: 10,
        root: '193e4608f259f473669cc06062d6a296e16eb96505814c6ca09b53b7dde4ea0b',
        raised: '15000000',
      },
    },
    {
      op: 'null',
      k: 4,
      amount: '5000000',
      path: {
        siblings: [
          '0000000000000000000000000000000000000000000000000000000000000000',
          'a3bc8c16885851a95d446b986f97e7e5f99d02ee81257a9f6913a656a4fc64b2',
          '1fdee3abab2bf58624f1c8c6fc3cc8764341991b552119939f2d707a4b5b8944',
        ],
        top: null,
        lower: ['a2da203b620021c999a857933724529f228e58a96fc6eacdadc1da4f48e4afbf'],
      },
      expect: {
        n: 10,
        root: '0d1cd995379a9e51d5746b0fe769a42899af07ee1bc8b3a42e09faaf4c404ef8',
        raised: '10000000',
      },
    },
  ],
} as const
