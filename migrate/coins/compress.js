/*!
 * compress.js - coin compressor for bcoin
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

/**
 * @module coins/compress
 * @ignore
 */

const assert = require('assert');
const secp256k1 = require('../../lib/crypto/secp256k1');
const encoding = require('../../lib/utils/encoding');
const consensus = require('../../lib/protocol/consensus');

/*
 * Constants
 */

const COMPRESS_TYPES = 10; // Space for 4 extra.
const EMPTY_BUFFER = Buffer.alloc(0);

/**
 * Compress a script, write directly to the buffer.
 * @param {Script} script
 * @param {BufferWriter} bw
 */

function compressScript(script, bw) {
  let data;

  // Attempt to compress the output scripts.
  // We can _only_ ever compress them if
  // they are serialized as minimaldata, as
  // we need to recreate them when we read
  // them.

  // P2PKH -> 0 | key-hash
  // Saves 5 bytes.
  if (script.isPubkeyhash(true)) {
    data = script.code[2].data;
    bw.writeU8(0);
    bw.writeBytes(data);
    return bw;
  }

  // P2SH -> 1 | script-hash
  // Saves 3 bytes.
  if (script.isScripthash()) {
    data = script.code[1].data;
    bw.writeU8(1);
    bw.writeBytes(data);
    return bw;
  }

  // P2PK -> 2-5 | compressed-key
  // Only works if the key is valid.
  // Saves up to 35 bytes.
  if (script.isPubkey(true)) {
    data = script.code[0].data;
    if (publicKeyVerify(data)) {
      data = compressKey(data);
      bw.writeBytes(data);
      return bw;
    }
  }

  // Raw -> varlen + 10 | script
  bw.writeVarint(script.raw.length + COMPRESS_TYPES);
  bw.writeBytes(script.raw);

  return bw;
}

/**
 * Decompress a script from buffer reader.
 * @param {Script} script
 * @param {BufferReader} br
 */

function decompressScript(script, br) {
  let size, data;

  // Decompress the script.
  switch (br.readU8()) {
    case 0:
      data = br.readBytes(20, true);
      script.fromPubkeyhash(data);
      break;
    case 1:
      data = br.readBytes(20, true);
      script.fromScripthash(data);
      break;
    case 2:
    case 3:
    case 4:
    case 5:
      br.offset -= 1;
      data = br.readBytes(33, true);
      // Decompress the key. If this fails,
      // we have database corruption!
      data = decompressKey(data);
      script.fromPubkey(data);
      break;
    default:
      br.offset -= 1;
      size = br.readVarint() - COMPRESS_TYPES;
      if (size > consensus.MAX_SCRIPT_SIZE) {
        // This violates consensus rules.
        // We don't need to read it.
        script.fromNulldata(EMPTY_BUFFER);
        br.seek(size);
      } else {
        data = br.readBytes(size);
        script.fromRaw(data);
      }
      break;
  }

  return script;
}

/**
 * Calculate script size.
 * @returns {Number}
 */

function sizeScript(script) {
  let size, data;

  if (script.isPubkeyhash(true))
    return 21;

  if (script.isScripthash())
    return 21;

  if (script.isPubkey(true)) {
    data = script.code[0].data;
    if (publicKeyVerify(data))
      return 33;
  }

  size = 0;
  size += encoding.sizeVarint(script.raw.length + COMPRESS_TYPES);
  size += script.raw.length;

  return size;
}

/**
 * Compress an output.
 * @param {Output} output
 * @param {BufferWriter} bw
 */

function compressOutput(output, bw) {
  bw.writeVarint(output.value);
  compressScript(output.script, bw);
  return bw;
}

/**
 * Decompress a script from buffer reader.
 * @param {Output} output
 * @param {BufferReader} br
 */

function decompressOutput(output, br) {
  output.value = br.readVarint();
  decompressScript(output.script, br);
  return output;
}

/**
 * Calculate output size.
 * @returns {Number}
 */

function sizeOutput(output) {
  let size = 0;
  size += encoding.sizeVarint(output.value);
  size += sizeScript(output.script);
  return size;
}

/**
 * Compress an output.
 * @param {Coin} coin
 * @param {BufferWriter} bw
 */

function compressCoin(coin, bw) {
  bw.writeVarint(coin.value);
  compressScript(coin.script, bw);
  return bw;
}

/**
 * Decompress a script from buffer reader.
 * @param {Coin} coin
 * @param {BufferReader} br
 */

function decompressCoin(coin, br) {
  coin.value = br.readVarint();
  decompressScript(coin.script, br);
  return coin;
}

/**
 * Skip past a compressed output.
 * @param {BufferWriter} bw
 * @returns {Number}
 */

function skipOutput(br) {
  let start = br.offset;

  // Skip past the value.
  br.skipVarint();

  // Skip past the compressed scripts.
  switch (br.readU8()) {
    case 0:
    case 1:
      br.seek(20);
      break;
    case 2:
    case 3:
    case 4:
    case 5:
      br.seek(32);
      break;
    default:
      br.offset -= 1;
      br.seek(br.readVarint() - COMPRESS_TYPES);
      break;
  }

  return br.offset - start;
}

/**
 * Compress value using an exponent. Takes advantage of
 * the fact that many bitcoin values are divisible by 10.
 * @see https://github.com/btcsuite/btcd/blob/master/blockchain/compress.go
 * @param {Amount} value
 * @returns {Number}
 */

function compressValue(value) {
  let exp, last;

  if (value === 0)
    return 0;

  exp = 0;
  while (value % 10 === 0 && exp < 9) {
    value /= 10;
    exp++;
  }

  if (exp < 9) {
    last = value % 10;
    value = (value - last) / 10;
    return 1 + 10 * (9 * value + last - 1) + exp;
  }

  return 10 + 10 * (value - 1);
}

/**
 * Decompress value.
 * @param {Number} value - Compressed value.
 * @returns {Amount} value
 */

function decompressValue(value) {
  let exp, n, last;

  if (value === 0)
    return 0;

  value--;

  exp = value % 10;
  value = (value - exp) / 10;

  if (exp < 9) {
    last = value % 9;
    value = (value - last) / 9;
    n = value * 10 + last + 1;
  } else {
    n = value + 1;
  }

  while (exp > 0) {
    n *= 10;
    exp--;
  }

  return n;
}

/**
 * Verify a public key (no hybrid keys allowed).
 * @param {Buffer} key
 * @returns {Boolean}
 */

function publicKeyVerify(key) {
  if (key.length === 0)
    return false;

  switch (key[0]) {
    case 0x02:
    case 0x03:
      return key.length === 33;
    case 0x04:
      if (key.length !== 65)
        return false;

      return secp256k1.publicKeyVerify(key);
    default:
      return false;
  }
}

/**
 * Compress a public key to coins compression format.
 * @param {Buffer} key
 * @returns {Buffer}
 */

function compressKey(key) {
  let out;

  switch (key[0]) {
    case 0x02:
    case 0x03:
      // Key is already compressed.
      out = key;
      break;
    case 0x04:
      // Compress the key normally.
      out = secp256k1.publicKeyConvert(key, true);
      // Store the oddness.
      // Pseudo-hybrid format.
      out[0] = 0x04 | (key[64] & 0x01);
      break;
    default:
      throw new Error('Bad point format.');
  }

  assert(out.length === 33);

  return out;
}

/**
 * Decompress a public key from the coins compression format.
 * @param {Buffer} key
 * @returns {Buffer}
 */

function decompressKey(key) {
  let format = key[0];
  let out;

  assert(key.length === 33);

  switch (format) {
    case 0x02:
    case 0x03:
      return key;
    case 0x04:
      key[0] = 0x02;
      break;
    case 0x05:
      key[0] = 0x03;
      break;
    default:
      throw new Error('Bad point format.');
  }

  // Decompress the key.
  out = secp256k1.publicKeyConvert(key, false);

  // Reset the first byte so as not to
  // mutate the original buffer.
  key[0] = format;

  return out;
}

/*
 * Expose
 */

exports.compress = {
  output: compressOutput,
  coin: compressCoin,
  size: sizeOutput,
  script: compressScript,
  value: compressValue,
  key: compressKey
};

exports.decompress = {
  output: decompressOutput,
  coin: decompressCoin,
  skip: skipOutput,
  script: decompressScript,
  value: decompressValue,
  key: decompressKey
};
